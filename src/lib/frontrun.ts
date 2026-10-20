// v0.1.132 FRONT-RUNNERS (after CRAWLNET's "a caller's side wallets: the ones that buy seconds before a pump.fun
// callout"). WIRE hands every KOL callout (a post with a contract address, from a caller or a 10K+ account) to Redis;
// the worker keeps every buy of the last 4 minutes per coin from the firehose. A wallet that bought a coin in the 90
// seconds before it was called, on FR_MIN different callouts, knows the call is coming: a side wallet, a group-chat
// insider, a paid early buyer. Bots (30+ round trips a day) never count.
// When a front-runner buys a coin, that coin is likely about to be called: the SMART books (GRID LIVE) buy it on
// paper, and the exam decides whether the desk follows.

export const FR_WINDOW = 90_000; // a buy this long before the callout counts
export const FR_MIN = 3; // callouts front-run before a wallet is a front-runner
const BUY_KEEP = 240_000;
const MIN_SOL = 0.05;
const BUYS = new Map<string, { w: string; at: number }[]>(); // mint -> buys of the last 4 minutes
type Fr = { n: number; at: number; h: string[]; m: string[] };
const FR = new Map<string, Fr>(); // wallet -> front-run record
const SEEN = new Set<string>(); // callouts already matched (mint|handle|at)
const RECENT = new Map<string, { w: string; at: number }[]>(); // mint -> front-runner buys (last minute)
export const frStats = { callouts: 0, matched: 0, hits: 0, wallets: 0, buys: 0 };

export function frBuy(mint: string, w: string, sol: number, at: number, bot: boolean) {
  if (bot || sol < MIN_SOL) return false;
  let a = BUYS.get(mint);
  if (!a) {
    a = [];
    BUYS.set(mint, a);
    if (BUYS.size > 40_000) BUYS.delete(BUYS.keys().next().value as string);
  }
  while (a.length && at - a[0].at > BUY_KEEP) a.shift();
  if (a.length < 400) a.push({ w, at });
  const r = FR.get(w);
  if (r && r.n >= FR_MIN) {
    let b = RECENT.get(mint);
    if (!b) {
      b = [];
      RECENT.set(mint, b);
      if (RECENT.size > 10_000) RECENT.delete(RECENT.keys().next().value as string);
    }
    while (b.length && at - b[0].at > 60_000) b.shift();
    b.push({ w, at });
    frStats.buys++;
    return true;
  }
  return false;
}

/** A callout seen by WIRE: the coin, who called it, when it was posted. Returns the wallets credited. */
export function frCallout(mint: string, h: string, at: number) {
  const k = `${mint}|${h}|${Math.round(at / 1000)}`;
  if (SEEN.has(k)) return [];
  SEEN.add(k);
  if (SEEN.size > 20_000) SEEN.delete(SEEN.values().next().value as string);
  frStats.callouts++;
  const early = [...new Set((BUYS.get(mint) || []).filter((b) => b.at < at - 1000 && b.at >= at - FR_WINDOW).map((b) => b.w))];
  if (early.length) frStats.matched++;
  const out: string[] = [];
  for (const w of early.slice(0, 50)) {
    const r = FR.get(w) || { n: 0, at: 0, h: [], m: [] };
    if (r.m.includes(mint)) continue; // one credit per coin
    r.n++;
    r.at = at;
    r.m = [...r.m, mint].slice(-20);
    if (!r.h.includes(h)) r.h = [...r.h, h].slice(-10);
    FR.set(w, r);
    if (FR.size > 200_000) FR.delete(FR.keys().next().value as string);
    frStats.hits++;
    out.push(w);
  }
  return out;
}

export const isFrontRunner = (w: string) => (FR.get(w)?.n ?? 0) >= FR_MIN;
/** Front-runners that bought the coin in the last minute. */
export const frRecent = (mint: string, now = Date.now()) => [...new Set((RECENT.get(mint) || []).filter((x) => now - x.at <= 60_000).map((x) => x.w))];

export function frDump(min = 2) {
  const out: Record<string, Fr> = {};
  for (const [w, r] of FR) if (r.n >= min) out[w] = r;
  return out;
}
export function frLoad(recs: Record<string, Fr>) {
  for (const [w, r] of Object.entries(recs || {})) if (r && typeof r.n === "number" && !FR.has(w)) FR.set(w, { n: r.n, at: r.at || 0, h: r.h || [], m: r.m || [] });
}
export function frView() {
  let n = 0;
  const top: [string, Fr][] = [];
  for (const [w, r] of FR) if (r.n >= FR_MIN) (n++, top.push([w, r]));
  frStats.wallets = n;
  top.sort((a, z) => z[1].n - a[1].n);
  return { ...frStats, frontRunners: n, top: top.slice(0, 5).map(([w, r]) => ({ w: `${w.slice(0, 4)}…${w.slice(-4)}`, callouts: r.n, callers: r.h.slice(0, 3) })) };
}
export const _frReset = () => (BUYS.clear(), FR.clear(), SEEN.clear(), RECENT.clear(), Object.keys(frStats).forEach((k) => ((frStats as any)[k] = 0)));
