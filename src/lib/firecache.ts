// v0.1.82: the FIREHOSE's latest state of every coin, so chain reads are only needed for coins the firehose has not
// seen trade. A pump.fun curve and a PumpSwap pool only change when someone trades, and the firehose (Shyft gRPC) sees
// every trade, so while it is connected:
//   - a coin it saw trade on this connection: its curve or pool comes from here (no chain read)
//   - a coin it has not seen trade: read from the chain once, kept here, valid until its next trade
//   - a pool older than 60 seconds is read from the chain again, a curve after 10 minutes (v0.1.85, see below): a
//     missed message can never leave a price stale for long
// A reconnect starts a new epoch: everything from before it is read again, since trades may have been missed in the gap.
// Worker only: on Vercel the firehose never runs, so this stays empty and every read goes to the chain as before.
// No imports: solana.ts and pool.ts read it, firehose.ts writes it.

export type FcCurve = { progress: number; mcapSol: number; realSol: number; complete: boolean; priceSol: number; supply: number };
export type FcPool = { pool: string; sol: number; tok: number; px: number };
type E<T> = { v: T; at: number; ord: number; ep: number };

export const MAX_AGE_MS = 60_000;
/**
 * v0.1.85: a bonding curve changes only through a trade, and every trade event carries the curve's full state (all four
 * reserves). So a curve the firehose saw on this connection is exact until its next trade, however quiet the coin is.
 * The 60s rule sent every quiet coin back to the chain each pass (the rats re-read hundreds of hot and due coins every
 * few seconds: ~300K reads a day, the whole budget by early afternoon). A curve is now checked against the chain at
 * most every 10 minutes, only as a guard against a missed message. Pools keep 60s: liquidity can be added or removed
 * without a swap event.
 */
export const CURVE_MAX_AGE_MS = 10 * 60_000;
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

/**
 * A chain read: kept as the baseline, unless the firehose already has something newer on this connection.
 * v0.1.91: a chain read always replaces an entry older than the read. It used to go through put() with order -1, and
 * put() keeps an entry with a higher order: a coin the firehose had seen trade once, then went quiet past the age
 * limit, was read from the chain on every pass and never kept (post picks: ~10K reads an hour; pools: 12% saved).
 * The entry keeps its order, so the coin's next trade still replaces it.
 */
function base<T>(m: Map<string, E<T>>, mint: string, v: T, readAt: number) {
  if (!fcLive()) return;
  const cur = m.get(mint);
  if (cur && cur.ep === state.ep && cur.at >= readAt) return; // a trade landed while the read was in flight
  const now = Date.now();
  if (cur) m.delete(mint);
  m.set(mint, { v, at: now, ord: cur && cur.ep === state.ep ? cur.ord : -1, ep: state.ep });
  if (m.size > MAX) m.delete(m.keys().next().value as string);
}
export const fcCurveBase = (mint: string, v: FcCurve, readAt: number) => base(CURVES, mint, v, readAt);
export const fcPoolBase = (mint: string, v: FcPool, readAt: number) => base(POOLS, mint, v, readAt);

function get<T>(m: Map<string, E<T>>, mint: string, now: number): T | null {
  if (!fcLive(now)) return null;
  const e = m.get(mint);
  if (!e || e.ep !== state.ep || now - e.at > (m === (CURVES as unknown) ? CURVE_MAX_AGE_MS : MAX_AGE_MS)) return null;
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
// v0.1.85: coins whose canonical pool did not exist at the last chain read. The rats re-checked up to 200 finished
// curves every 4 seconds for their pool. While the firehose is up, a pool's creation is seen the moment it happens
// (fcPoolCreated clears the mark), so "no pool yet" is trusted for 30 seconds before the chain is asked again.
const NOPOOL = new Map<string, { at: number; ep: number }>();
export const NOPOOL_MS = 30_000;
export function fcNoPool(mint: string, now = Date.now()) {
  if (!fcLive(now)) return;
  NOPOOL.set(mint, { at: now, ep: state.ep });
  if (NOPOOL.size > 20_000) NOPOOL.delete(NOPOOL.keys().next().value as string);
}
export const fcPoolCreated = (mint: string) => NOPOOL.delete(mint);
export function fcNoPoolYet(mint: string, now = Date.now()) {
  const e = NOPOOL.get(mint);
  return !!e && fcLive(now) && e.ep === state.ep && now - e.at < NOPOOL_MS;
}

// v0.1.86: mints with no readable bonding curve at the last chain read. Post picks re-read every copy of a post every
// second; a copy with no curve came back empty, was never kept, and was asked again the next second (~14K reads an
// hour on 16 Oct). While the firehose is up a curve's first trade lands here (fcCurveTrade wins over this mark), so
// "no curve" is trusted for 30 seconds before the chain is asked again.
const NOCURVE = new Map<string, { at: number; ep: number }>();
export const NOCURVE_MS = 30_000;
export function fcNoCurve(mint: string, now = Date.now()) {
  if (!fcLive(now)) return;
  NOCURVE.set(mint, { at: now, ep: state.ep });
  if (NOCURVE.size > 20_000) NOCURVE.delete(NOCURVE.keys().next().value as string);
}
export function fcNoCurveYet(mint: string, now = Date.now()) {
  const e = NOCURVE.get(mint);
  return !!e && fcLive(now) && e.ep === state.ep && now - e.at < NOCURVE_MS;
}

export const fcSize = () => ({ curves: CURVES.size, pools: POOLS.size, epoch: state.ep });
/** Tests. */
export function _fcReset() {
  CURVES.clear();
  POOLS.clear();
  NOPOOL.clear();
  NOCURVE.clear();
  Object.assign(state, { ep: 0, up: false, lastAt: 0 });
  Object.assign(fcStats, { curveHits: 0, curveMiss: 0, poolHits: 0, poolMiss: 0 });
}
