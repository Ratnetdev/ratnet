// v0.1.82: the FIREHOSE's latest state of every coin, so chain reads are only needed for coins the firehose has not
// seen trade. A pump.fun curve and a PumpSwap pool only change when someone trades, and the firehose (Shyft gRPC) sees
// every trade, so while it is connected:
//   - a coin it saw trade on this connection: its curve or pool comes from here (no chain read)
//   - a coin it has not seen trade: read from the chain once, kept here, valid until its next trade
//   - nothing older than 60 seconds is trusted: a quiet coin is read from the chain again (a missed message can never
//     leave a price stale for long)
// A reconnect starts a new epoch: everything from before it is read again, since trades may have been missed in the gap.
// Worker only: on Vercel the firehose never runs, so this stays empty and every read goes to the chain as before.
// No imports: solana.ts and pool.ts read it, firehose.ts writes it.

export type FcCurve = { progress: number; mcapSol: number; realSol: number; complete: boolean; priceSol: number; supply: number };
export type FcPool = { pool: string; sol: number; tok: number; px: number };
type E<T> = { v: T; at: number; ord: number; ep: number };

export const MAX_AGE_MS = 60_000;
const MAX = 60_000; // coins kept (oldest dropped first)
const CURVES = new Map<string, E<FcCurve>>();
const POOLS = new Map<string, E<FcPool>>();
const state = { ep: 0, up: false, lastAt: 0 };
export const fcStats = { curveHits: 0, curveMiss: 0, poolHits: 0, poolMiss: 0 };

/** The firehose connected (a new epoch: nothing from before the gap is trusted). */
export function fcConnected(now = Date.now()) {
  state.ep++;
  state.up = true;
  state.lastAt = now;
}
export function fcDown() {
  state.up = false;
}
/** A message arrived (the stream is alive). */
export function fcBeat(now = Date.now()) {
  state.lastAt = now;
}
/** Connected and a message in the last 30 seconds. */
export const fcLive = (now = Date.now()) => state.up && now - state.lastAt < 30_000;

function put<T>(m: Map<string, E<T>>, mint: string, v: T, ord: number, now: number) {
  const cur = m.get(mint);
  // the same epoch and a later transaction already there: keep it (gRPC can deliver a slot's transactions out of order)
  if (cur && cur.ep === state.ep && cur.ord > ord) return false;
  if (cur) m.delete(mint); // re-insert: insertion order = recency
  m.set(mint, { v, at: now, ord, ep: state.ep });
  if (m.size > MAX) m.delete(m.keys().next().value as string);
  return true;
}
/** A curve after a trade (ord = slot and position in the slot, so an older transaction never overwrites a newer one). */
export const fcCurveTrade = (mint: string, v: FcCurve, ord: number, now = Date.now()) => put(CURVES, mint, v, ord, now);
/** A canonical pool's reserves after a swap. */
export const fcPoolTrade = (mint: string, v: FcPool, ord: number, now = Date.now()) => put(POOLS, mint, v, ord, now);

/** A chain read: kept as the baseline, unless the firehose already has something newer on this connection. */
function base<T>(m: Map<string, E<T>>, mint: string, v: T, readAt: number) {
  if (!fcLive()) return;
  const cur = m.get(mint);
  if (cur && cur.ep === state.ep && cur.at >= readAt) return; // a trade landed while the read was in flight
  put(m, mint, v, -1, Date.now());
}
export const fcCurveBase = (mint: string, v: FcCurve, readAt: number) => base(CURVES, mint, v, readAt);
export const fcPoolBase = (mint: string, v: FcPool, readAt: number) => base(POOLS, mint, v, readAt);

function get<T>(m: Map<string, E<T>>, mint: string, now: number): T | null {
  if (!fcLive(now)) return null;
  const e = m.get(mint);
  if (!e || e.ep !== state.ep || now - e.at > MAX_AGE_MS) return null;
  return e.v;
}
export function fcCurve(mint: string, now = Date.now(), count = true) {
  const v = get(CURVES, mint, now);
  if (count) v ? fcStats.curveHits++ : fcStats.curveMiss++;
  return v;
}
export function fcPool(mint: string, now = Date.now(), count = true) {
  const v = get(POOLS, mint, now);
  if (count) v ? fcStats.poolHits++ : fcStats.poolMiss++;
  return v;
}
/**
 * v0.1.84: a coin's price from the firehose alone (no chain read, no stats): its curve while it is on the curve, its
 * canonical pool once it migrated. Null when the firehose has nothing current for it.
 */
export function fcPrice(mint: string, now = Date.now()): { px: number; grad: boolean } | null {
  const c = get(CURVES, mint, now);
  if (c && !c.complete && c.priceSol > 0) return { px: c.priceSol, grad: false };
  const p = get(POOLS, mint, now);
  if (p && p.px > 0) return { px: p.px, grad: true };
  return null;
}
export const fcSize = () => ({ curves: CURVES.size, pools: POOLS.size, epoch: state.ep });
/** Tests. */
export function _fcReset() {
  CURVES.clear();
  POOLS.clear();
  Object.assign(state, { ep: 0, up: false, lastAt: 0 });
  Object.assign(fcStats, { curveHits: 0, curveMiss: 0, poolHits: 0, poolMiss: 0 });
}
