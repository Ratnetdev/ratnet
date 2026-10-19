// v0.1.128 FOMO TAP (after CRAWLNET's "all fomo trades on solana read on-chain, 7 seconds behind"). FOMO has no open
// API, but every FOMO trade is an on-chain transaction, and the app leaves the same fingerprint on all of them (an
// account it adds to every swap: its fee payer, fee wallet or router). We learn that fingerprint ourselves:
//   1. HOUND knows FOMO wallets from FOMO's leaderboard (fomoapi.io). Every firehose transaction where one of them
//      trades has its accounts counted.
//   2. An account that shows up in 50%+ of those transactions, across 5+ different FOMO wallets, and in under 3% of all
//      other pump.fun transactions (sampled), is FOMO's fingerprint. Programs and pump.fun's own accounts never count.
//   3. From then on, every firehose trade carrying the fingerprint is a FOMO trade: its wallet joins the FOMO book.
// The FOMO CROWD of a coin = the FOMO wallets that bought it in the last 60 seconds (crews count once).
// FOMO_PRINT (Railway, comma separated) sets the fingerprint by hand if it is ever known before the data finds it.

import bs58 from "bs58";

const IGNORE = new Set(
  [
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "ComputeBudget111111111111111111111111111111",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "So11111111111111111111111111111111111111112",
    "SysvarRent111111111111111111111111111111111",
    "SysvarC1ock11111111111111111111111111111111",
    "Sysvar1nstructions1111111111111111111111111",
    "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf", // pump global
    "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1", // pump event authority
    "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR", // pump AMM event authority
    "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw", // pump AMM global config
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", // pump fee program
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "jitodontfront111111111111111111111111111111",
  ].map(b58ToB64),
);
function b58ToB64(s: string) {
  try {
    return Buffer.from(bs58.decode(s)).toString("base64");
  } catch {
    return s;
  }
}
function b64ToB58(s: string) {
  try {
    return bs58.encode(Buffer.from(s, "base64"));
  } catch {
    return s;
  }
}

export const PRINT_SHARE = 0.5;
export const PRINT_WALLETS = 5;
export const PRINT_BASE = 0.03;
export const PRINT_MIN_TX = 30;
const BASE_EVERY = 25; // one transaction in 25 is counted for the baseline
const FOMO_MAX = 300_000;
const CROWD_SEC = 60;

let KNOWN = new Set<string>(); // FOMO wallets from HOUND (fomoapi.io)
const FOMO = new Map<string, number>(); // FOMO wallets (known + learned) -> last trade (ms)
let PRINT = new Set<string>(); // fingerprint accounts (base64)
let PRINT_BY: "data" | "env" | null = null;
const KEYS = new Map<string, { n: number; ws: Set<string> }>(); // in FOMO-wallet transactions
const BASE = new Map<string, number>(); // in sampled transactions
const CROWD = new Map<string, { w: string; at: number }[]>(); // mint -> FOMO buys
const NEW: string[] = []; // learned wallets not saved yet
export const fomoStats = { tx: 0, knownTx: 0, baseTx: 0, fomoTrades: 0, learned: 0, lastAt: 0 };

export function fomoSetKnown(ws: Iterable<string>) {
  KNOWN = new Set(ws);
  for (const w of KNOWN) if (!FOMO.has(w)) FOMO.set(w, 0);
}
export function fomoLoad(ws: Record<string, number>) {
  for (const [w, at] of Object.entries(ws || {})) if (!FOMO.has(w)) FOMO.set(w, Number(at) || 0);
}
export function fomoSetPrint(b58s: string[], by: "data" | "env") {
  PRINT = new Set(b58s.filter(Boolean).map(b58ToB64));
  PRINT_BY = PRINT.size ? by : null;
}
export const isFomo = (w: string) => FOMO.has(w);
// the crowd counts only once the fingerprint is known (before that it would only see the leaderboard's wallets)
export const fomoReady = () => PRINT.size > 0;

/**
 * One firehose transaction: its account keys (raw bytes, static and looked up) and the wallets that traded in it.
 * Returns the wallets that are FOMO traders.
 */
export function fomoTx(keys: Uint8Array[], users: string[], now = Date.now()): string[] {
  fomoStats.tx++;
  const known = users.filter((u) => KNOWN.has(u));
  const sample = fomoStats.tx % BASE_EVERY === 0;
  if (!PRINT.size && !known.length && !sample) return users.filter((u) => FOMO.has(u));
  const ks = [...new Set(keys.map((k) => Buffer.from(k).toString("base64")))];
  if (sample) {
    fomoStats.baseTx++;
    for (const k of ks) if (!IGNORE.has(k)) BASE.set(k, (BASE.get(k) || 0) + 1);
    if (BASE.size > 400_000) BASE.clear(), (fomoStats.baseTx = 0);
  }
  if (known.length) {
    fomoStats.knownTx++;
    for (const k of ks) {
      if (IGNORE.has(k)) continue;
      const e = KEYS.get(k) || { n: 0, ws: new Set<string>() };
      e.n++;
      if (e.ws.size < 50) for (const u of known) e.ws.add(u);
      KEYS.set(k, e);
    }
    if (KEYS.size > 200_000) KEYS.clear(), (fomoStats.knownTx = 0);
  }
  let out = users.filter((u) => FOMO.has(u));
  if (PRINT.size && ks.some((k) => PRINT.has(k))) {
    fomoStats.fomoTrades++;
    fomoStats.lastAt = now;
    out = users;
    for (const u of users) {
      if (!FOMO.has(u)) {
        if (FOMO.size >= FOMO_MAX) FOMO.delete(FOMO.keys().next().value as string);
        NEW.push(u);
        fomoStats.learned++;
      }
      FOMO.set(u, now);
    }
  }
  return out;
}

/** The fingerprint candidates the data supports (best first). */
export function fomoCandidates() {
  const n = fomoStats.knownTx;
  const b = Math.max(1, fomoStats.baseTx);
  return [...KEYS.entries()]
    .map(([k, e]) => ({ k, n: e.n, share: n ? e.n / n : 0, wallets: e.ws.size, base: (BASE.get(k) || 0) / b }))
    .filter((x) => x.wallets >= 2)
    .sort((a, z) => z.share - a.share || z.wallets - a.wallets)
    .slice(0, 8);
}
/** Every few minutes: set the fingerprint from the data (unless set by hand). */
export function fomoLearn() {
  const env = (process.env.FOMO_PRINT || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.length) {
    fomoSetPrint(env, "env");
    return [...PRINT].map(b64ToB58);
  }
  if (fomoStats.knownTx < PRINT_MIN_TX) return [];
  const ok = fomoCandidates().filter((c) => c.share >= PRINT_SHARE && c.wallets >= PRINT_WALLETS && c.base <= PRINT_BASE);
  if (ok.length) fomoSetPrint(ok.slice(0, 3).map((c) => b64ToB58(c.k)), "data");
  return ok.map((c) => b64ToB58(c.k));
}

/** A FOMO wallet bought this coin. */
export function fomoBuy(mint: string, w: string, at: number) {
  let a = CROWD.get(mint);
  if (!a) {
    a = [];
    CROWD.set(mint, a);
    if (CROWD.size > 30_000) CROWD.delete(CROWD.keys().next().value as string);
  }
  while (a.length && at - a[0].at > CROWD_SEC * 1000) a.shift();
  a.push({ w, at });
}
/** FOMO wallets that bought the coin in the last 60 seconds. null = the tap is not on yet. */
export function fomoCrowd(mint: string, now = Date.now()): string[] | null {
  if (!fomoReady()) return null;
  return [...new Set((CROWD.get(mint) || []).filter((x) => now - x.at <= CROWD_SEC * 1000).map((x) => x.w))];
}
/** What the FOMO crowd bought in the last `min` minutes: coins by distinct FOMO buyers. */
export function fomoHot(now = Date.now(), min = 60, top = 10) {
  const out: { mint: string; buyers: number }[] = [];
  for (const [mint, a] of CROWD) {
    const n = new Set(a.filter((x) => now - x.at <= min * 60_000).map((x) => x.w)).size;
    if (n) out.push({ mint, buyers: n });
  }
  return out.sort((a, z) => z.buyers - a.buyers).slice(0, top);
}
export const fomoNew = () => NEW.splice(0, NEW.length);
export function fomoView() {
  return {
    known: KNOWN.size,
    wallets: FOMO.size,
    print: [...PRINT].map(b64ToB58),
    printBy: PRINT_BY,
    candidates: fomoCandidates().map((c) => ({ account: b64ToB58(c.k), share: Math.round(c.share * 100), wallets: c.wallets, base: Math.round(c.base * 1000) / 10 })),
    ...fomoStats,
  };
}
export function _fomoReset() {
  KNOWN = new Set();
  FOMO.clear();
  PRINT = new Set();
  PRINT_BY = null;
  KEYS.clear();
  BASE.clear();
  CROWD.clear();
  NEW.length = 0;
  for (const k of Object.keys(fomoStats)) (fomoStats as any)[k] = 0;
}
