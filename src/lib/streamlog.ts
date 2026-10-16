// What the PumpPortal stream already tells the worker, kept in memory so the rats and the desk don't pay Helius for it.
//  - every launch's trades from its birth for ~7 minutes: the minute-1 and minute-5 tapes are built from these instead
//    of ~42 chain reads per coin (v0.1.28: the tape reads were ~70% of all Helius credits)
//  - the last quote of every streamed coin: the desk prices open positions from it between chain checks
// Only the worker process has a stream; anywhere else these are empty and callers read the chain as before.
export type StreamTrade = { t: number; w: string; sol: number; tok: number; buy: boolean };
// full (v0.1.54): the log is complete enough for a tape: its early trades came from the chain read at minute 1 and every
// trade since streamed from PumpPortal. Only full logs give stream tapes (a launch we never subscribed has just its dev buy)
type Log = { t0: number; creator: string; trades: StreamTrade[]; n: number; full?: boolean };
type Quote = { at: number; px: number; real: number | null; mcSol: number; curve: boolean; feed?: boolean };

const LOGS = new Map<string, Log>();
const QUOTES = new Map<string, Quote>();
export const LOG_MS = 7 * 60_000; // launches are followed this long (the minute-5 call is made by ~5m30s)
const MAX_TRADES = 3000;

/** A launch was created (the stream's create message, the dev's first buy included). */
export function logCreate(mint: string, creator: string, t0: number, devSol: number, devTok: number, fromBirth = false) {
  // v0.1.82: the FIREHOSE logs every launch from birth (usually before PumpPortal's create message lands): a later
  // create message for the same launch must not wipe that log
  const cur = LOGS.get(mint);
  if (cur?.full && Math.abs(cur.t0 - t0) <= 10_000) return;
  const trades: StreamTrade[] = devSol > 0 ? [{ t: t0, w: creator, sol: devSol, tok: devTok, buy: true }] : [];
  // fromBirth: this launch's trades are streamed from its first second, so its log is complete (v0.1.54: not the case
  // for the shortlist, which joins at minute 1)
  LOGS.set(mint, { t0, creator, trades, n: trades.length, full: fromBirth });
}

// v0.1.87: launches whose curve is quoted in another token (ZEC, PUMP...). Their trades are not in SOL, so no log, no
// tape, no call and no trade for them; the firehose marks them at the create or at their first trade.
const OTHER = new Map<string, number>();
export function noteOtherQuote(mint: string, now = Date.now()) {
  LOGS.delete(mint);
  OTHER.set(mint, now);
  if (OTHER.size > 50_000) OTHER.delete(OTHER.keys().next().value as string);
}
export const isOtherQuote = (mint: string) => OTHER.has(mint);
export const otherQuoteCount = () => OTHER.size;

let LAST_TRADE_AT = 0;
/**
 * Are trade messages arriving at all? On 7 Oct the stream delivered launches but no trades for hours, and every
 * stream tape held just the dev's buy ("1 trade, 1 trader"): the King scored launches on an empty picture. With no
 * trade message in the last minute, stream tapes are refused and the chain is read instead.
 */
export const tradesFlowing = (now = Date.now()) => now - LAST_TRADE_AT < 60_000;
export const lastTradeAgo = (now = Date.now()) => (LAST_TRADE_AT ? Math.round((now - LAST_TRADE_AT) / 1000) : null);

/** A trade on any streamed coin. */
export function logTrade(m: { mint: string; w: string; buy: boolean; sol: number; tok: number; vSol?: number; mcSol?: number; pool?: string; real?: number }) {
  const now = Date.now();
  LAST_TRADE_AT = now;
  const l = LOGS.get(m.mint);
  if (l && now - l.t0 <= LOG_MS) {
    l.n++;
    if (l.trades.length < MAX_TRADES) l.trades.push({ t: now, w: m.w, sol: m.buy ? m.sol : -m.sol, tok: m.tok, buy: m.buy });
  }
  if (m.mcSol && m.mcSol > 0) {
    const curve = !m.pool || m.pool === "pump";
    // v0.1.82: the firehose passes the curve's real SOL itself (PumpPortal only gives the virtual SOL, real = virtual - 30)
    const real = curve ? (m.real != null ? m.real : m.vSol && m.vSol > 30 ? m.vSol - 30 : 0) : null;
    QUOTES.set(m.mint, { at: now, px: m.mcSol / 1e9, real, mcSol: m.mcSol, curve });
  }
}

/**
 * v0.1.82: the FIREHOSE reconnected. Trades may have been missed in the gap, so no log from before it counts as
 * complete any more (those launches get their tape from the chain, as before).
 */
export function logsGap(now = Date.now()) {
  let n = 0;
  for (const l of LOGS.values()) if (l.full && l.t0 < now) (l.full = false), n++;
  return n;
}

/** v0.1.92: why there is no usable log for a launch (for the tape stats). */
export function streamLogWhy(mint: string, createdAt: number, now = Date.now()): "noLog" | "notFull" | "t0" | "old" {
  const l = LOGS.get(mint);
  if (!l) return now - createdAt > LOG_MS ? "old" : "noLog";
  if (!l.full) return "notFull";
  return "t0";
}
/** The launch's log, if the stream saw it from birth (within 5s of the create time the rats recorded). */
export function streamLog(mint: string, createdAt: number) {
  const l = LOGS.get(mint);
  if (!l || !l.full || Math.abs(l.t0 - createdAt) > 5_000) return null;
  return l;
}

// v0.1.54: the PumpPortal trade stream follows a shortlist, not every launch. A coin joins it when its minute-1 tape is
// read from the chain: that read seeds the log with its early trades, the worker subscribes its trades from then on, and
// the minute-5 tape is built from both without a second chain read.
let FOLLOW: ((mint: string) => boolean) | null = null;
/** The worker registers who subscribes a coin's trades (returns false when the day's cap is reached). */
export function setFollowHook(fn: ((mint: string) => boolean) | null) {
  FOLLOW = fn;
}
export function seedLog(mint: string, createdAt: number, creator: string, trades: StreamTrade[], n: number, now = Date.now()) {
  if (!FOLLOW || now - createdAt > LOG_MS - 60_000) return false;
  if (!FOLLOW(mint)) return false;
  LOGS.set(mint, { t0: createdAt, creator, trades: trades.slice().sort((a, b) => a.t - b.t).slice(0, MAX_TRADES), n: Math.max(n, trades.length), full: true });
  return true;
}

/** Mints still inside their first ~7 minutes (the worker keeps their trades subscribed). */
export function youngMints(now = Date.now()) {
  const out: string[] = [];
  for (const [m, l] of LOGS) if (now - l.t0 <= LOG_MS) out.push(m);
  return out;
}

/**
 * A price from the Helius account feed (v0.1.34): the curve or the pool vaults changed. It does not mark trades as
 * flowing (it carries no trade, so it never makes a stream tape look complete).
 */
export function setQuote(q: { mint: string; px: number; real: number; mcSol: number; curve: boolean }) {
  if (!(q.px > 0)) return;
  QUOTES.set(q.mint, { at: Date.now(), px: q.px, real: q.real, mcSol: q.mcSol, curve: q.curve, feed: true });
}

// The mints the account feed confirms it follows, refreshed by the worker every second while the socket is up. An
// account feed only speaks on a change: while it is up and following the coin, silence means the price held.
let FEED_LIVE = new Set<string>();
let FEED_LIVE_AT = 0;
export function markFeedLive(mints: Set<string>, now = Date.now()) {
  FEED_LIVE = mints;
  FEED_LIVE_AT = now;
}
export const FEED_QUOTE_MS = 60_000;

/** A fresh quote (default: at most 3s old; a feed quote on a followed account stays good up to a minute). */
export function streamQuote(mint: string, maxAgeMs = 3_000, now = Date.now()) {
  const q = QUOTES.get(mint);
  if (!q) return null;
  const age = now - q.at;
  if (age <= maxAgeMs) return q;
  if (q.feed && FEED_LIVE.has(mint) && now - FEED_LIVE_AT < 5_000 && age <= FEED_QUOTE_MS) return q;
  return null;
}

/** Drop what is no longer needed (called by the worker every few seconds). */
export function pruneStream(keep: Set<string>, now = Date.now()) {
  for (const [m, l] of LOGS) if (now - l.t0 > LOG_MS + 3 * 60_000) LOGS.delete(m);
  for (const [m, q] of QUOTES) if (!keep.has(m) && now - q.at > 120_000) QUOTES.delete(m);
}

export const streamSize = () => ({ logs: LOGS.size, quotes: QUOTES.size, lastTradeSec: lastTradeAgo() });
