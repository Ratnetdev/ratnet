// v0.1.128 EARNERS: every wallet's real trading record, from our own firehose (after CRAWLNET's "any trader's real
// record, win rate and average win vs loss"). Every pump.fun and PumpSwap trade is booked per wallet and coin: the SOL
// in, the SOL back. A round trip closes when the wallet has sold (almost) everything it bought; its result counts.
//
// An EARNER has 10+ closed round trips, made 0.5+ SOL net, wins 25%+ of them and averages 0.03+ SOL a trip. That is a
// wallet that makes money, not one whose coins happen to migrate (WALLETS' "proven" is the second kind). Only buys we
// saw open a position, so a sell of tokens bought before the worker started is ignored.
//
// Memory: wallets are kept most-recently-active first and capped; records with 3+ trips are saved to Redis and loaded
// at boot, so they keep growing across restarts.

export const MIN_BUY = 0.02; // SOL: smaller buys are not booked (dust bots)
export const MAX_SOL = 500; // v0.1.129: no single pump.fun trade is this big: a bigger amount is a misread quote
const MAX_WALLETS = 150_000;
const MAX_POS = 40;
export const EARN = { n: 10, pnl: 0.5, wr: 0.25, per: 0.03 };

type P = { tok: number; cost: number; back: number; max: number; at: number };
export type Rec = { n: number; w: number; pnl: number; gw: number; gl: number; at: number };
type Wl = { pos: Map<string, P>; r: Rec };
const WL = new Map<string, Wl>();
export const earnStats = { trades: 0, trips: 0, loaded: 0, saved: 0 };

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
function wl(w: string, at: number) {
  let x = WL.get(w);
  if (x) {
    WL.delete(w); // most recent last
    WL.set(w, x);
    return x;
  }
  x = { pos: new Map(), r: { n: 0, w: 0, pnl: 0, gw: 0, gl: 0, at } };
  WL.set(w, x);
  while (WL.size > MAX_WALLETS) {
    // the least recent wallet without a record worth keeping goes first
    const k = WL.keys().next().value as string;
    WL.delete(k);
  }
  return x;
}

export function isEarner(w: string) {
  const r = WL.get(w)?.r;
  return !!r && earnerRec(r);
}
export const earnerRec = (r: Rec) => r.n >= EARN.n && r.pnl >= EARN.pnl && r.w / r.n >= EARN.wr && r.pnl / r.n >= EARN.per;
export const earnRec = (w: string) => WL.get(w)?.r ?? null;

/** One trade from the firehose. */
export function earnTrade(t: { mint: string; user: string; isBuy: boolean; sol: number; tokens: number; at: number }) {
  if (!t.user || !(t.tokens > 0) || !(t.sol >= 0) || t.sol > MAX_SOL) return;
  earnStats.trades++;
  if (t.isBuy) {
    if (t.sol < MIN_BUY) return;
    const x = wl(t.user, t.at);
    let p = x.pos.get(t.mint);
    if (!p) {
      if (x.pos.size >= MAX_POS) x.pos.delete(x.pos.keys().next().value as string);
      p = { tok: 0, cost: 0, back: 0, max: 0, at: t.at };
      x.pos.set(t.mint, p);
    }
    p.tok += t.tokens;
    p.cost += t.sol;
    p.max = Math.max(p.max, p.tok);
    x.r.at = t.at;
    return;
  }
  const x = WL.get(t.user);
  const p = x?.pos.get(t.mint);
  if (!x || !p) return;
  p.back += t.sol;
  p.tok -= Math.min(p.tok, t.tokens);
  x.r.at = t.at;
  if (p.tok <= p.max * 0.02) {
    // round trip closed
    x.pos.delete(t.mint);
    const pnl = p.back - p.cost;
    const r = x.r;
    r.n++;
    if (pnl > 0) (r.w++, (r.gw = r4(r.gw + pnl)));
    else r.gl = r4(r.gl + pnl);
    r.pnl = r4(r.pnl + pnl);
    earnStats.trips++;
  }
}

/** Records worth keeping (3+ trips), for Redis. */
export function earnDump(min = 3) {
  const out: Record<string, Rec> = {};
  for (const [w, x] of WL) if (x.r.n >= min) out[w] = x.r;
  return out;
}
export function earnLoad(recs: Record<string, Rec>) {
  for (const [w, r] of Object.entries(recs || {})) {
    if (!r || typeof r.n !== "number" || !(Math.abs(r.pnl) <= MAX_SOL * r.n)) continue; // v0.1.129: drop misread records
    const x = WL.get(w);
    if (x && x.r.n >= r.n) continue;
    WL.set(w, { pos: x?.pos ?? new Map(), r: { n: r.n, w: r.w || 0, pnl: r.pnl || 0, gw: r.gw || 0, gl: r.gl || 0, at: r.at || 0 } });
    earnStats.loaded++;
  }
}
export function earnView(top = 10) {
  let n = 0;
  const ers: [string, Rec][] = [];
  for (const [w, x] of WL) {
    if (x.r.n >= 3) n++;
    if (earnerRec(x.r)) ers.push([w, x.r]);
  }
  ers.sort((a, z) => z[1].pnl - a[1].pnl);
  const avg = (r: Rec) => ({ trips: r.n, winRate: Math.round((r.w / r.n) * 100), pnl: r.pnl, avgWin: r.w ? r4(r.gw / r.w) : 0, avgLoss: r.n - r.w ? r4(r.gl / (r.n - r.w)) : 0 });
  return { wallets: WL.size, recorded: n, earners: ers.length, top: ers.slice(0, top).map(([w, r]) => ({ w: `${w.slice(0, 4)}…${w.slice(-4)}`, ...avg(r) })), ...earnStats };
}
export const _earnReset = () => (WL.clear(), (earnStats.trades = earnStats.trips = earnStats.loaded = earnStats.saved = 0));
