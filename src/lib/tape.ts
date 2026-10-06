// TAPE: reads the actual trades on a bonding curve.
// Research (arXiv 2602.14860, 655K launches): fast SOL accumulation in few trades is the strongest predictor of graduation.
// Research (MemeTrans 2602.13480): bundle stats and early-holder concentration separate risky launches.
// Cost: one getSignaturesForAddress (up to 1000 sigs) + one batch of parsed transactions (~40) per coin.

import { ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { bondingCurvePda, conn, pmap, RPS } from "./solana";

// Jito tip accounts (a tip in the same tx marks a bundle-style buy)
const JITO = new Set([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);

export type Trade = { slot: number; t: number; w: string; sol: number; tok: number; acc: string | null; jito: boolean };

export type Insider = { w: string; acc: string; role: "dev" | "bundle" | "sniper" | "top" };

export type Tape = {
  at: number;
  n: number; // transactions on the curve (signature count, capped at 1000)
  vel: number; // transactions per minute since birth
  createSlot: number | null;
  bundleN: number; // wallets (not the dev) buying in the create slot
  bundleSol: number;
  sniperN: number; // wallets buying in the two slots after create
  uniq: number; // unique traders in the sample
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  solPerBuy: number; // capital efficiency: SOL per buy
  buyShare: number; // buys / trades in the recent sample
  top5: number; // share of early net SOL bought by the top 5 wallets
  devSold: number; // SOL the dev has taken out
  jito: number; // sampled txs that tipped Jito
  bundleShare: number; // bundle SOL / all SOL in
  early: string[]; // earliest buyer wallets (max 25), for smart-money learning
  insiders: Insider[]; // token accounts to watch while the desk holds the coin
  // FARM signals (v0.1.4): block-0 pumps that only their own wallets and volume bots ever trade
  instant?: number; // curve % reached inside the create slot + 2 slots
  organic?: number; // unique traders that are not the dev, bundle wallets or snipers
  wash?: number; // trades per trader in the sample (volume bots trade the same wallets over and over)
  sizeCv?: number; // spread of buy sizes (bots buy the same size every time; low = uniform)
  maxBuy?: number; // biggest single buy in the sample (SOL)
  maxBuyAt?: number; // when it happened
  farm?: Farm;
};

export type Farm = { farm: boolean; score: number; why: string };

/** pump.fun curve: vSol = 30 + real SOL, vTok = 30 * 1073M / vSol, sold = 1073M - vTok, progress = sold / 793.1M */
export function progressFromSol(realSol: number) {
  const vSol = 30 + Math.max(0, realSol);
  const vTok = (30 * 1073e6) / vSol;
  return Math.max(0, Math.min(100, Math.round(((1073e6 - vTok) / 793.1e6) * 10000) / 100));
}

/**
 * Farm or real? A real block-0 launch: a few wallets buy in the create slot, then organic buyers arrive.
 * A farm: block 0 takes the curve far up at once, then almost nobody but its own wallets and volume bots trades.
 * Transparent rules; the same signals also go to nano as features so it learns the pattern itself.
 */
export function farmCheck(t: Pick<Tape, "instant" | "organic" | "wash" | "sizeCv" | "bundleShare" | "uniq"> & { spb?: number; buys?: number; trades?: number }): Farm {
  const instant = t.instant ?? 0;
  const organic = t.organic ?? 0;
  const wash = t.wash ?? 1;
  const cv = t.sizeCv ?? 1;
  const why: string[] = [];
  let score = 0;
  if (instant >= 25) {
    score += Math.min(0.5, instant / 100);
    why.push(`curve ${Math.round(instant)}% in block 0-2`);
  }
  if (t.bundleShare >= 0.5) {
    score += 0.25;
    why.push(`bundle ${Math.round(t.bundleShare * 100)}% of SOL in`);
  }
  if (organic < 12) {
    score += 0.25;
    why.push(`${organic} organic traders`);
  }
  if (wash >= 3 && cv < 0.3) {
    score += 0.3;
    why.push("volume-bot trading");
  }
  // v0.2 bot rules: a coin traded by a handful of wallets, or by micro-buys, is a bot, not a launch
  const fewWallets = (t.trades ?? 0) >= 6 && t.uniq <= 3;
  const washLoop = wash >= 3 && t.uniq < 12;
  const microBuys = (t.buys ?? 0) >= 8 && (t.spb ?? 1) < 0.01; // spb here = median buy size
  if (fewWallets) {
    score += 0.5;
    why.push(`only ${t.uniq} wallet${t.uniq === 1 ? "" : "s"} trading`);
  }
  if (washLoop && !(wash >= 3 && cv < 0.3)) {
    score += 0.3;
    why.push(`${wash} trades per wallet`);
  }
  if (microBuys) {
    score += 0.4;
    why.push(`micro-buys (median ${t.spb} SOL)`);
  }
  // a big block 0 is fine when real buyers follow it
  if (organic >= 25) score -= 0.35;
  const farm = (instant >= 25 && organic < 15) || (t.bundleShare >= 0.6 && organic < 20) || (wash >= 3 && cv < 0.3 && t.uniq < 25) || fewWallets || washLoop || microBuys;
  return { farm, score: Math.max(0, Math.min(1, Math.round(score * 100) / 100)), why: farm ? why.join(", ") : "" };
}

export function parseTrade(tx: ParsedTransactionWithMeta | null, curve: string, mint: string): Trade | null {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.accountKeys;
  const ci = keys.findIndex((k) => k.pubkey.toBase58() === curve);
  if (ci < 0) return null;
  const sol = ((tx.meta.postBalances[ci] || 0) - (tx.meta.preBalances[ci] || 0)) / 1e9;
  const w = (keys.find((k) => k.signer) || keys[0]).pubkey.toBase58();
  let tok = 0;
  let acc: string | null = null;
  for (const b of tx.meta.postTokenBalances || []) {
    if (b.mint !== mint || b.owner !== w) continue;
    const pre = (tx.meta.preTokenBalances || []).find((x) => x.accountIndex === b.accountIndex);
    tok = Number(b.uiTokenAmount.uiAmount || 0) - Number(pre?.uiTokenAmount.uiAmount || 0);
    acc = keys[b.accountIndex]?.pubkey.toBase58() || null;
  }
  const jito = keys.some((k) => JITO.has(k.pubkey.toBase58()));
  return { slot: tx.slot, t: (tx.blockTime || 0) * 1000, w, sol, tok, acc, jito };
}

async function parsedMany(sigs: string[]) {
  try {
    return await conn().getParsedTransactions(sigs, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  } catch {
    return pmap(sigs, 6, (s) => conn().getParsedTransaction(s, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null));
  }
}

/** Read the tape of one launch. Returns null when nothing could be read (never throws). */
// Fewer sampled trades on a small RPC plan (Helius free = 10 calls/s); the full sample from 20/s up.
const SAMPLE = RPS >= 20 ? { early: 28, recent: 14 } : { early: 20, recent: 10 };

export async function readTape(mint: string, creator: string, createdAt: number, sample = SAMPLE): Promise<Tape | null> {
  try {
    const curve = bondingCurvePda(mint);
    const sigs = await conn().getSignaturesForAddress(new PublicKey(curve), { limit: 1000 });
    if (!sigs.length) return null;
    const ok = sigs.filter((s) => !s.err);
    const oldest = [...ok].reverse();
    const full = sigs.length < 1000; // we saw the whole history, so the oldest tx is the create
    const createSlot = full && oldest.length ? oldest[0].slot : null;
    const pick = Array.from(new Set([...oldest.slice(0, sample.early).map((s) => s.signature), ...ok.slice(0, sample.recent).map((s) => s.signature)]));
    const txs = await parsedMany(pick);
    const trades = txs.map((tx) => parseTrade(tx, curve, mint)).filter((x): x is Trade => !!x && Math.abs(x.sol) > 1e-6);
    return buildTape(trades, sigs.length, createSlot, creator, createdAt, Date.now(), sample);
  } catch {
    return null;
  }
}

/** Tape stats from a list of trades (live read or history replay). */
export function buildTape(trades: Trade[], nSigs: number, createSlot: number | null, creator: string, createdAt: number, at: number, sample = { early: 28, recent: 14 }): Tape {
  {
    trades.sort((a, b) => a.slot - b.slot || a.t - b.t);
    const earlyTrades = trades.slice(0, sample.early); // ordered oldest first

    const buys = trades.filter((t) => t.sol > 0);
    const sells = trades.filter((t) => t.sol < 0);
    const solIn = buys.reduce((a, t) => a + t.sol, 0);
    const solOut = -sells.reduce((a, t) => a + t.sol, 0);

    const bundle = createSlot != null ? buys.filter((t) => t.slot === createSlot && t.w !== creator) : [];
    const snipe = createSlot != null ? buys.filter((t) => t.slot > createSlot && t.slot <= createSlot + 2 && t.w !== creator) : [];
    const bundleW = new Set(bundle.map((t) => t.w));
    const sniperW = new Set(snipe.map((t) => t.w));
    const bundleSol = bundle.reduce((a, t) => a + t.sol, 0);

    // early concentration: net SOL per wallet in the early sample
    const net: Record<string, number> = {};
    for (const t of earlyTrades) net[t.w] = (net[t.w] || 0) + t.sol;
    const pos = Object.entries(net).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const totPos = pos.reduce((a, [, v]) => a + v, 0);
    const top5 = totPos ? pos.slice(0, 5).reduce((a, [, v]) => a + v, 0) / totPos : 0;

    const devSold = -trades.filter((t) => t.w === creator && t.sol < 0).reduce((a, t) => a + t.sol, 0);
    const recent = trades.slice(-sample.recent);
    const recentBuys = recent.filter((t) => t.sol > 0).length;

    // token accounts worth watching: dev, bundle, snipers, top early buyers
    const accOf: Record<string, string> = {};
    for (const t of trades) if (t.acc && t.tok > 0 && !accOf[t.w]) accOf[t.w] = t.acc;
    const ins: Insider[] = [];
    const add = (w: string, role: Insider["role"]) => {
      if (ins.length >= 12 || !accOf[w] || ins.some((x) => x.w === w)) return;
      ins.push({ w, acc: accOf[w], role });
    };
    add(creator, "dev");
    bundleW.forEach((w) => add(w, "bundle"));
    sniperW.forEach((w) => add(w, "sniper"));
    pos.slice(0, 5).forEach(([w]) => add(w, "top"));

    const early: string[] = [];
    for (const t of buys) {
      if (t.w === creator || early.includes(t.w)) continue;
      early.push(t.w);
      if (early.length >= 25) break;
    }
    const mins = Math.max(1, (at - createdAt) / 60_000);
    const instantSol = createSlot != null ? trades.filter((t) => t.sol > 0 && t.slot <= createSlot + 2).reduce((a, t) => a + t.sol, 0) : 0;
    const insiderW = new Set([creator, ...bundleW, ...sniperW]);
    const organic = new Set(trades.filter((t) => !insiderW.has(t.w)).map((t) => t.w)).size;
    const uniqAll = new Set(trades.map((t) => t.w)).size;
    const later = buys.filter((t) => createSlot == null || t.slot > createSlot + 2).map((t) => t.sol);
    const mean = later.length ? later.reduce((a, b) => a + b, 0) / later.length : 0;
    const sd = later.length > 1 ? Math.sqrt(later.reduce((a, b) => a + (b - mean) ** 2, 0) / (later.length - 1)) : 0;
    const f = {
      instant: progressFromSol(instantSol),
      organic,
      wash: uniqAll ? r3(trades.length / uniqAll) : 1,
      sizeCv: later.length >= 5 && mean > 0 ? r3(sd / mean) : 1,
      bundleShare: solIn ? r3(bundleSol / solIn) : 0,
      uniq: uniqAll,
    };
    // median buy size: a few big insider buys can't hide hundreds of 0.001 SOL bot buys
    const bs = buys.map((t) => t.sol).sort((a, b) => a - b);
    const med = bs.length ? bs[Math.floor(bs.length / 2)] : 0;
    const extra = { spb: r3(med * 1000) / 1000, buys: buys.length, trades: trades.length };
    return {
      ...f,
      farm: farmCheck({ ...f, ...extra }),
      maxBuy: buys.length ? r3(Math.max(...buys.map((t) => t.sol))) : 0,
      maxBuyAt: buys.length ? buys.reduce((a, t) => (t.sol > a.sol ? t : a), buys[0]).t : undefined,
      at,
      n: nSigs,
      vel: Math.round((nSigs / mins) * 10) / 10,
      createSlot,
      bundleN: bundleW.size,
      bundleSol: r3(bundleSol),
      sniperN: sniperW.size,
      uniq: new Set(trades.map((t) => t.w)).size,
      buys: buys.length,
      sells: sells.length,
      solIn: r3(solIn),
      solOut: r3(solOut),
      solPerBuy: buys.length ? r3(solIn / buys.length) : 0,
      buyShare: recent.length ? r3(recentBuys / recent.length) : 0,
      top5: r3(top5),
      devSold: r3(devSold),
      jito: trades.filter((t) => t.jito).length,
      bundleShare: solIn ? r3(bundleSol / solIn) : 0,
      early,
      insiders: ins,
    };
  }
}

export async function parsedTxs(sigs: string[]) {
  return parsedMany(sigs);
}

/** Token balances (whole tokens) of many token accounts in one call. Closed accounts read as 0. */
export async function tokenAmounts(accs: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < accs.length; i += 100) {
    const chunk = accs.slice(i, i + 100);
    const infos = await conn().getMultipleAccountsInfo(chunk.map((a) => new PublicKey(a)));
    chunk.forEach((a, j) => {
      const d = infos[j]?.data;
      out[a] = d && d.length >= 72 ? Number(Buffer.from(d).readBigUInt64LE(64)) / 1e6 : 0;
    });
  }
  return out;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
