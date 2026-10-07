// GRAPH: who is behind a launch, and which wallets keep getting in early on winners.
// Research (Meme Coin Factories, arXiv 2609.10246): creator wallets cluster by shared upstream funder; the top 1% of
// clusters make 58.6% of all coins. Dev history must be tracked per cluster, not per single wallet.
// Smart money is learned from our own dataset: wallets that bought early into coins that later bonded or hit $1M.
// Research (MadeOnSol, 1.6M KOL trades): following single wallets loses; several strong wallets together is the signal.

import { PublicKey } from "@solana/web3.js";
import { conn, parsedTx } from "./solana";
import { redis } from "./redis";

export const GK = {
  fof: "rn:g:fof", // wallet -> first funder ("~" = unknown / old wallet)
  cN: "rn:g:n", // funder -> launches resolved
  cB: "rn:g:b", // funder -> bonded
  cM: "rn:g:m", // funder -> reached $1M
  sN: "rn:sw:n", // wallet -> early entries resolved
  sB: "rn:sw:b", // wallet -> early entries that bonded
  sM: "rn:sw:m", // wallet -> early entries that reached $1M
};

/** First wallet that sent SOL to `wallet`. Fresh dev wallets have short histories, so the oldest tx is the funding tx. */
export async function funderOf(wallet: string): Promise<string | null> {
  if (!wallet) return null;
  const r = redis();
  const cached = await r.hget<string>(GK.fof, wallet);
  if (cached) return cached === "~" ? null : cached;
  let f: string | null = null;
  try {
    const sigs = await conn().getSignaturesForAddress(new PublicKey(wallet), { limit: 60 });
    if (sigs.length && sigs.length < 60) {
      const first = sigs[sigs.length - 1];
      const tx = await parsedTx(first.signature);
      const keys = tx?.transaction.message.accountKeys || [];
      const payer = keys.find((k) => k.signer)?.pubkey.toBase58();
      if (payer && payer !== wallet) f = payer;
      else if (tx?.meta) {
        // the wallet paid its own first tx: take the account that lost the most SOL
        let best = 0;
        keys.forEach((k, i) => {
          const d = (tx.meta!.postBalances[i] || 0) - (tx.meta!.preBalances[i] || 0);
          const a = k.pubkey.toBase58();
          if (a !== wallet && d < best) {
            best = d;
            f = a;
          }
        });
      }
    }
  } catch {
    return null; // do not cache RPC failures
  }
  await r.hset(GK.fof, { [wallet]: f || "~" });
  return f;
}

export type Graph = {
  funder: string | null;
  clN: number; // launches from this funder's cluster that resolved
  clB: number;
  clM: number;
  clRatio: number; // cluster bond rate / base rate (shrunk toward 1 when the cluster is small)
  smartN: number; // early buyers with a proven record
  smartMax: number; // best early buyer's bond rate / base rate
  smart: string[];
};

const K_SHRINK = 5;

/** Bayesian bond rate of a record vs a base rate, as a ratio. */
export function edge(n: number, b: number, base: number) {
  const r = (b + K_SHRINK * base) / (n + K_SHRINK);
  return base > 0 ? r / base : 1;
}

export type Tables = typeof GK;
// The historian keeps its own copy while it replays the past, so a historic launch only ever sees records from before it.
export const HGK: Tables = { fof: GK.fof, cN: "rn:h:g:n", cB: "rn:h:g:b", cM: "rn:h:g:m", sN: "rn:h:sw:n", sB: "rn:h:sw:b", sM: "rn:h:sw:m" };

export async function readGraph(creator: string, early: string[], base: number, T: Tables = GK): Promise<Graph> {
  const r = redis();
  const funder = await funderOf(creator).catch(() => null);
  const p = r.pipeline();
  p.hmget(T.cN, funder || "~");
  p.hmget(T.cB, funder || "~");
  p.hmget(T.cM, funder || "~");
  if (early.length) {
    p.hmget(T.sN, ...early);
    p.hmget(T.sB, ...early);
    p.hmget(T.sM, ...early);
  }
  const res = (await p.exec()) as any[];
  const one = (x: any) => Number((x && Object.values(x)[0]) || 0);
  const clN = funder ? one(res[0]) : 0;
  const clB = funder ? one(res[1]) : 0;
  const clM = funder ? one(res[2]) : 0;
  let smartN = 0;
  let smartMax = 0;
  const smart: string[] = [];
  if (early.length) {
    const [n, b, m] = [res[3] || {}, res[4] || {}, res[5] || {}];
    for (const w of early) {
      const wn = Number(n[w] || 0);
      const wb = Number(b[w] || 0);
      const wm = Number(m[w] || 0);
      if (wn < 2) continue;
      const e = edge(wn, wb, base);
      if ((wn >= 3 && e >= 2.5) || (wm >= 1 && wn >= 2)) {
        smartN++;
        smart.push(w);
      }
      smartMax = Math.max(smartMax, e);
    }
  }
  return { funder, clN, clB, clM, clRatio: funder ? round2(edge(clN, clB, base)) : 1, smartN, smartMax: round2(smartMax), smart: smart.slice(0, 8) };
}

type Pipe = { hincrby: (k: string, f: string, n: number) => unknown };

/** Credit the cluster and the early wallets once a taped launch resolves. */
export function creditResolve(p: Pipe, funder: string | null | undefined, early: string[] | undefined, bonded: boolean, T: Tables = GK) {
  if (funder) {
    p.hincrby(T.cN, funder, 1);
    if (bonded) p.hincrby(T.cB, funder, 1);
  }
  for (const w of early || []) {
    p.hincrby(T.sN, w, 1);
    if (bonded) p.hincrby(T.sB, w, 1);
  }
}

/** Credit the cluster and early wallets when a coin crosses $1M. */
export function creditMillion(p: Pipe, funder: string | null | undefined, early: string[] | undefined, T: Tables = GK) {
  if (funder) p.hincrby(T.cM, funder, 1);
  for (const w of early || []) p.hincrby(T.sM, w, 1);
}

/** Keep the wallet tables bounded: drop one-time wallets when the table grows large (run daily). */
export async function pruneWallets(max = 400_000) {
  const r = redis();
  const len = await r.hlen(GK.sN);
  if (len <= max) return { pruned: 0, len };
  let cursor: string | number = 0;
  let pruned = 0;
  let rounds = 0;
  do {
    const [next, items] = (await r.hscan(GK.sN, cursor, { count: 1000 })) as [string | number, (string | number)[]];
    cursor = next;
    const drop: string[] = [];
    for (let i = 0; i < items.length; i += 2) if (Number(items[i + 1]) <= 1) drop.push(String(items[i]));
    if (drop.length) {
      const p = r.pipeline();
      p.hdel(GK.sN, ...drop);
      p.hdel(GK.sB, ...drop);
      await p.exec();
      pruned += drop.length;
    }
    rounds++;
  } while (String(cursor) !== "0" && rounds < 200);
  return { pruned, len };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
