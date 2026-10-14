// v0.1.71: GRID LIVE. GRID finds strategies on the archive; these books trade its best ones on live coins at once, in
// paper, so a strategy that looked good on history gets a live record within hours instead of waiting for a build.
//
// After every GRID run (every hour since v0.1.73) free slots are filled, up to 16 strategies: the ones that passed on the
// newest calls first (most passes across runs first), then the ones positive on the newest calls. Each book trades its
// strategy exactly as GRID tested it: the same call filter, the same entry timing (at the call, on a climb, on a dip,
// 2 minutes later), the same exit (half at the target, trail, stop, time), the desk's size and costs, filled at the
// first price 2+ seconds after the signal. Records are kept per strategy, so one that comes back later keeps its record.
// A strategy that passes the desk's exam here (30 trips, 40%+ won, +10% on a 1 SOL desk, PF 1.2+ without the best
// trade) is announced on Telegram: the next step is putting the desk on it.
import { redis } from "./redis";
import { ATA_RENT, sellProceeds, slipOf, txCost, venueFee, type CostCfg } from "./costs";
import { SITE } from "@/config/site";
import { GRID_SOL, HOLD_MS, MODES, PREDS, exitText, type GCoin, type GExit, type GRow } from "./grid";

const D = (SITE as any).desk || {};
const COST: CostCfg = { jitoTipMinSol: D.jitoTipMinSol, jitoTipMaxSol: D.jitoTipMaxSol, paperPrioritySol: D.paperPrioritySol };
export const LIVE_MAX_BOOKS = 16; // v0.1.73: 8 to 16 (paper costs nothing; more books in parallel = records sooner)
const MAX_OPEN = 10; // per book
const PATH_MS = 62 * 60_000;
const BOOKS_KEY = "rn:gridlive:books";
const POS_KEY = "rn:gridlive:pos";
export const LIVE_TRIPS = "rn:gridlive:trips";
export const LIVE_VIEW = "rn:gridlive:view";
const PASSED_KEY = "rn:gridlive:passed";

export type LBook = { key: string; label: string; filter: string; mode: string; exit: GExit; since: number; grid: { testN: number; testAvg: number; pass: boolean; explore?: boolean } };
type Pend = { key: string; mint: string; symbol: string; callAt: number; p0: number; px0: number; until: number; fillAfter: number | null };
export type LPos = { key: string; mint: string; symbol: string; openedAt: number; fillPx: number; tokens: number; cost: number; back: number; peak: number; initials: boolean; tEnd: number; lastPx: number; lastReal: number; pool?: boolean; sender?: boolean };
export type LTrip = { k: string; mint: string; symbol: string; openedAt: number; closedAt: number; pnl: number; pnlPct: number; why: string };

let BOOKS: LBook[] = [];
const PEND = new Map<string, Pend>(); // key|mint
const POS = new Map<string, LPos>(); // key|mint
const LAST = new Map<string, { at: number; px: number; real: number; p: number; done: boolean; pool?: boolean }>();
const HIST = new Map<string, { t: number; p: number }[]>(); // curve % over the last 3 minutes (curve speed)
let TRIPS: LTrip[] = [];
let loaded = false;

export async function gridLiveLoad() {
  if (loaded) return;
  loaded = true;
  const r = redis();
  const [b, pos, trips] = await Promise.all([r.get<LBook[]>(BOOKS_KEY).catch(() => null), r.hgetall<Record<string, LPos>>(POS_KEY).catch(() => null), r.lrange<LTrip>(LIVE_TRIPS, 0, 2999).catch(() => [])]);
  BOOKS = Array.isArray(b) ? b : [];
  for (const [k, p] of Object.entries(pos || {})) if (p && typeof p === "object") POS.set(k, p as LPos);
  TRIPS = ((trips || []) as LTrip[]).filter(Boolean);
}
export const gridLiveBooks = () => BOOKS;

/**
 * v0.1.73: a strategy keeps its book until its live record decides it. Before, every GRID run replaced all books, so a
 * strategy halfway to its 30 trips was dropped and its record stopped growing. Now a book stays while it is collecting
 * and is dropped only when its live record rules it out (dropReason); passed books stay for good. New GRID candidates
 * fill the free slots, best first.
 */
export function dropReason(l: LStat): string | null {
  if (l.passed || l.pending) return null;
  if (l.n >= 30) return "30 trips without passing the exam";
  if (l.n >= 10 && l.avgPct <= -10) return `losing live: avg ${l.avgPct}% after ${l.n} trips`;
  if (l.n >= 20 && l.pfLessBest < 0.8) return `losing live: PF ${l.pfLessBest} after ${l.n} trips`;
  return null;
}
const statOf = (key: string) => bookStat(BOOKS.find((b) => b.key === key) ?? { grid: { testN: 0, testAvg: 0, pass: false } }, TRIPS.filter((t) => t.k === key));

export async function gridLiveSetBooks(rows: GRow[], now = Date.now()) {
  const keep = BOOKS.filter((b) => !dropReason(statOf(b.key)));
  const dropped = BOOKS.filter((b) => !keep.includes(b)).map((b) => ({ key: b.key, why: dropReason(statOf(b.key)) }));
  const fresh = rows
    .filter((r) => !keep.some((b) => b.key === r.key))
    // never bring back a strategy its own live record already ruled out
    .filter((r) => !dropReason(statOf(r.key)))
    .slice(0, Math.max(0, LIVE_MAX_BOOKS - keep.length))
    .map((r) => ({
      key: r.key,
      label: `${r.filterLabel}, buy ${r.modeLabel}`,
      filter: r.filter,
      mode: r.mode,
      exit: r.exit,
      since: now,
      grid: { testN: r.test.n, testAvg: r.test.avgPct, pass: r.pass, explore: !!r.explore },
    }));
  // a kept strategy that GRID ranked again gets its newest GRID numbers
  for (const b of keep) {
    const r = rows.find((x) => x.key === b.key);
    if (r) b.grid = { testN: r.test.n, testAvg: r.test.avgPct, pass: r.pass, explore: !!r.explore };
  }
  BOOKS = [...keep, ...fresh];
  for (const k of [...PEND.keys()]) if (!BOOKS.some((b) => k.startsWith(`${b.key}#`))) PEND.delete(k);
  await redis().set(BOOKS_KEY, BOOKS).catch(() => null);
  return Object.assign(BOOKS, { kept: keep.length, added: fresh.length, dropped });
}

const filterOk = (filter: string, c: GCoin) => filter === "all" || filter.split("+").every((id) => PREDS.find((p) => p.id === id)?.ok(c) ?? false);
const id = (key: string, mint: string) => `${key}#${mint}`;

/** A King call was made (digger). Every book whose filter takes it starts watching for its entry. */
export function gridLiveCall(call: any, now = Date.now()) {
  if (!BOOKS.length || !call?.mint || call.farm) return;
  const mint = String(call.mint);
  const last = LAST.get(mint);
  if (!last || last.done || !(last.px > 0)) return; // no live price for it: GRID could not have traded it either
  const tp = call.tp || {};
  const h = HIST.get(mint) || [];
  const old = h.filter((x) => x.t <= now - 60_000).pop();
  const progress = Number(call.progress) || last.p || 0;
  const c = {
    mint,
    symbol: String(call.symbol || ""),
    at: now,
    createdAt: Number(call.createdAt) || now,
    verdict: String(call.verdict || "DUST"),
    score: Number(call.score) || 0,
    nano: call.nano?.score ?? null,
    progress,
    rise60: progress - (old ? old.p : 0),
    uniq: tp.uniq ?? null,
    spb: tp.spb ?? null,
    bs: tp.bs ?? null,
    sn: tp.sn ?? null,
    sm: Number(tp.sm) || 0,
    ds: !!tp.ds,
    soc: Number(call.soc) || 0,
  } as unknown as GCoin;
  for (const b of BOOKS) {
    if (PEND.has(id(b.key, mint)) || POS.has(id(b.key, mint))) continue;
    if (!filterOk(b.filter, c)) continue;
    const m = MODES.find((x) => x.id === b.mode);
    if (!m) continue;
    PEND.set(id(b.key, mint), { key: b.key, mint, symbol: c.symbol, callAt: now, p0: last.p, px0: last.px, until: now + Math.max(30_000, m.win * 60_000), fillAfter: m.kind === "now" ? now + 2_000 : null });
  }
  if (PEND.size > 3000) for (const [k, p] of PEND) if (p.until < now) PEND.delete(k);
}

/** Every live curve update (worker). */
export function gridLiveCurve(mint: string, v: { progress?: number; mcapSol?: number; realSol?: number; complete?: boolean }, now = Date.now()) {
  const px = Number(v.mcapSol) || 0;
  const p = Number(v.progress) || 0;
  if (LAST.get(mint)?.pool) return; // migrated: the pool prices (gridLiveQuote) lead from here
  LAST.set(mint, { at: now, px, real: Number(v.realSol) || 0, p, done: !!v.complete });
  const h = HIST.get(mint) || [];
  h.push({ t: now, p });
  while (h.length && h[0].t < now - 180_000) h.shift();
  HIST.set(mint, h);
  if (LAST.size > 6000) for (const [k, x] of LAST) if (now - x.at > 2 * 3600_000) (LAST.delete(k), HIST.delete(k));
  if (!BOOKS.length && !POS.size) return;
  for (const b of BOOKS) {
    const k = id(b.key, mint);
    const pe = PEND.get(k);
    if (pe) stepPend(b, pe, k, now);
  }
  for (const [k, pos] of POS) if (pos.mint === mint) stepPos(k, pos, now);
}

function stepPend(b: LBook, pe: Pend, k: string, now: number) {
  const last = LAST.get(pe.mint)!;
  const m = MODES.find((x) => x.id === b.mode)!;
  if (m.kind === "mig") {
    // waits for the first pool price after the migration (the curve's own completion is not a price to buy at)
    if (!last.pool) {
      if (now > pe.until) PEND.delete(k);
      return;
    }
    if (pe.fillAfter == null) {
      pe.fillAfter = now + 2_000;
      return;
    }
  } else if (last.done) return void PEND.delete(k);
  if (pe.fillAfter == null) {
    if (now > pe.until && m.kind !== "hold") return void PEND.delete(k);
    if (m.kind === "climb" && last.p >= pe.p0 + m.a) pe.fillAfter = now + 2_000;
    else if (m.kind === "dip" && last.px <= pe.px0 * (1 - m.a)) pe.fillAfter = now + 2_000;
    return;
  }
  if (now < pe.fillAfter) return;
  PEND.delete(k);
  const open = [...POS.values()].filter((p) => p.key === b.key).length;
  if (open >= MAX_OPEN) return;
  const px0 = last.px / 1e9;
  if (!(px0 > 0)) return;
  const sol = GRID_SOL;
  const inPool = !!last.pool;
  const fillPx = px0 * (1 + slipOf(sol, inPool, last.real));
  const pos: LPos = { key: b.key, mint: pe.mint, symbol: pe.symbol, openedAt: now, fillPx, tokens: (sol * (1 - venueFee(inPool, last.px))) / fillPx, cost: sol + txCost(sol, COST) + ATA_RENT, back: 0, peak: px0, initials: false, tEnd: now + b.exit.timeMin * 60_000, lastPx: px0, lastReal: last.real, pool: inPool };
  POS.set(k, pos);
  redis().hset(POS_KEY, { [k]: pos }).catch(() => null);
}

function sell(pos: LPos, frac: number, px: number, real: number) {
  const amt = frac >= 1 ? pos.tokens : pos.tokens * frac;
  pos.back += sellProceeds(amt, px, !!pos.pool, real, COST, frac >= 1);
  pos.tokens -= amt;
}
function close(k: string, pos: LPos, now: number, why: string) {
  if (pos.tokens > 1e-12) sell(pos, 1, pos.lastPx, pos.lastReal);
  POS.delete(k);
  const pnl = pos.back - pos.cost;
  const t: LTrip = { k: pos.key, mint: pos.mint, symbol: pos.symbol, openedAt: pos.openedAt, closedAt: now, pnl: Math.round(pnl * 1e6) / 1e6, pnlPct: Math.round((pnl / pos.cost) * 1000) / 10, why };
  TRIPS = [t, ...TRIPS].slice(0, 3000);
  const r = redis();
  r.hdel(POS_KEY, k).catch(() => null);
  r.lpush(LIVE_TRIPS, t).then(() => r.ltrim(LIVE_TRIPS, 0, 2999)).catch(() => null);
}

function stepPos(k: string, pos: LPos, now: number) {
  const last = LAST.get(pos.mint)!;
  const b = BOOKS.find((x) => x.key === pos.key);
  const x = b?.exit ?? exitOfKey(pos.key);
  if (!x) return close(k, pos, now, "strategy gone");
  if (last.done && !last.pool) {
    // the migration: sell at the curve's last price, or hold on into the pool (its prices come from AFTER)
    if (x.mig !== "hold") return close(k, pos, now, "migrated");
    pos.pool = true;
    return;
  }
  if (last.pool && !pos.pool) {
    if (x.mig !== "hold") return close(k, pos, now, "migrated");
    pos.pool = true;
  }
  const px = last.px / 1e9;
  if (!(px > 0)) return;
  pos.lastPx = px;
  pos.lastReal = last.real;
  if (px > pos.peak) pos.peak = px;
  const xr = px / pos.fillPx;
  if (!pos.initials && xr >= x.initials) {
    sell(pos, 0.5, px, last.real);
    pos.initials = true;
    redis().hset(POS_KEY, { [k]: pos }).catch(() => null);
    return;
  }
  if (xr <= 1 - x.stop) return close(k, pos, now, "stop");
  if (pos.initials && px <= pos.peak * (1 - x.trail)) return close(k, pos, now, "trail");
  if (now >= pos.tEnd && (!pos.initials || xr < 1.1)) return close(k, pos, now, "time");
}

/** A pool price after the migration (the AFTER feed). */
export function gridLiveQuote(mint: string, q: { mcSol: number; real: number }, now = Date.now()) {
  if (!(q.mcSol > 0)) return;
  LAST.set(mint, { at: now, px: q.mcSol, real: q.real, p: 100, done: true, pool: true });
  if (!BOOKS.length && !POS.size) return;
  for (const b of BOOKS) {
    const k = id(b.key, mint);
    const pe = PEND.get(k);
    if (pe) stepPend(b, pe, k, now);
  }
  for (const [k, pos] of POS) if (pos.mint === mint) stepPos(k, pos, now);
}

// a position whose book was dropped keeps its exit (it is in the key)
function exitOfKey(key: string): GExit | null {
  const m = key.split("|")[2]?.split("/");
  if (!m || m.length < 4) return null;
  const v = m.slice(0, 4).map(Number);
  if (!v.every(Number.isFinite)) return null;
  return { initials: v[0], trail: v[1], stop: v[2], timeMin: v[3], mig: m[4] === "hold" ? "hold" : "sell" };
}

/** Every 10 seconds: the 2-minute entries, time exits on coins that stopped trading, the end of the hour. */
export function gridLiveSweep(now = Date.now()) {
  for (const [k, pe] of PEND) {
    const b = BOOKS.find((x) => x.key === pe.key);
    const m = b && MODES.find((x) => x.id === b.mode);
    if (!b || !m) {
      PEND.delete(k);
      continue;
    }
    if (m.kind === "hold" && pe.fillAfter == null && now >= pe.callAt + m.win * 60_000) {
      const last = LAST.get(pe.mint);
      // 2 minutes on: enter only if it still trades above the call price (filled on its next update)
      if (last && !last.done && last.at >= pe.callAt + 60_000 && last.px > pe.px0) pe.fillAfter = now + 2_000;
      else PEND.delete(k);
      continue;
    }
    if (pe.fillAfter == null && now > pe.until) PEND.delete(k);
    else if (pe.fillAfter != null && now > pe.fillAfter + 120_000) PEND.delete(k); // no update to fill on: GRID would not fill either
  }
  for (const [k, pos] of POS) {
    const x = BOOKS.find((b) => b.key === pos.key)?.exit ?? exitOfKey(pos.key);
    const xr = pos.lastPx / pos.fillPx;
    if (now - pos.openedAt >= (x?.mig === "hold" ? HOLD_MS : PATH_MS)) close(k, pos, now, x?.mig === "hold" ? "6 hours over" : "hour over");
    else if (x && now >= pos.tEnd && (!pos.initials || xr < 1.1)) close(k, pos, now, "time");
  }
}

export type LStat = { n: number; wins: number; winRate: number; avgPct: number; pnl: number; pfLessBest: number; passed: boolean; pending?: boolean };
/** The desk's exam on a strategy's last 30 live trips (a 1 SOL desk at 0.05 SOL a trade: +10% = +0.1 SOL). */
export function liveStat(trips: LTrip[]): LStat {
  const last = trips.slice(0, 30);
  const n = last.length;
  const pnls = last.map((t) => t.pnl);
  const wins = pnls.filter((x) => x > 0).length;
  const sum = pnls.reduce((a, x) => a + x, 0);
  const less = pnls.slice();
  if (less.length) less.splice(less.indexOf(Math.max(...less)), 1);
  const gw = less.filter((x) => x > 0).reduce((a, x) => a + x, 0);
  const gl = -less.filter((x) => x < 0).reduce((a, x) => a + x, 0);
  const pf = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;
  const winRate = n ? (wins / n) * 100 : 0;
  return { n, wins, winRate: Math.round(winRate), avgPct: n ? Math.round((last.reduce((a, t) => a + t.pnlPct, 0) / n) * 10) / 10 : 0, pnl: Math.round(sum * 1e4) / 1e4, pfLessBest: Math.round(pf * 100) / 100, passed: n >= 30 && winRate >= 40 && sum >= 0.1 && pf >= 1.2 };
}

/**
 * v0.1.74: an exploring book (not proven by GRID's train/test split) must also hold up over more trips: 45+ in total
 * and positive over all of them, on top of the exam on its last 30. With 16 books searching, one lucky 30-trip run is
 * the risk this guards against.
 */
export function bookStat(b: Pick<LBook, "grid">, trips: LTrip[]): LStat {
  const l = liveStat(trips);
  if (!b.grid?.explore || !l.passed) return l;
  const total = trips.reduce((a, t) => a + t.pnl, 0);
  const ok = trips.length >= 45 && total > 0;
  return { ...l, passed: ok, pending: !ok }; // pending: the exam holds, the extra trips are still coming
}

/** The site's summary (once a minute) and the Telegram note when a strategy passes the exam live. */
export async function gridLivePublish(send?: (text: string) => Promise<unknown>) {
  const now = Date.now();
  const byKey = new Map<string, LTrip[]>();
  for (const t of TRIPS) (byKey.get(t.k) || byKey.set(t.k, []).get(t.k)!).push(t);
  const books = BOOKS.map((b) => ({ ...b, exitLabel: exitText(b.exit), open: [...POS.values()].filter((p) => p.key === b.key).map((p) => ({ mint: p.mint, symbol: p.symbol, openedAt: p.openedAt, pnlPct: Math.round((p.lastPx / p.fillPx - 1) * 1000) / 10 })), watching: [...PEND.values()].filter((p) => p.key === b.key).length, live: bookStat(b, byKey.get(b.key) || []) }));
  // strategies no longer in the books but with a record worth keeping on screen
  const past = [...byKey.entries()].filter(([k]) => !BOOKS.some((b) => b.key === k)).map(([k, ts]) => ({ key: k, live: liveStat(ts) })).filter((x) => x.live.n >= 5).sort((a, b) => b.live.avgPct - a.live.avgPct).slice(0, 6);
  for (const b of books) {
    if (!b.live.passed || !send) continue;
    const fresh = await redis().hsetnx(PASSED_KEY, b.key, { at: now, ...b.live }).catch(() => 0);
    if (fresh) await send(`🏁 <b>GRID LIVE: a strategy passed the exam on live coins</b>\n${b.label.replace(/[<>&]/g, " ")}\n${b.exitLabel}\n${b.live.n} trips, ${b.live.winRate}% won, ${b.live.pnl >= 0 ? "+" : ""}${b.live.pnl} SOL on 0.05 SOL trades, PF ${b.live.pfLessBest} without the best.\n\nNext: the desk trades it.`).catch(() => null);
  }
  const view = { at: now, books, past, recent: TRIPS.slice(0, 15), trips: TRIPS.length };
  await redis().set(LIVE_VIEW, view, { ex: 2 * 86400 }).catch(() => null);
  return view;
}

/** Tests: reset the memory. */
export function gridLiveReset() {
  BOOKS = [];
  PEND.clear();
  POS.clear();
  LAST.clear();
  HIST.clear();
  TRIPS = [];
  loaded = true;
}
export const gridLiveState = () => ({ pend: PEND, pos: POS, trips: TRIPS });
