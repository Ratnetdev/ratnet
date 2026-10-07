// What the PumpPortal stream already tells the worker, kept in memory so the rats and the desk don't pay Helius for it.
//  - every launch's trades from its birth for ~7 minutes: the minute-1 and minute-5 tapes are built from these instead
//    of ~42 chain reads per coin (v0.1.28: the tape reads were ~70% of all Helius credits)
//  - the last quote of every streamed coin: the desk prices open positions from it between chain checks
// Only the worker process has a stream; anywhere else these are empty and callers read the chain as before.
export type StreamTrade = { t: number; w: string; sol: number; tok: number; buy: boolean };
type Log = { t0: number; creator: string; trades: StreamTrade[]; n: number };
type Quote = { at: number; px: number; real: number | null; mcSol: number; curve: boolean };

const LOGS = new Map<string, Log>();
const QUOTES = new Map<string, Quote>();
export const LOG_MS = 7 * 60_000; // launches are followed this long (the minute-5 call is made by ~5m30s)
const MAX_TRADES = 3000;

/** A launch was created (the stream's create message, the dev's first buy included). */
export function logCreate(mint: string, creator: string, t0: number, devSol: number, devTok: number) {
  const trades: StreamTrade[] = devSol > 0 ? [{ t: t0, w: creator, sol: devSol, tok: devTok, buy: true }] : [];
  LOGS.set(mint, { t0, creator, trades, n: trades.length });
}

let LAST_TRADE_AT = 0;
/**
 * Are trade messages arriving at all? On 7 Oct the stream delivered launches but no trades for hours, and every
 * stream tape held just the dev's buy ("1 trade, 1 trader"): the King scored launches on an empty picture. With no
 * trade message in the last minute, stream tapes are refused and the chain is read instead.
 */
export const tradesFlowing = (now = Date.now()) => now - LAST_TRADE_AT < 60_000;
export const lastTradeAgo = (now = Date.now()) => (LAST_TRADE_AT ? Math.round((now - LAST_TRADE_AT) / 1000) : null);

/** A trade on any streamed coin. */
export function logTrade(m: { mint: string; w: string; buy: boolean; sol: number; tok: number; vSol?: number; mcSol?: number; pool?: string }) {
  const now = Date.now();
  LAST_TRADE_AT = now;
  const l = LOGS.get(m.mint);
  if (l && now - l.t0 <= LOG_MS) {
    l.n++;
    if (l.trades.length < MAX_TRADES) l.trades.push({ t: now, w: m.w, sol: m.buy ? m.sol : -m.sol, tok: m.tok, buy: m.buy });
  }
  if (m.mcSol && m.mcSol > 0) {
    const curve = !m.pool || m.pool === "pump";
    QUOTES.set(m.mint, { at: now, px: m.mcSol / 1e9, real: curve && m.vSol && m.vSol > 30 ? m.vSol - 30 : curve ? 0 : null, mcSol: m.mcSol, curve });
  }
}

/** The launch's log, if the stream saw it from birth (within 5s of the create time the rats recorded). */
export function streamLog(mint: string, createdAt: number) {
  const l = LOGS.get(mint);
  if (!l || Math.abs(l.t0 - createdAt) > 5_000) return null;
  return l;
}

/** Mints still inside their first ~7 minutes (the worker keeps their trades subscribed). */
export function youngMints(now = Date.now()) {
  const out: string[] = [];
  for (const [m, l] of LOGS) if (now - l.t0 <= LOG_MS) out.push(m);
  return out;
}

/** A fresh quote (default: at most 3s old). */
export function streamQuote(mint: string, maxAgeMs = 3_000) {
  const q = QUOTES.get(mint);
  return q && Date.now() - q.at <= maxAgeMs ? q : null;
}

/** Drop what is no longer needed (called by the worker every few seconds). */
export function pruneStream(keep: Set<string>, now = Date.now()) {
  for (const [m, l] of LOGS) if (now - l.t0 > LOG_MS + 3 * 60_000) LOGS.delete(m);
  for (const [m, q] of QUOTES) if (!keep.has(m) && now - q.at > 120_000) QUOTES.delete(m);
}

export const streamSize = () => ({ logs: LOGS.size, quotes: QUOTES.size, lastTradeSec: lastTradeAgo() });
