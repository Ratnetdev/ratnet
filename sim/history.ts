// HISTORIAN test: a synthetic past (3 days of launches) with structure to discover, then a full replay.
// Checks: phases run end to end, lessons are learned, cluster and smart-wallet records separate good from bad,
// and no historic launch ever sees a dev bond that happened after it (leakage check).
// Run: npx tsx sim/history.ts
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MockRedis } from "./mockredis";

const NOW0 = Date.UTC(2026, 9, 6, 12, 0, 0);
let NOW = NOW0;
Date.now = () => NOW;
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let rng = 7;
const rand = () => ((rng = (rng * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pk = () => Keypair.generate().publicKey.toBase58();
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const MINT_AUTH = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

const SMART = Array.from({ length: 30 }, pk);
const FACTORY = pk(), PRO = pk(), CEX = pk();
const facDevs = Array.from({ length: 20 }, pk), proDevs = Array.from({ length: 6 }, pk);
const funder = new Map<string, string>();
facDevs.forEach((d) => funder.set(d, FACTORY));
proDevs.forEach((d) => funder.set(d, PRO));

type Tr = { sig: string; t: number; slot: number; w: string; sol: number; real: number };
type C = { i: number; mint: string; curve: string; sig: string; t: number; slot: number; creator: string; bondAt: number | null; trades: Tr[]; symbol: string; peakUsd: number };
const coins: C[] = [];
const byCurve = new Map<string, C>(), bySig = new Map<string, { c: C; tr?: Tr }>(), byMint = new Map<string, C>();
let slot = 5000;
const START = NOW0 - 3 * 86400_000;
for (let t = START; t < NOW0 - 2 * 3600_000; t += 40_000 + rand() * 40_000) {
  const k = rand();
  const creator = k < 0.3 ? facDevs[Math.floor(rand() * facDevs.length)] : k < 0.34 ? proDevs[Math.floor(rand() * proDevs.length)] : pk();
  if (!funder.has(creator)) funder.set(creator, CEX);
  const f = funder.get(creator);
  const bonds = rand() < (f === FACTORY ? 0.003 : f === PRO ? 0.25 : 0.012);
  const kp = Keypair.generate().publicKey;
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), kp.toBuffer()], PUMP);
  const c: C = { i: coins.length, mint: kp.toBase58(), curve: pda.toBase58(), sig: bs58.encode(Keypair.generate().secretKey.slice(0, 64)), t, slot: (slot += 5), creator, bondAt: bonds ? t + (3 + rand() * 50) * 60_000 : null, trades: [], symbol: `H${coins.length}`, peakUsd: bonds ? 70_000 / Math.max(0.01, rand()) : 0 };
  // trades: SOL in builds toward 85 for bonders, fizzles otherwise; smart wallets early on bonders
  let real = 0.5;
  const n = bonds ? 160 : 10 + Math.floor(rand() * 40);
  const span = bonds ? c.bondAt! - t : 20 * 60_000;
  for (let j = 0; j < n; j++) {
    const tt = t + 2000 + (span * j) / n;
    const smart = bonds && j < 6 && rand() < 0.6;
    const buy = bonds ? rand() < 0.75 : rand() < 0.55;
    const sol = buy ? (bonds ? 0.4 + rand() * 1.2 : 0.05 + rand() * 0.5) : -(0.05 + rand() * 0.4);
    real = Math.max(0, Math.min(85, real + sol));
    const tr: Tr = { sig: `h${c.i}t${j}`, t: tt, slot: c.slot + 1 + j, w: smart ? SMART[Math.floor(rand() * SMART.length)] : pk(), sol, real };
    c.trades.push(tr);
    bySig.set(tr.sig, { c, tr });
  }
  if (bonds) c.trades.push({ sig: `h${c.i}mig`, t: c.bondAt!, slot: c.slot + 999, w: pk(), sol: 0, real: 85 });
  bySig.set(c.sig, { c });
  bySig.set(`h${c.i}mig`, { c, tr: c.trades[c.trades.length - 1] });
  coins.push(c);
  byCurve.set(c.curve, c);
  byMint.set(c.mint, c);
}

const str = (s: string) => { const x = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(x.length); return Buffer.concat([l, x]); };
const page = <T extends { t: number; sig: string }>(list: T[], o: { before?: string; until?: string; limit: number }) => {
  const desc = [...list].sort((a, b) => b.t - a.t);
  let i = 0;
  if (o.before) i = desc.findIndex((x) => x.sig === o.before) + 1;
  const out: T[] = [];
  for (; i < desc.length && out.length < o.limit; i++) {
    if (desc[i].sig === o.until) break;
    out.push(desc[i]);
  }
  return out;
};
(globalThis as any).__rnConn = {
  async getSignaturesForAddress(addr: PublicKey, o: any) {
    const a = addr.toBase58();
    if (a === MINT_AUTH) return page(coins.map((c) => ({ t: c.t, sig: c.sig, slot: c.slot })), o).map((x) => ({ signature: x.sig, slot: x.slot, blockTime: Math.floor(x.t / 1000), err: null }));
    const c = byCurve.get(a);
    if (c) return page([{ t: c.t, sig: c.sig, slot: c.slot }, ...c.trades], o).map((x: any) => ({ signature: x.sig, slot: x.slot, blockTime: Math.floor(x.t / 1000), err: null }));
    return [{ signature: `fund:${a}`, slot: 1, blockTime: 1, err: null }];
  },
  async getParsedTransaction(sig: string) {
    if (sig.startsWith("fund:")) {
      const w = sig.slice(5);
      return { slot: 1, meta: { err: null, preBalances: [1e10, 0], postBalances: [9e9, 1e9] }, transaction: { message: { accountKeys: [{ pubkey: new PublicKey(funder.get(w) || CEX), signer: true }, { pubkey: new PublicKey(w), signer: false }] } } };
    }
    const e = bySig.get(sig);
    if (!e) return null;
    const c = e.c;
    if (!e.tr) {
      const data = Buffer.concat([Buffer.from([214, 144, 76, 236, 95, 1, 2, 3]), str(`Hist ${c.i}`), str(c.symbol), str(`https://meta.test/${c.mint}`), new PublicKey(c.creator).toBuffer(), Buffer.from([0])]);
      return { slot: c.slot, blockTime: Math.floor(c.t / 1000), meta: { err: null, logMessages: ["Program log: Instruction: CreateV2"], postTokenBalances: [{ mint: c.mint, owner: c.curve }], innerInstructions: [], preBalances: [6e9, 0], postBalances: [5e9, 0.5016e9] }, transaction: { message: { instructions: [{ programId: PUMP, data: bs58.encode(data) }], accountKeys: [{ pubkey: new PublicKey(c.creator), signer: true }, { pubkey: new PublicKey(c.curve), signer: false }] } } };
    }
    const tr = e.tr;
    const w = tr.w;
    return {
      slot: tr.slot,
      blockTime: Math.floor(tr.t / 1000),
      meta: { err: null, preBalances: [5e9, (tr.real - tr.sol + 0.0016) * 1e9], postBalances: [5e9 - tr.sol * 1e9, (tr.real + 0.0016) * 1e9], preTokenBalances: [], postTokenBalances: [{ accountIndex: 2, mint: c.mint, owner: w, uiTokenAmount: { uiAmount: Math.max(0, tr.sol * 3e7) } }] },
      transaction: { message: { accountKeys: [{ pubkey: new PublicKey(w), signer: true }, { pubkey: new PublicKey(c.curve), signer: false }, { pubkey: new PublicKey(pk()), signer: false }] } },
    };
  },
  async getParsedTransactions(sigs: string[]) { return Promise.all(sigs.map((s) => (globalThis as any).__rnConn.getParsedTransaction(s))); },
  async getMultipleAccountsInfo(pks: PublicKey[]) {
    return pks.map((p) => {
      const c = byCurve.get(p.toBase58());
      if (!c) return null;
      const b = Buffer.alloc(151);
      b.writeBigUInt64LE(1n, 8); b.writeBigUInt64LE(1n, 16); b.writeBigUInt64LE(1n, 24); b.writeBigUInt64LE(1n, 32); b.writeBigUInt64LE(1n, 40);
      b[48] = c.bondAt ? 1 : 0;
      return { data: b };
    });
  },
};
let gecko = 0;
(globalThis as any).fetch = async (url: string) => {
  const u = String(url);
  if (u.includes("geckoterminal")) {
    gecko++;
    const mint = /tokens\/(\w+)\/pools/.exec(u)?.[1] || /token=(\w+)/.exec(u)?.[1] || "";
    const c = byMint.get(mint);
    if (u.includes("/pools?")) return { ok: true, json: async () => ({ data: [{ attributes: { address: `pool${c?.i}` } }] }) };
    const list: number[][] = [];
    if (c?.bondAt) for (let h = 0; h < 48; h++) { const t = c.bondAt + h * 3600_000; const mc = Math.min(c.peakUsd, 69_000 * Math.pow(1.6, h)); list.push([Math.floor(t / 1000), 0, mc / 1e9, 0, 0, 0]); }
    return { ok: true, json: async () => ({ data: { attributes: { ohlcv_list: list.reverse() } } }) };
  }
  const c = byMint.get(u.split("/").pop()!);
  return { ok: true, json: async () => ({ description: c && funder.get(c.creator) === PRO ? "a real description of this coin and why it exists here and now" : "", twitter: c && funder.get(c.creator) === PRO ? "https://x.com/c" : "", telegram: "", website: "", image: "" }) };
};

async function main() {
  // the live rats started "today"
  await R.hincrby(`rn:day:${new Date(NOW0).toISOString().slice(0, 10)}`, "dug", 1);
  await R.set("rn:settings", { history: { on: true, days: 3, scanPerRun: 150, deepPerRun: 8, sample: 10, runner: true } });
  const { historianSession, getHistory } = await import("../src/lib/historian");
  const jobs: any[] = [];
  const orig = R.rpush.bind(R);
  (R as any).rpush = async (k: string, ...v: any[]) => { if (k === "rn:h:q") jobs.push(...v); return orig(k, ...v); };
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) {
    const res: any = await historianSession(45_000);
    if (res.history === "error") { console.log("ERR", res.error); break; }
    if (res.history === "done") break;
    NOW += 60_000; // a minute between cron pings
  }
  const h: any = await getHistory();
  console.log("phase", h.phase, "scanned", h.scanned, "/", coins.length, "bonded found", h.bonded, "/", coins.filter((c) => c.bondAt).length, "deep", h.deep, "runner lessons", h.runnerLessons, "gecko calls", gecko);
  console.log("backtest", h.backtest);
  const n = R.kv.get("rn:h:g:n") || {}, b = R.kv.get("rn:h:g:b") || {};
  console.log("historian clusters: FACTORY", n[FACTORY] || 0, "/", b[FACTORY] || 0, "· PRO", n[PRO] || 0, "/", b[PRO] || 0, "· CEX", n[CEX] || 0, "/", b[CEX] || 0);
  const ln = R.kv.get("rn:g:n") || {};
  console.log("live tables received:", Object.keys(ln).length, "funders");
  const sw = R.kv.get("rn:h:sw:b") || {};
  console.log("smart wallets with bonds on record:", SMART.filter((w) => Number(sw[w] || 0) > 0).length, "/", SMART.length);
  const nano: any = R.kv.get("rn:nano");
  console.log("nano n", nano?.n, "pos", nano?.pos, "loss", nano?.loss?.toFixed(3));
  // leakage: every queued job's devB must count only bonds before its createdAt
  const devBonds = new Map<string, number[]>();
  for (const c of coins) if (c.bondAt) (devBonds.get(c.creator) || devBonds.set(c.creator, []).get(c.creator)!).push(c.bondAt);
  let leaks = 0, under = 0, checked = 0;
  for (const j of jobs) {
    const truth = (devBonds.get(j.creator) || []).filter((t) => t < j.createdAt).length;
    const prior = coins.filter((c) => c.creator === j.creator && c.t < j.createdAt).length;
    checked++;
    if (j.devB > truth || j.devN > prior) leaks++;
    if (j.devB < truth) under++;
  }
  console.log("leak check:", checked, "jobs,", leaks, "saw the future,", under, "missed a past bond (credit lag, safe)");
  console.log("ms", Date.now() - t0);
}
main();
