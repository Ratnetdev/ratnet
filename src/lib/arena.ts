// ARENA (v0.1.58, roadmap step 7): several paper strategies trade side by side on the same live signals as the desk,
// each in its own book. One desk tests one set of rules at a time and needs weeks of trades to say anything; six books
// learn six times as fast, and each gets its own exam score, so the exam can be passed by whichever rules earn it.
//
// Every variant changes ENTRY rules only. Fills, fees, slippage and the exit rules (initials, trail, stop, drain, dev
// sells) are the desk's own, so the books differ only in what they buy. Each book: 3 open slots, 0.1 SOL a trade.
// The exam per book is the desk's exam on a virtual 1.25 SOL balance (the same size-to-balance ratio as the paper desk:
// 0.05 SOL trades on ~0.63 SOL). Simplifications vs the desk: no FLOW wait, no falling-knife check, no pullback stalks
// (except where a variant is about exactly that).
import { redis } from "./redis";
import type { Pos } from "./desk";

export type Check = { rule: string; ok: boolean; v?: string };
export type Variant = { id: string; label: string; path: "king" | "momo"; why: string };

export const VARIANTS: Variant[] = [
  { id: "nonano", label: "King, no nano rule", path: "king", why: "King BOND calls without nano having to agree (yesterday's winners were King calls nano scored low)" },
  { id: "nonano_late", label: "King, no nano, late curves", path: "king", why: "as above, and calls on curves past the late-curve limit" },
  { id: "strict", label: "King strict", path: "king", why: "King 70+ and nano 60+, every check passed" },
  { id: "early1", label: "Minute-1 entries", path: "king", why: "buys the minute-1 BOND read right away instead of waiting for the minute-5 call" },
  { id: "momo_now", label: "MOMO now", path: "momo", why: "MOMO signals bought at once, no pullback wait" },
  { id: "momo_strict", label: "MOMO strict", path: "momo", why: "MOMO with twice the volume and buyers, and a stricter holder spread" },
];
export const ARENA_SOL = 0.1;
export const ARENA_MAX_OPEN = 3;
export const ARENA_BASE = 1.25; // virtual balance for the exam (same size-to-balance ratio as the paper desk)
const DESK_ONLY = new Set(["open_slots", "daily_loss_ok"]); // the desk's own limits; each book has its own slots

const okExcept = (checks: Check[], waive: string[] = []) => checks.every((c) => c.ok || DESK_ONLY.has(c.rule) || waive.includes(c.rule));

/** Does a King-path variant take this signal? (King or minute-1 call, with the desk's checks already computed) */
export function acceptKing(v: Variant, checks: Check[], rec: { call?: { score: number; verdict: string; nano?: { score: number; verdict: string } | null } | null; early?: { score: number; verdict: string } | null }, early: boolean, wire: boolean) {
  if (v.path !== "king" || wire) return false;
  if (v.id === "early1") return early && okExcept(checks);
  if (early) return false;
  if (v.id === "nonano") return okExcept(checks, ["nano_agrees"]);
  if (v.id === "nonano_late") return okExcept(checks, ["nano_agrees", "curve_not_late"]);
  if (v.id === "strict") return okExcept(checks) && (rec.call?.score ?? 0) >= 70 && (rec.call?.nano?.score ?? 0) >= 60 && rec.call?.nano?.verdict === "BOND";
  return false;
}

/** Does a MOMO variant take this signal? h: the MOMO read (5-minute volume and buyers). */
export function acceptMomo(v: Variant, checks: Check[], h: { v5: number; buyers5: number; sellers5: number }, top10: number | null) {
  if (v.path !== "momo") return false;
  if (!okExcept(checks)) return false;
  if (v.id === "momo_now") return true;
  if (v.id === "momo_strict") return h.v5 >= 50_000 && h.buyers5 >= 80 && h.buyers5 >= h.sellers5 * 1.2 && (top10 == null || top10 <= 25);
  return false;
}

// ---- the books: positions in memory (worker), written to Redis on every change; trips in one capped list
export type ArenaPos = Pos & { arena: string };
export type ArenaTrip = { v: string; mint: string; symbol: string; how?: string; openedAt: number; closedAt: number; cost: number; back: number; pnl: number; pnlPct: number; reason: string; peakX: number };
const POS_KEY = (id: string) => `rn:arena:pos:${id}`;
export const ARENA_TRIPS = "rn:arena:trips";
let BOOKS: Record<string, Record<string, ArenaPos>> | null = null;

export async function arenaBooks() {
  if (BOOKS) return BOOKS;
  const r = redis();
  const got = await Promise.all(VARIANTS.map((v) => r.hgetall<Record<string, ArenaPos>>(POS_KEY(v.id)).catch(() => null)));
  BOOKS = Object.fromEntries(VARIANTS.map((v, i) => [v.id, (got[i] || {}) as Record<string, ArenaPos>]));
  for (const b of Object.values(BOOKS)) for (const p of Object.values(b)) p.series ||= []; // the exits push to it
  return BOOKS;
}
/** Re-read from Redis next time (another process took over the desk). */
export const arenaForget = () => (BOOKS = null);
const SAVED_AT = new Map<string, number>();
/** Write a position (v0.1.61: at most every 60 seconds unless forced; the copy in memory is always current). */
export async function arenaSave(p: ArenaPos, force = true) {
  const b = await arenaBooks();
  (b[p.arena] ||= {})[p.mint] = p;
  const k = `${p.arena}|${p.mint}`;
  if (!force && Date.now() - (SAVED_AT.get(k) || 0) < 60_000) return;
  SAVED_AT.set(k, Date.now());
  const { series: _s, ...lean } = p as any; // the price series stays in memory only (it was the bulk of every write)
  await redis().hset(POS_KEY(p.arena), { [p.mint]: lean }).catch(() => null);
}
export async function arenaDrop(p: ArenaPos) {
  const b = await arenaBooks();
  delete b[p.arena]?.[p.mint];
  await redis().hdel(POS_KEY(p.arena), p.mint).catch(() => null);
}
// v0.1.61: the trips in memory too, so the minute's summary does not read the whole list back from Redis
let TRIPS: ArenaTrip[] | null = null;
async function arenaTrips() {
  if (!TRIPS) TRIPS = ((await redis().lrange<ArenaTrip>(ARENA_TRIPS, 0, 599).catch(() => [])) || []) as ArenaTrip[];
  return TRIPS;
}
/** v0.1.63: the trips for REGIME (memory, read from Redis once). */
export const arenaRecentTrips = () => arenaTrips();
export async function arenaTrip(t: ArenaTrip) {
  const r = redis();
  if (TRIPS) TRIPS = [t, ...TRIPS].slice(0, 600);
  await r.lpush(ARENA_TRIPS, t).catch(() => null);
  await r.ltrim(ARENA_TRIPS, 0, 599).catch(() => null); // ~100 per book: the exam needs the last 30
}

// ---- scoring: the desk's exam on each book
export function arenaScore(trips: ArenaTrip[]) {
  const out: Record<string, { n: number; wins: number; winRate: number; pnl: number; avgPct: number; pnlPct: number; pfLessBest: number; dd: number; checks: { label: string; ok: boolean; now: string }[]; passed: boolean }> = {};
  for (const v of VARIANTS) {
    const mine = trips.filter((t) => t.v === v.id).sort((a, b) => b.closedAt - a.closedAt);
    const last = mine.slice(0, 30).map((t) => t.pnl);
    const wins = last.filter((x) => x > 0).length;
    const winRate = last.length ? (wins / last.length) * 100 : 0;
    const sum = last.reduce((a, x) => a + x, 0);
    const pnlPct = (sum / ARENA_BASE) * 100;
    const less = last.slice();
    if (less.length) less.splice(less.indexOf(Math.max(...less)), 1);
    const gw = less.filter((x) => x > 0).reduce((a, x) => a + x, 0);
    const gl = -less.filter((x) => x < 0).reduce((a, x) => a + x, 0);
    const pfLessBest = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;
    let run = 0, peak = 0, dd = 0;
    for (const x of last.slice().reverse()) {
      run += x;
      peak = Math.max(peak, run);
      dd = Math.max(dd, ((peak - run) / (ARENA_BASE + peak)) * 100);
    }
    const full = last.length >= 30;
    const checks = [
      { label: "round trips", ok: mine.length >= 30, now: `${mine.length}/30` },
      { label: "win rate ≥ 40%", ok: full && winRate >= 40, now: `${winRate.toFixed(0)}%` },
      { label: "profit ≥ +10%", ok: full && pnlPct >= 10, now: `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%` },
      { label: "profit factor without the best ≥ 1.2", ok: full && pfLessBest >= 1.2, now: pfLessBest >= 99 ? "no losses" : pfLessBest.toFixed(2) },
      { label: "drawdown ≤ 30%", ok: last.length > 0 && dd <= 30, now: `${dd.toFixed(0)}%` },
    ];
    out[v.id] = { n: mine.length, wins: mine.filter((t) => t.pnl > 0).length, winRate: mine.length ? (mine.filter((t) => t.pnl > 0).length / mine.length) * 100 : 0, pnl: Math.round(mine.reduce((a, t) => a + t.pnl, 0) * 1e4) / 1e4, avgPct: mine.length ? Math.round((mine.reduce((a, t) => a + t.pnlPct, 0) / mine.length) * 10) / 10 : 0, pnlPct, pfLessBest, dd, checks, passed: checks.every((c) => c.ok) };
  }
  return out;
}

/** The public view: variants, open positions per book, scores. */
export async function arenaView() {
  const [books, trips] = await Promise.all([arenaBooks().catch(() => ({} as Record<string, Record<string, ArenaPos>>)), arenaTrips()]);
  const score = arenaScore((trips || []) as ArenaTrip[]);
  return {
    at: Date.now(),
    variants: VARIANTS.map((v) => ({ ...v, open: Object.values(books[v.id] || {}).map((p) => ({ mint: p.mint, symbol: p.symbol, openedAt: p.openedAt, pnlPct: p.entryPx ? Math.round(((p.lastPx || p.entryPx) / p.entryPx - 1) * 1000) / 10 : 0 })), ...score[v.id] })),
    recent: ((trips || []) as ArenaTrip[]).slice(0, 40),
  };
}

// The site reads a summary the worker publishes once a minute (the trip list is never read by page views)
export const ARENA_VIEW = "rn:arena:view";
let lastPub = "";
let lastPubAt = 0;
export async function arenaPublish(now = Date.now()) {
  const v = await arenaView();
  const sig = JSON.stringify(v.variants.map((x) => [x.id, x.n, x.open.length, x.pnl])) + (v.recent[0]?.closedAt ?? "");
  // v0.1.60: also every 5 minutes when nothing changed. It used to expire after an hour without a new trip and was not
  // written again until the next one, so ARENA on /desk showed zeros while the books had ~50 trips
  if (sig === lastPub && now - lastPubAt < 5 * 60_000) return false;
  lastPub = sig;
  lastPubAt = now;
  await redis().set(ARENA_VIEW, { ...v, recent: v.recent.slice(0, 12) }, { ex: 2 * 86400 });
  return true;
}
