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
import { chooseVariants, fired, FLOW_SEED, flowxStats, learnTable, parseVariant, TRIGS, variantText, type FlowX, type Trig } from "./flowx";
import { paperPriority } from "./livecost";
import { redis } from "./redis";
import { ATA_RENT, sellProceeds, slipOf, txCost, venueFee, type CostCfg } from "./costs";
import { SITE } from "@/config/site";
import { GEXITS, GRID_SOL, HOLD_MS, MODES, PREDS, RUNNER_EXITS, exitOfPart, exitText, firstSell, holdMax, isRunner, keyOf, type GCoin, type GExit, type GRow } from "./grid";

const D = (SITE as any).desk || {};
// v0.1.96: the priority fee paper pays is what live transactions paid (lib/livecost.ts), the setting until there are 10
const COST: CostCfg = { jitoTipMinSol: D.jitoTipMinSol, jitoTipMaxSol: D.jitoTipMaxSol, get paperPrioritySol() { return paperPriority(D.paperPrioritySol); } };
export const LIVE_MAX_BOOKS = 16; // v0.1.73: 8 to 16 (paper costs nothing; more books in parallel = records sooner)
const MAX_OPEN = 10; // per book
const MAX_OPEN_ANY = 25; // v0.1.78: a twin on every launch sees many more entries (and holds up to 6h)
const MAX_OPEN_RUN = 40; // v0.1.89: runners hold up to 24h (most coins hit the stop within the hour)
export const SPAWN_MAX = 8; // v0.1.78: variants and twins of the hot strategy, on top of GRID's 16
const SPAWNED_KEY = "rn:gridlive:spawned";
const FILLS_KEY = "rn:gridlive:fills";
const GAPBLOCK_KEY = "rn:gridlive:gapblock";
// v0.1.78: filters a twin can run on every launch (they need only the curve, no King call)
const CURVE_ONLY = new Set(["p4", "p15", "p35", "p70", "r5", "r15", "pw1", "pw2", "u25", "bs70", "wh"]); // v0.1.81: + FIREHOSE features
// v0.1.81: the FIREHOSE's live features for a coin (worker), so every-launch books can use WALLETS and TAPE ALL too
let LIVE_FX: ((mint: string) => { pw: number; u60: number; bs60: number | null; wh: number; ds?: boolean } | null) | null = null;
export const setLiveFeatures = (f: typeof LIVE_FX) => (LIVE_FX = f);
// v0.1.105 EXIT FLOWS (measured, not traded): every open paper position watches its coin's flow. When the early buyers
// turn sellers (half of the first 20 have sold, from under half at the buy) or a tracked KOL sells after the buy, the
// position notes what selling right then would have made. At its real close the two are set side by side: on the same
// trips, would the flow exit have done better? (Evidence elsewhere: surges were up an hour later 60% of the time, 6%
// when the early buyers were exiting.) Nothing changes the trades until this record says so.
let FLOW_FX: ((mint: string) => { kx: number | null; e20: number | null } | null) | null = null;
export const setFlowFeatures = (f: typeof FLOW_FX) => (FLOW_FX = f);
export const FLOWX_KEY = "rn:gridlive:flowx";
let FLOWX: FlowX[] = [];
export const flowxView = () => flowxStats(FLOWX);
export { flowxStats, type FlowX };
// v0.1.108 FLOW EXIT: the learner's current picks (twin books run them for real; see seedFlow)
let FLOW_PICKS: { picks: string[]; learned: boolean; at: number } = { picks: [FLOW_SEED], learned: false, at: 0 };
export const flowPicks = () => FLOW_PICKS;
export const flowTable = () => learnTable(FLOWX);
/** Tests only. */
export const _flowxSet = (xs: FlowX[]) => (FLOWX = xs);
const PATH_MS = 62 * 60_000;
const BOOKS_KEY = "rn:gridlive:books";
const POS_KEY = "rn:gridlive:pos";
export const LIVE_TRIPS = "rn:gridlive:trips";
export const LIVE_VIEW = "rn:gridlive:view";
const PASSED_KEY = "rn:gridlive:passed";

export type LBook = {
  key: string;
  label: string;
  filter: string;
  mode: string;
  exit: GExit;
  since: number;
  grid: { testN: number; testAvg: number; pass: boolean; explore?: boolean };
  /** v0.1.78: runs on every launch that meets the filter on the curve, not only on King calls */
  any?: boolean;
  /** v0.1.78: spawned from this hot strategy (an exit variant or the every-launch twin) */
  parent?: string;
  /** v0.1.82: proposed by RESEARCHER (its own slots, on top of GRID's 16), and why */
  by?: "researcher" | "runner" | "wallets" | "seer" | "signals";
  why?: string;
  /** v0.1.85: brought back by its own live record (reviveBooks); its own slots, outside GRID's 16 */
  back?: boolean;
  /** v0.1.108 FLOW EXIT twin: the same strategy as `fxOf`, plus this flow exit variant (lib/flowx.ts) */
  fv?: string;
  fxOf?: string;
};
type Pend = { key: string; mint: string; symbol: string; callAt: number; p0: number; px0: number; until: number; fillAfter: number | null };
export type LPos = { key: string; mint: string; symbol: string; openedAt: number; fillPx: number; tokens: number; cost: number; back: number; peak: number; initials: boolean; tEnd: number; lastPx: number; lastReal: number; pool?: boolean; sender?: boolean; f0?: { kx: number | null; e20: number | null } | null; fx?: { at: number; pct: number; why: string } | null; fl?: Partial<Record<Trig, number>>; fd?: boolean };
export type LTrip = { k: string; mint: string; symbol: string; openedAt: number; closedAt: number; pnl: number; pnlPct: number; why: string };

let BOOKS: LBook[] = [];
const PEND = new Map<string, Pend>(); // key|mint
const POS = new Map<string, LPos>(); // key|mint
const LAST = new Map<string, { at: number; px: number; real: number; p: number; done: boolean; pool?: boolean }>();
const HIST = new Map<string, { t: number; p: number }[]>(); // curve % over the last 3 minutes (curve speed)
let TRIPS: LTrip[] = [];
// v0.1.75: FOLLOW. The leader (the best strategy that passed the exam live) hands every entry to the desk
type FollowOrder = { key: string; label: string; exit: GExit; mint: string; symbol: string; at: number; pool: boolean; pcts?: number[]; probation?: boolean; fv?: string };
let FOLLOW: ((o: FollowOrder) => void) | null = null;
export const setGridFollow = (f: ((o: FollowOrder) => void) | null) => (FOLLOW = f);
let LEADER: string | null = null;
export const gridLeaderKey = () => LEADER;
/** The strategy the desk follows: passed live (bookStat), best live P&L first. */
export function gridLeader(): LBook | null {
  const passed = BOOKS.map((b) => ({ b, s: bookStat(b, TRIPS.filter((t) => t.k === b.key)) }))
    .filter((x) => x.s.passed && !gapBlock(x.b.key))
    .sort((a, z) => Number(!!a.s.probation) - Number(!!z.s.probation) || z.s.pnl - a.s.pnl); // v0.1.102: a full pass leads a SEER probation
  return passed[0]?.b ?? null;
}
let loaded = false;
// v0.1.78: real-fill check. Jupiter (the route live money takes, tawtis' point on Reels: not PumpSwap directly) quoted
// at every paper fill of the strategies that matter, so the gap between paper and real is measured before money moves.
type Fill = { bn: number; bg: number; sn: number; sg: number; nr: number };
const FILLS = new Map<string, Fill>();
const TRIG = new Set<string>(); // key#mint a twin already entered once
let SPAWNED: string[] = []; // parents already spawned (once each)

/**
 * v0.1.85: the books and trips are only trusted when Redis answered. Before, a failed read at boot (the worker restarted
 * 70+ times, some during Redis trouble) loaded zero books, the next GRID run filled 16 fresh ones and saved them over
 * the real list: two strategies in profit (15 and 23 trips, +0.39 SOL each) vanished with no drop reason. Now a failed
 * read is retried (5 tries, 2s apart, then again on every GRID LIVE save), and nothing writes the books until they
 * were read.
 */
let booksOk = false;
export const gridLiveLoaded = () => booksOk;
const FAIL = Symbol("redis read failed");
async function tryRead<T>(f: () => Promise<T>): Promise<T | typeof FAIL> {
  try {
    return await f();
  } catch {
    return FAIL;
  }
}
export async function gridLiveLoad(tries = 5, waitMs = 2000) {
  if (loaded) return true;
  const r = redis();
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((res) => setTimeout(res, waitMs));
    const [b, pos, trips, fills, sp, fxs] = await Promise.all([
      tryRead(() => r.get<LBook[]>(BOOKS_KEY)),
      r.hgetall<Record<string, LPos>>(POS_KEY).catch(() => null),
      tryRead(() => r.lrange<LTrip>(LIVE_TRIPS, 0, 2999)),
      r.hgetall<Record<string, Fill>>(FILLS_KEY).catch(() => null),
      r.get<string[]>(SPAWNED_KEY).catch(() => null),
      r.lrange<FlowX>(FLOWX_KEY, 0, 1999).catch(() => null), // v0.1.108: the learner's record survives a restart
    ]);
    if (b === FAIL || trips === FAIL) continue;
    loaded = true;
    booksOk = true;
    for (const [k, f] of Object.entries(fills || {})) if (f && typeof f === "object") FILLS.set(k, f as Fill);
    SPAWNED = Array.isArray(sp) ? sp : SPAWNED;
    if (Array.isArray(fxs) && !FLOWX.length) FLOWX = (fxs as FlowX[]).filter(Boolean);
    // books added while the read was failing (a GRID run, RESEARCHER) join the saved ones instead of replacing them
    const saved = Array.isArray(b) ? (b as LBook[]) : [];
    BOOKS = [...saved, ...BOOKS.filter((x) => !saved.some((y) => y.key === x.key))];
    for (const [k, p] of Object.entries(pos || {})) if (p && typeof p === "object" && !POS.has(k)) POS.set(k, p as LPos);
    const got = ((trips || []) as LTrip[]).filter(Boolean);
    TRIPS = [...TRIPS.filter((t) => !got.some((g) => g.k === t.k && g.mint === t.mint && g.closedAt === t.closedAt)), ...got];
    return true;
  }
  console.log("grid live: the books could not be read from Redis; they are not saved until they are");
  return false;
}
/** v0.1.85: the books are written only after they were read (a failed boot read retries here first). */
async function saveBooks() {
  if (!booksOk && !(await gridLiveLoad(1, 0).catch(() => false))) return false;
  await redis().set(BOOKS_KEY, BOOKS).catch(() => null);
  return true;
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
  // v0.1.89: runners are not judged by their win rate; they leave when their whole record rules them out
  if (l.runner) {
    const total = l.total ?? l.n;
    if (total >= RUNNER_MAX_TRIPS) return `${RUNNER_MAX_TRIPS} trips without passing the runner exam`;
    if (total >= 30 && (l.totalPnl ?? 0) <= -0.4 * total * GRID_SOL) return `losing: ${l.totalPnl} SOL after ${total} trips`;
    return null;
  }
  // v0.1.82: the exam reads the last 30 trips, so a strategy that is close keeps trading and can still pass on its next
  // trips (the hot one was dropped at 30 trips with +0.219 SOL, 47% won and PF 1.19 against the 1.2 it needs). Close =
  // 40%+ won, in profit and PF 1.0+ on the last 30. It gets up to 60 trips in total; past 30 it must also be positive
  // over all of them to pass (bookStat).
  const total = l.total ?? l.n;
  if (l.n >= 30 && total >= EXTEND_MAX) return `${EXTEND_MAX} trips without passing the exam`;
  if (l.n >= 30 && !closeToPass(l)) return "30 trips without passing the exam";
  // v0.1.78: free the slot sooner for strategies that are clearly not working
  if (l.n >= 5 && l.wins === 0) return `no win in ${l.n} trips`;
  if (l.n >= 8 && l.avgPct <= -15) return `losing live: avg ${l.avgPct}% after ${l.n} trips`;
  if (l.n >= 10 && l.avgPct <= -10) return `losing live: avg ${l.avgPct}% after ${l.n} trips`;
  if (l.n >= 20 && l.pfLessBest < 0.8) return `losing live: PF ${l.pfLessBest} after ${l.n} trips`;
  return null;
}
export const EXTEND_MAX = 60;
/** v0.1.82: near the exam on its last 30 trips: worth more trips (a rolling window, the next trades can pass it). */
export const closeToPass = (l: LStat) => l.winRate >= 40 && l.pnl > 0 && l.pfLessBest >= 1.0;
const statOf = (key: string) => bookStat(BOOKS.find((b) => b.key === key) ?? { grid: { testN: 0, testAvg: 0, pass: false } }, TRIPS.filter((t) => t.k === key));

export async function gridLiveSetBooks(rows: GRow[], now = Date.now()) {
  if (!booksOk) await gridLiveLoad(1, 0).catch(() => false); // v0.1.85: never decide on a list that was not read
  const keep = BOOKS.filter((b) => !dropReason(statOf(b.key)));
  const dropped = BOOKS.filter((b) => !keep.includes(b)).map((b) => ({ key: b.key, why: dropReason(statOf(b.key)) }));
  const fresh = rows
    .filter((r) => !keep.some((b) => b.key === r.key))
    // never bring back a strategy its own live record already ruled out
    .filter((r) => !dropReason(statOf(r.key)))
    // v0.1.78: spawned books (variants, twins) have their own slots on top of GRID's 16 (v0.1.82: RESEARCHER's too)
    .slice(0, Math.max(0, LIVE_MAX_BOOKS - keep.filter((b) => !b.parent && !b.by && !b.back && !b.fv).length))
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
  await saveBooks();
  return Object.assign(BOOKS, { kept: keep.length, added: fresh.length, dropped });
}

const curveOnly = (filter: string) => filter !== "all" && filter.split("+").every((x) => CURVE_ONLY.has(x));
const filterOk = (filter: string, c: GCoin) => filter === "all" || filter.split("+").every((id) => PREDS.find((p) => p.id === id)?.ok(c) ?? false);
const id = (key: string, mint: string) => `${key}#${mint}`;

/** A King call was made (digger). Every book whose filter takes it starts watching for its entry. */
const CALLS = new Map<string, any>();
/** v0.1.109: a label arrived for a coin called in the last 3 minutes: books that need it can start their entry now. */
export function gridLiveRelabel(mint: string, th: { m: number; t: string; heat: number }, now = Date.now()) {
  const call = CALLS.get(mint);
  if (!call) return false;
  CALLS.delete(mint);
  if (now - (Number(call.at) || 0) > 3 * 60_000) return false;
  gridLiveCall({ ...call, sx: { ...(call.sx || {}), th } }, now); // books already watching or holding it are skipped
  return true;
}
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
    pw: tp.pw ?? null,
    u60: tp.u60 ?? null,
    bs60: tp.bs60 ?? null,
    wh: tp.wh ?? null,
    // v0.1.109 (fix): the v0.1.105 flow read reached GRID but not GRID LIVE, so kol3/kolsmall/kolout/hold20/exit20 books
    // could never enter live
    kf: tp.kf ?? null,
    kmu: tp.kmu ?? null,
    kx: tp.kx ?? null,
    e20: tp.e20 ?? null,
    sx: call.sx ?? null, // v0.1.101
  } as unknown as GCoin;
  // v0.1.109: Claude's label lands seconds after the call: the call is kept 3 minutes and read again when it does
  if (!call.sx?.th) {
    CALLS.set(mint, call);
    if (CALLS.size > 500) CALLS.delete(CALLS.keys().next().value as string);
  }
  for (const b of BOOKS) {
    if (b.any) continue; // twins trigger on the curve itself (gridLiveCurve)
    if (PEND.has(id(b.key, mint)) || POS.has(id(b.key, mint))) continue;
    if (!filterOk(b.filter, c)) continue;
    const m = MODES.find((x) => x.id === b.mode);
    if (!m) continue;
    PEND.set(id(b.key, mint), { key: b.key, mint, symbol: c.symbol, callAt: now, p0: last.p, px0: last.px, until: now + Math.max(30_000, m.win * 60_000), fillAfter: m.kind === "now" ? now + 2_000 : null });
  }
  if (PEND.size > 3000) for (const [k, p] of PEND) if (p.until < now) PEND.delete(k);
}

// v0.1.100 (audit): the price map is trimmed at most every 30s. Before, with 6,000+ coins priced inside 2 hours (the
// firehose prices every migrated coin), nothing was old enough to drop and every curve trade (hundreds a second) looped
// over the whole map on the desk's thread. Past 20,000 coins, anything quiet for 30 minutes goes too.
let lastEvict = 0;
function evictLast(now: number) {
  if (now - lastEvict < 30_000 || LAST.size <= 6000) return;
  lastEvict = now;
  const cut = LAST.size > 20_000 ? 30 * 60_000 : 2 * 3600_000;
  const held = new Set([...POS.values()].map((x) => x.mint));
  for (const [k, x] of LAST) if (now - x.at > cut && !held.has(k)) (LAST.delete(k), HIST.delete(k));
}

// ---------------------------------------------------------------- v0.1.102 SEER family
// A foreseen coin is bought in its first seconds: the match arrives with the create (before any price), so it waits
// here for the coin's first curve price, then every SEER book whose filter takes it starts its entry.
const SEER_Q = new Map<string, number>(); // mint -> match time
const SEER_LIVE = new Map<string, { tier: number; rank: number; at: number | null }>(); // mint -> the match (for later entries and the event exit)
export function gridLiveSeer(mint: string, m: { tier: number; rank: number; at: number | null }, now = Date.now()) {
  SEER_LIVE.set(mint, { tier: m.tier, rank: m.rank, at: m.at });
  if (SEER_LIVE.size > 5000) SEER_LIVE.delete(SEER_LIVE.keys().next().value as string);
  const last = LAST.get(mint);
  if (last && last.px > 0 && !last.done) return seerFire(mint, last.p, last.px, now);
  SEER_Q.set(mint, now);
  if (SEER_Q.size > 2000) SEER_Q.delete(SEER_Q.keys().next().value as string);
}
function seerFire(mint: string, p: number, px: number, now: number) {
  SEER_Q.delete(mint);
  const sm = SEER_LIVE.get(mint);
  if (!sm) return;
  const fx = LIVE_FX ? LIVE_FX(mint) : null;
  const c = { mint, symbol: "", at: now, createdAt: now, verdict: "", score: 0, nano: null, progress: p, rise60: 0, uniq: null, spb: null, bs: null, sn: null, sm: 0, ds: !!fx?.ds, soc: 0, pw: fx?.pw ?? null, u60: fx?.u60 ?? null, bs60: fx?.bs60 ?? null, wh: fx?.wh ?? null, sx: { seer: { tier: sm.tier, rank: sm.rank } } } as unknown as GCoin;
  for (const b of BOOKS) {
    if (!b.any || b.by !== "seer") continue;
    const k = id(b.key, mint);
    if (TRIG.has(k) || PEND.has(k) || POS.has(k)) continue;
    if (!filterOk(b.filter, c)) continue;
    const m = MODES.find((x) => x.id === b.mode);
    if (!m || m.kind === "mig") continue;
    TRIG.add(k);
    PEND.set(k, { key: b.key, mint, symbol: SYM.get(mint) || mint.slice(0, 4), callAt: now, p0: p, px0: px, until: now + Math.max(30_000, m.win * 60_000), fillAfter: m.kind === "now" ? now + 2_000 : null });
  }
}
export const SEER_MAX = 8;
export const SEER_SEEDS: string[] = [
  `any:${keyOf("seer", "now", RUNNER_EXITS[0])}`,
  `any:${keyOf("seerfirst", "now", RUNNER_EXITS[0])}`,
  `any:${keyOf("seertop", "now", RUNNER_EXITS[0])}`,
  `any:${keyOf("seerfirst", "now", { initials: 2, trail: 0.25, stop: 0.25, timeMin: 60, mig: "hold" })}`,
  `any:${keyOf("seer", "c5", RUNNER_EXITS[0])}`,
  `any:${keyOf("seertop+seerfirst", "now", RUNNER_EXITS[0])}`,
];
function seedSeer(now: number): LBook[] {
  const out: LBook[] = [];
  let room = SEER_MAX - BOOKS.filter((b) => b.by === "seer" && !b.fv).length;
  for (const k of SEER_SEEDS) {
    if (room <= 0) break;
    if (BOOKS.some((b) => b.key === k)) continue;
    const inner = bookFromKey(k.replace(/^any:/, ""), now);
    if (!inner) continue;
    const b: LBook = { ...inner, key: k, label: `every launch: ${inner.label}`, any: true, by: "seer" };
    const ts = TRIPS.filter((t) => t.k === k);
    if (ts.length && dropReason(bookStat(b, ts))) continue;
    out.push(b);
    room--;
  }
  if (out.length) BOOKS = [...BOOKS, ...out];
  return out;
}

/** Every live curve update (worker). */
export function gridLiveCurve(mint: string, v: { progress?: number; mcapSol?: number; realSol?: number; complete?: boolean }, now = Date.now()) {
  const px = Number(v.mcapSol) || 0;
  const p = Number(v.progress) || 0;
  if (LAST.get(mint)?.pool) return; // migrated: the pool prices (gridLiveQuote) lead from here
  LAST.set(mint, { at: now, px, real: Number(v.realSol) || 0, p, done: !!v.complete });
  if (SEER_Q.has(mint) && px > 0 && !v.complete) seerFire(mint, p, px, now); // v0.1.102: a foreseen coin's first price
  const h = HIST.get(mint) || [];
  h.push({ t: now, p });
  while (h.length && h[0].t < now - 180_000) h.shift();
  HIST.set(mint, h);
  evictLast(now);
  if (!BOOKS.length && !POS.size) return;
  if (!v.complete) anyTrigger(mint, p, px, h, now);
  for (const b of BOOKS) {
    const k = id(b.key, mint);
    const pe = PEND.get(k);
    if (pe) stepPend(b, pe, k, now);
  }
  for (const [k, pos] of POS) if (pos.mint === mint) stepPos(k, pos, now);
}

/**
 * v0.1.78: the every-launch twins. The moment a launch meets a twin's curve filter (for example 70%+ and +5 points in
 * the last minute) it is treated like a King call for that book, once per coin. A coin seen for less than a minute has
 * no climb to measure yet and waits for its next update.
 */
function anyTrigger(mint: string, p: number, px: number, h: { t: number; p: number }[], now: number) {
  const old = h.filter((x) => x.t <= now - 60_000).pop();
  if (!old || !(px > 0)) return;
  const fx = LIVE_FX ? LIVE_FX(mint) : null;
  const sl = SEER_LIVE.get(mint);
  // v0.1.110: origin, DexScreener and the flow, for every-launch books on the new rules
  const ax = ANY_SX ? (() => { try { return ANY_SX!(mint, now); } catch { return null; } })() : null;
  const sx = ax || sl ? { ...(ax?.sx || {}), ...(sl ? { seer: { tier: sl.tier, rank: sl.rank } } : {}) } : null;
  const c = { mint, symbol: "", at: now, createdAt: now, verdict: "", score: 0, nano: null, progress: p, rise60: p - old.p, uniq: null, spb: null, bs: null, sn: null, sm: 0, ds: !!fx?.ds, soc: 0, pw: fx?.pw ?? null, u60: fx?.u60 ?? null, bs60: fx?.bs60 ?? null, wh: fx?.wh ?? null, kf: ax?.kf ?? null, kmu: ax?.kmu ?? null, kx: ax?.kx ?? null, e20: ax?.e20 ?? null, sx } as unknown as GCoin;
  for (const b of BOOKS) {
    if (!b.any) continue;
    const k = id(b.key, mint);
    if (TRIG.has(k) || PEND.has(k) || POS.has(k)) continue;
    if (!filterOk(b.filter, c)) continue;
    const m = MODES.find((x) => x.id === b.mode);
    if (!m || m.kind === "mig") continue;
    TRIG.add(k);
    PEND.set(k, { key: b.key, mint, symbol: SYM.get(mint) || mint.slice(0, 4), callAt: now, p0: p, px0: px, until: now + Math.max(30_000, m.win * 60_000), fillAfter: m.kind === "now" ? now + 2_000 : null });
  }
  if (TRIG.size > 20_000) TRIG.clear();
}
const SYM = new Map<string, string>();
/** v0.1.78: symbols for the twins' trades (the worker passes them with new launches). */
export function gridLiveSymbol(mint: string, symbol: string) {
  if (!mint || !symbol) return;
  SYM.set(mint, symbol);
  if (SYM.size > 8000) SYM.delete(SYM.keys().next().value as string);
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
  if (open >= (b.any ? MAX_OPEN_ANY : isRunner(b.exit) ? MAX_OPEN_RUN : MAX_OPEN)) return;
  const px0 = last.px / 1e9;
  if (!(px0 > 0)) return;
  const sol = GRID_SOL;
  const inPool = !!last.pool;
  const fillPx = px0 * (1 + slipOf(sol, inPool, last.real));
  const pos: LPos = { key: b.key, mint: pe.mint, symbol: pe.symbol, openedAt: now, fillPx, tokens: (sol * (1 - venueFee(inPool, last.px))) / fillPx, cost: sol + txCost(sol, COST) + ATA_RENT, back: 0, peak: px0, initials: false, tEnd: now + b.exit.timeMin * 60_000, lastPx: px0, lastReal: last.real, pool: inPool, f0: flowNow(pe.mint) };
  POS.set(k, pos);
  redis().hset(POS_KEY, { [k]: pos }).catch(() => null);
  if (CHECK.has(b.key)) queueCheck({ side: "buy", key: b.key, mint: pe.mint, amount: BigInt(Math.round(sol * 1e9)), paper: pos.tokens });
  if (FOLLOW && LEADER === b.key) {
    try {
      // v0.1.95: its whole live record goes with the order (net % per trip): the desk sizes the trade from it
      const mine = TRIPS.filter((t) => t.k === b.key);
      FOLLOW({ key: b.key, label: b.label, exit: b.exit, mint: pe.mint, symbol: pe.symbol, at: now, pool: inPool, pcts: mine.map((t) => t.pnlPct), probation: !!bookStat(b, mine).probation, fv: b.fv });
    } catch {}
  }
}

function sell(pos: LPos, frac: number, px: number, real: number) {
  const amt = frac >= 1 ? pos.tokens : pos.tokens * frac;
  pos.back += sellProceeds(amt, px, !!pos.pool, real, COST, frac >= 1);
  pos.tokens -= amt;
}
function close(k: string, pos: LPos, now: number, why: string) {
  if (pos.tokens > 1e-12) {
    // the market part of the paper sale (no tx costs), to set against Jupiter's quote for the same tokens
    if (CHECK.has(pos.key)) queueCheck({ side: "sell", key: pos.key, mint: pos.mint, amount: BigInt(Math.floor(pos.tokens * 1e6)), paper: sellProceeds(pos.tokens, pos.lastPx, !!pos.pool, pos.lastReal, { fastExec: false, paperPrioritySol: 0 } as CostCfg) });
    sell(pos, 1, pos.lastPx, pos.lastReal);
  }
  POS.delete(k);
  const pnl = pos.back - pos.cost;
  const t: LTrip = { k: pos.key, mint: pos.mint, symbol: pos.symbol, openedAt: pos.openedAt, closedAt: now, pnl: Math.round(pnl * 1e6) / 1e6, pnlPct: Math.round((pnl / pos.cost) * 1000) / 10, why };
  if (pos.f0 && pos.f0.kx != null) {
    // (a coin whose flow is unknown, not seen from its create, is left out of the record)
    // v0.1.105: the same trip, had it sold when the flow turned. v0.1.108: every flow-watched trip is kept (also those
    // where nothing fired: they count for every variant at their actual result), with a note per trigger
    const fx: FlowX = { k: pos.key, mint: pos.mint, at: now, act: t.pnlPct, flag: pos.fx ? pos.fx.pct : t.pnlPct, why: pos.fx ? pos.fx.why : "none", fl: pos.fl || {} };
    FLOWX = [fx, ...FLOWX].slice(0, 2000);
    redis().lpush(FLOWX_KEY, fx).then(() => redis().ltrim(FLOWX_KEY, 0, 1999)).catch(() => null);
  }
  TRIPS = [t, ...TRIPS].slice(0, 3000);
  const r = redis();
  r.hdel(POS_KEY, k).catch(() => null);
  r.lpush(LIVE_TRIPS, t).then(() => r.ltrim(LIVE_TRIPS, 0, 2999)).catch(() => null);
}

function flowNow(mint: string) {
  if (!FLOW_FX) return undefined; // no flow feed (tests, Vercel): positions never note a flow exit
  try {
    return FLOW_FX(mint);
  } catch {
    return null;
  }
}
/** The flow after the buy: each trigger notes, the first time it fires, what selling the rest right then would make. */
function flowCheck(k: string, pos: LPos, px: number, now: number) {
  const f = flowNow(pos.mint);
  if (!f) return null;
  const fl = (pos.fl ||= {});
  let changed = false;
  let pct: number | null = null;
  for (const t of TRIGS) {
    if (fl[t.id] != null || !fired(t.id, pos.f0, f)) continue;
    if (pct == null) {
      const back = pos.back + (pos.tokens > 1e-12 ? sellProceeds(pos.tokens, px, !!pos.pool, pos.lastReal, COST, true) : 0);
      pct = Math.round(((back - pos.cost) / pos.cost) * 1000) / 10;
    }
    fl[t.id] = pct;
    changed = true;
  }
  // v0.1.105's single note (the earliest of: a KOL sold, half of the first 20 sold)
  if (!pos.fx && (fl.kol1 != null || fl.e50 != null)) pos.fx = { at: now, pct: (fl.kol1 ?? fl.e50)!, why: fl.kol1 != null ? "kol" : "e20" };
  if (changed) redis().hset(POS_KEY, { [k]: pos }).catch(() => null);
  return f;
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
  const flow = pos.f0 !== undefined ? flowCheck(k, pos, px, now) : null;
  // v0.1.108 FLOW EXIT: a twin book runs its variant for real (sell half or all when its trigger fires)
  const fv = b?.fv ? parseVariant(b.fv) : null;
  if (fv && !pos.fd && fired(fv.trig, pos.f0, flow)) {
    pos.fd = true;
    if (fv.share >= 1) return close(k, pos, now, `FLOW EXIT: ${variantText(b!.fv!)}`);
    sell(pos, fv.share, px, last.real);
    redis().hset(POS_KEY, { [k]: pos }).catch(() => null);
  }
  if (px > pos.peak) pos.peak = px;
  const xr = px / pos.fillPx;
  if (!pos.initials && xr >= x.initials) {
    sell(pos, firstSell(x), px, last.real);
    pos.initials = true;
    redis().hset(POS_KEY, { [k]: pos }).catch(() => null);
    return;
  }
  if (xr <= 1 - x.stop) return close(k, pos, now, "stop");
  // v0.1.102: a foreseen coin is sold 15 minutes after its event (the debate case: +125% in 4 min, then -90% in 30)
  const ev = /\bseer/.test(pos.key) ? SEER_LIVE.get(pos.mint)?.at : null;
  if (ev && now >= ev + 15 * 60_000 && pos.openedAt < ev) return close(k, pos, now, "SEER: the event happened, sold the news");
  if (pos.initials && px <= pos.peak * (1 - x.trail)) return close(k, pos, now, "trail");
  if (now >= pos.tEnd && (!pos.initials || (!isRunner(x) && xr < 1.1))) return close(k, pos, now, "time");
}

/** A pool price after the migration (the AFTER feed). */
export function gridLiveQuote(mint: string, q: { mcSol: number; real: number }, now = Date.now()) {
  if (!(q.mcSol > 0)) return;
  LAST.set(mint, { at: now, px: q.mcSol, real: q.real, p: 100, done: true, pool: true });
  evictLast(now);
  if (!BOOKS.length && !POS.size) return;
  for (const b of BOOKS) {
    const k = id(b.key, mint);
    const pe = PEND.get(k);
    if (pe) stepPend(b, pe, k, now);
  }
  for (const [k, pos] of POS) if (pos.mint === mint) stepPos(k, pos, now);
}

// a position whose book was dropped keeps its exit (it is in the key; v0.1.89: runner exits too)
function exitOfKey(key: string): GExit | null {
  return exitOfPart(key.replace(/^any:/, "").replace(/~fx:.*$/, "").split("|")[2]);
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
    if (now - pos.openedAt >= (x ? holdMax(x) : PATH_MS)) close(k, pos, now, x && isRunner(x) ? `${x.hours} hours over` : x?.mig === "hold" ? "6 hours over" : "hour over");
    else if (x && now >= pos.tEnd && (!pos.initials || (!isRunner(x) && xr < 1.1))) close(k, pos, now, "time");
  }
}

export type LStat = { n: number; wins: number; winRate: number; avgPct: number; pnl: number; pfLessBest: number; passed: boolean; pending?: boolean; total?: number; totalPnl?: number; runner?: boolean; lessTop2?: number; probation?: boolean };
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
  // v0.1.82: every trip it ever made (the extension past 30 trips must not hide a losing start)
  const totalPnl = trips.reduce((a, t) => a + t.pnl, 0);
  const exam = n >= 30 && winRate >= 40 && sum >= 0.1 && pf >= 1.2;
  return { n, wins, winRate: Math.round(winRate), avgPct: n ? Math.round((last.reduce((a, t) => a + t.pnlPct, 0) / n) * 10) / 10 : 0, pnl: Math.round(sum * 1e4) / 1e4, pfLessBest: Math.round(pf * 100) / 100, passed: exam && (trips.length <= 30 || totalPnl > 0), total: trips.length, totalPnl: Math.round(totalPnl * 1e4) / 1e4 };
}

/**
 * v0.1.74: an exploring book (not proven by GRID's train/test split) must also hold up over more trips: 45+ in total
 * and positive over all of them, on top of the exam on its last 30. With 16 books searching, one lucky 30-trip run is
 * the risk this guards against.
 */
export function bookStat(b: Pick<LBook, "grid"> & { key?: string; exit?: GExit }, trips: LTrip[]): LStat {
  // v0.1.102 SEER: event trips are rare (a few to 20 a day), so its books may trade live at the minimum size on a
  // probation exam: 15+ trips, in profit, and still in profit without the 2 best. Full size only through the normal exam
  const st = bookStat0(b, trips);
  if (st.passed || !b.key || !/^any:[^|]*\bseer/.test(b.key)) return st;
  const total = trips.reduce((a, t) => a + t.pnl, 0);
  const top = trips.map((t) => t.pnl).sort((a, z) => z - a);
  const lessTop2 = total - Math.max(0, top[0] ?? 0) - Math.max(0, top[1] ?? 0);
  return trips.length >= SEER_PROBATION && total > 0 && lessTop2 > 0 ? { ...st, passed: true, probation: true, total: trips.length, totalPnl: Math.round(total * 1e4) / 1e4, lessTop2: Math.round(lessTop2 * 1e4) / 1e4 } : st;
}
export const SEER_PROBATION = 15;
function bookStat0(b: Pick<LBook, "grid"> & { key?: string; exit?: GExit }, trips: LTrip[]): LStat {
  // v0.1.89: a runner is judged on its whole record (few wins, big ones), not on 40% won over its last 30
  const x = b.exit ?? (b.key ? exitOfKey(b.key) : null);
  if (isRunner(x)) return runnerStat(trips);
  const l = liveStat(trips);
  if (!b.grid?.explore || !l.passed) return l;
  const total = trips.reduce((a, t) => a + t.pnl, 0);
  const ok = trips.length >= 45 && total > 0;
  return { ...l, passed: ok, pending: !ok }; // pending: the exam holds, the extra trips are still coming
}

/**
 * v0.1.89: the RUNNER exam. A runner wins rarely and big, so the desk's exam (40%+ won, PF 1.2 without the best trade
 * over the last 30) would never pass one. It passes on its whole record instead: 60+ trips, in profit after every cost,
 * and still in profit without its 2 best trips (one lucky coin is not a strategy).
 */
export const RUNNER_MIN = 60;
export const RUNNER_MAX_TRIPS = 120;
export function runnerStat(trips: LTrip[]): LStat {
  const l = liveStat(trips);
  const total = trips.length;
  const totalPnl = trips.reduce((a, t) => a + t.pnl, 0);
  const top = trips.map((t) => t.pnl).sort((a, z) => z - a);
  const lessTop2 = totalPnl - Math.max(0, top[0] ?? 0) - Math.max(0, top[1] ?? 0);
  const passed = total >= RUNNER_MIN && totalPnl > 0 && lessTop2 > 0;
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  return { ...l, passed, pending: !passed && total < RUNNER_MIN && lessTop2 > 0, runner: true, total, totalPnl: r4(totalPnl), lessTop2: r4(lessTop2) };
}

/** The site's summary (once a minute) and the Telegram note when a strategy passes the exam live. */
export async function gridLivePublish(send?: (text: string) => Promise<unknown>) {
  // v0.1.85: an unread book list would publish an empty GRID LIVE (and RESEARCHER would read it): the last view stays
  if (!booksOk && !(await gridLiveLoad(1, 0).catch(() => false))) return;
  const now = Date.now();
  const byKey = new Map<string, LTrip[]>();
  for (const t of TRIPS) (byKey.get(t.k) || byKey.set(t.k, []).get(t.k)!).push(t);
  const books = BOOKS.map((b) => ({ ...b, exitLabel: exitText(b.exit), open: [...POS.values()].filter((p) => p.key === b.key).map((p) => ({ mint: p.mint, symbol: p.symbol, openedAt: p.openedAt, pnlPct: Math.round((p.lastPx / p.fillPx - 1) * 1000) / 10 })), watching: [...PEND.values()].filter((p) => p.key === b.key).length, live: bookStat(b, byKey.get(b.key) || []), total: (byKey.get(b.key) || []).length, fills: fillView(b.key) }));
  // strategies no longer in the books but with a record worth keeping on screen
  const past = [...byKey.entries()].filter(([k]) => !BOOKS.some((b) => b.key === k)).map(([k, ts]) => ({ key: k, live: liveStat(ts) })).filter((x) => x.live.n >= 5).sort((a, b) => b.live.avgPct - a.live.avgPct).slice(0, 6);
  for (const b of books) {
    if (!b.live.passed || !send) continue;
    // v0.1.102: a SEER probation pass has its own mark, so the full pass later still gets its message
    const fresh = await redis().hsetnx(PASSED_KEY, b.live.probation ? `${b.key}#probation` : b.key, { at: now, ...b.live }).catch(() => 0);
    const tp = b.live.totalPnl ?? 0;
    const l2 = b.live.lessTop2 ?? 0;
    if (fresh && b.live.probation) await send(`🔮 <b>GRID LIVE: a SEER strategy passed its probation</b>\n${b.label.replace(/[<>&]/g, " ")}\n${b.exitLabel}\n${b.live.total} trips, ${tp >= 0 ? "+" : ""}${tp} SOL on 0.05 SOL trades, ${l2 >= 0 ? "+" : ""}${l2} SOL without the 2 best.\n\nNext: the desk may follow it at the minimum size until it passes the full exam.`).catch(() => null);
    else if (fresh) await send(`🏁 <b>GRID LIVE: a strategy passed the exam on live coins</b>\n${b.label.replace(/[<>&]/g, " ")}\n${b.exitLabel}\n${b.live.n} trips, ${b.live.winRate}% won, ${b.live.pnl >= 0 ? "+" : ""}${b.live.pnl} SOL on 0.05 SOL trades, PF ${b.live.pfLessBest} without the best.\n\nNext: the desk trades it.`).catch(() => null);
  }
  // v0.1.78: a strategy that passed but whose real fills are too far from paper is not followed, and says so once
  for (const b of books) {
    if (!b.live.passed || !b.fills?.blocked || !send) continue;
    const fresh = await redis().hsetnx(GAPBLOCK_KEY, b.key, { at: now, ...b.fills }).catch(() => 0);
    if (fresh) await send(`⚠️ <b>GRID LIVE: passed on paper, but real fills are too far off</b>\n${b.label.replace(/[<>&]/g, " ")}\nJupiter vs paper: buy ${b.fills.buyGap}% (${b.fills.buyN}), sell ${b.fills.sellGap}% (${b.fills.sellN}).\nThe desk does not follow it.`).catch(() => null);
  }
  if (FILLS.size) await redis().hset(FILLS_KEY, Object.fromEntries(FILLS)).catch(() => null);
  const lead = gridLeader();
  const leadChanged = (lead?.key ?? null) !== LEADER;
  LEADER = lead?.key ?? null;
  const follow = lead ? { key: lead.key, label: lead.label, exit: lead.exit, exitLabel: exitText(lead.exit), live: bookStat(lead, byKey.get(lead.key) || []), at: now } : null;
  if (follow) await redis().set("rn:grid:follow", follow, { ex: 3600 }).catch(() => null);
  else await redis().del("rn:grid:follow").catch(() => null);
  if (leadChanged && send) await send(lead ? `🧭 <b>The desk now follows GRID LIVE's "${lead.label.replace(/[<>&]/g, " ")}"</b>\n${exitText(lead.exit)}\nIts entries go to the desk the moment they fill. Desk mode decides paper or live money.` : "🧭 The desk stopped following GRID LIVE (no passed strategy right now).").catch(() => null);
  refreshCheck();
  const hot = hotBook();
  const view = { at: now, books, past, follow, hot: hot?.key ?? null, gapLimit: GAP_LIMIT * 100, recent: TRIPS.slice(0, 15), trips: TRIPS.length };
  await redis().set(LIVE_VIEW, view, { ex: 2 * 86400 }).catch(() => null);
  return view;
}

// ---------------------------------------------------------------- v0.1.78: real-fill check (Jupiter)

const WSOL = "So11111111111111111111111111111111111111112";
const JUP = process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
const jupHeaders = (): Record<string, string> => (process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {});
/** The books whose fills are checked: the leader, the hot strategy and its family, and any book in profit after 10+ trips. */
const CHECK = new Set<string>();
type Check = { side: "buy" | "sell"; key: string; mint: string; amount: bigint; paper: number };
const QUEUE: Check[] = [];
let checking = false;
let QUOTE: (c: Check) => Promise<number | null> = async (c) => {
  const [inM, outM] = c.side === "buy" ? [WSOL, c.mint] : [c.mint, WSOL];
  const r = await fetch(`${JUP}/quote?inputMint=${inM}&outputMint=${outM}&amount=${c.amount}&slippageBps=2500&restrictIntermediateTokens=true`, { headers: jupHeaders(), cache: "no-store", signal: AbortSignal.timeout(3000) });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    if (/route|liquidity/i.test(txt)) return 0; // a real answer: no way in or out at this size
    return null; // rate limit or outage: not evidence either way
  }
  const q: any = await r.json().catch(() => null);
  if (q?.outAmount == null) return null;
  // buy: tokens received (6 decimals); sell: SOL received
  return c.side === "buy" ? Number(q.outAmount) / 1e6 : Number(q.outAmount) / 1e9;
};
/** Tests: replace the quote source. */
export const _setQuote = (f: (c: Check) => Promise<number | null>) => (QUOTE = f);
function queueCheck(c: Check) {
  if (!(c.paper > 0) || c.amount <= 0n) return;
  QUEUE.push(c);
  if (QUEUE.length > 60) QUEUE.shift();
  if (!checking) void drain();
}
async function drain() {
  checking = true;
  try {
    while (QUEUE.length) {
      const c = QUEUE.shift()!;
      const got = await QUOTE(c).catch(() => null);
      if (got != null) {
        const f = FILLS.get(c.key) || { bn: 0, bg: 0, sn: 0, sg: 0, nr: 0 };
        if (got === 0) f.nr++;
        else {
          const gap = got / c.paper - 1; // below 0: real money gets less than paper
          if (c.side === "buy") (f.bg = (f.bg * f.bn + gap) / (f.bn + 1)), f.bn++;
          else (f.sg = (f.sg * f.sn + gap) / (f.sn + 1)), f.sn++;
        }
        FILLS.set(c.key, f);
      }
      if (QUEUE.length) await new Promise((r) => setTimeout(r, 1_500)); // stay well inside Jupiter's free rate
    }
  } finally {
    checking = false;
  }
}
/** A strategy whose real fills run 10%+ worse than paper over a round trip (8+ checks each way) is not followed. */
export const GAP_LIMIT = -0.1;
export function gapBlock(key: string) {
  const f = FILLS.get(key);
  if (!f || f.bn < 8 || f.sn < 8) return false;
  return f.bg + f.sg <= GAP_LIMIT;
}
const fillView = (key: string) => {
  const f = FILLS.get(key);
  if (!f) return null;
  const r = (x: number) => Math.round(x * 1000) / 10;
  return { buyN: f.bn, buyGap: r(f.bg), sellN: f.sn, sellGap: r(f.sg), noRoute: f.nr, blocked: gapBlock(key) };
};

// ---------------------------------------------------------------- v0.1.78: spawn (variants and every-launch twin)

/** The hot strategy: the best live record that is clearly working but not yet through the exam. */
// ---------------------------------------------------------------- v0.1.108 FLOW EXIT twins
// The learner (lib/flowx.ts) scores every flow exit variant on the latest paper trips of all books. Its picks (or our
// suggestion until the record has enough trips) run for real on twins of the strongest books: the same entries, the
// same exits, plus the flow exit. A twin is a strategy like any other: its own record, its own exam; the desk follows
// one only if it passes. When the learner's picks change, new twins start; a twin of a dropped pick with under 10
// trips makes room.
export const FLOW_MAX = 8;
const FLOW_PARENTS = 4;
export function seedFlow(now: number) {
  const table = learnTable(FLOWX);
  const prev = FLOW_PICKS.picks.join(",");
  FLOW_PICKS = { ...chooseVariants(table), at: now };
  const changed = FLOW_PICKS.picks.join(",") !== prev;
  // twins of a variant the learner no longer picks, still young: they make room
  const stale = BOOKS.filter((b) => b.fv && !FLOW_PICKS.picks.includes(b.fv) && TRIPS.filter((t) => t.k === b.key).length < 10);
  if (stale.length) BOOKS = BOOKS.filter((b) => !stale.includes(b));
  const parents = BOOKS.filter((b) => !b.fv && !b.parent)
    .map((b) => ({ b, s: statOf(b.key) }))
    .filter((x) => x.b.key === LEADER || x.s.n >= 10)
    .sort((a, z) => Number(z.b.key === LEADER) - Number(a.b.key === LEADER) || z.s.pnl - a.s.pnl)
    .slice(0, FLOW_PARENTS);
  const out: LBook[] = [];
  let room = FLOW_MAX - BOOKS.filter((b) => b.fv).length;
  for (const v of FLOW_PICKS.picks)
    for (const { b } of parents) {
      if (room <= 0) break;
      const key = `${b.key}~fx:${v}`;
      if (BOOKS.some((x) => x.key === key)) continue;
      if (dropReason(statOf(key))) continue;
      out.push({ ...b, key, label: `${b.label} + ${variantText(v)}`, fv: v, fxOf: b.key, parent: undefined, back: undefined, since: now });
      room--;
    }
  if (out.length) BOOKS = [...BOOKS, ...out];
  return { added: out, dropped: stale, changed, table: table.slice(0, 5) };
}

export function hotBook(): LBook | null {
  const c = BOOKS.filter((b) => !b.parent && !b.fv && !b.any && !isRunner(b.exit)) // v0.1.89: runners have no exit family
    .map((b) => ({ b, s: statOf(b.key) }))
    .filter((x) => x.s.n >= 12 && x.s.pnl > 0 && x.s.pfLessBest >= 1.2 && x.s.avgPct >= 5)
    .sort((a, z) => z.s.pnl - a.s.pnl);
  return c[0]?.b ?? null;
}
/** The exits one step away from a strategy's exit (one setting changed). */
export function neighborExits(x: GExit): GExit[] {
  const same = (a: GExit, b: GExit) => a.initials === b.initials && a.trail === b.trail && a.stop === b.stop && a.timeMin === b.timeMin && a.mig === b.mig;
  return GEXITS.filter((e) => !same(e, x) && [e.initials !== x.initials, e.trail !== x.trail, e.stop !== x.stop, e.timeMin !== x.timeMin, e.mig !== x.mig].filter(Boolean).length === 1);
}
function spawnOf(hot: LBook, now: number): LBook[] {
  const grid = { ...hot.grid, explore: true };
  const out: LBook[] = [];
  // the twin first: same rule on every launch (only when the filter needs nothing but the curve)
  if (curveOnly(hot.filter) && MODES.find((m) => m.id === hot.mode)?.kind !== "mig") {
    out.push({ key: `any:${hot.key}`, label: `every launch: ${hot.label}`, filter: hot.filter, mode: hot.mode, exit: hot.exit, since: now, grid, any: true, parent: hot.key });
  }
  for (const e of neighborExits(hot.exit)) out.push({ key: keyOf(hot.filter, hot.mode, e), label: hot.label, filter: hot.filter, mode: hot.mode, exit: e, since: now, grid, parent: hot.key });
  return out;
}

/**
 * Every 5 minutes (worker): drop what its live record has ruled out, then give the hot strategy its family: the same
 * rule on every launch, and its exit one setting changed each way. They race to the exam together; the desk follows
 * whichever passes first with the best record. Spawned once per hot strategy, up to SPAWN_MAX books.
 */
export async function gridLiveTend(send?: (text: string) => Promise<unknown>, now = Date.now()) {
  if (!booksOk && !(await gridLiveLoad(1, 0).catch(() => false))) return { dropped: [], added: [], revived: [], hot: null, wait: "books not read from Redis yet" };
  const before = BOOKS.length;
  const dropped = BOOKS.filter((b) => dropReason(statOf(b.key)));
  BOOKS = BOOKS.filter((b) => !dropped.includes(b));
  const revived = reviveBooks(now);
  // v0.1.89: the RUNNER family trades on live coins from the first tend (its own slots)
  const runners = seedRunners(now);
  // v0.1.90: the WALLETS family: proven wallets buying, on every launch (not only King calls)
  const wals = seedWallets(now);
  // v0.1.102: the SEER family: coins on the watchlist before they were launched, bought in their first seconds
  const seers = seedSeer(now);
  // v0.1.110: the SIGNALS family follows GRID's lift table
  const sigs = seedSignals(now);
  if (sigs.length && send) await send(`📡 <b>GRID LIVE: new signals on live coins</b>\n${sigs.map((b) => `• ${b.label.replace(/[<>&]/g, " ")} (${b.why})`).join("\n")}\n\nThe new rules with the best lift in GRID, too young for its top list, now collect their own live record (paper).`).catch(() => null);
  // v0.1.108: the FLOW EXIT twins follow the learner's picks
  const fl = seedFlow(now);
  if ((fl.added.length || fl.changed) && send)
    await send(`🌊 <b>GRID LIVE: flow exit</b>\n${FLOW_PICKS.learned ? "Learned from the record" : "Our starting suggestion (the record needs 30+ trips with the trigger firing 10+ times)"}: ${FLOW_PICKS.picks.map(variantText).join("; ")}\n${fl.table.slice(0, 3).map((s) => `• ${variantText(s.v)}: ${s.uplift >= 0 ? "+" : ""}${s.uplift} pts a trip over ${s.n} trips (fired ${s.fired}, better ${s.better})`).join("\n")}${fl.added.length ? `\n\nNew twins: ${fl.added.map((b) => b.label.replace(/[<>&]/g, " ")).join("; ")}` : ""}`).catch(() => null);
  if (seers.length && send) await send(`🔮 <b>GRID LIVE: SEER family</b>\n${seers.map((b) => `• ${b.label.replace(/[<>&]/g, " ")}\n  ${exitText(b.exit)}`).join("\n")}\n\nCoins SEER put on its watchlist before they existed (events, big posts, trends), bought in their first seconds. Paper on live coins. Probation exam: ${SEER_PROBATION} trips in profit, also without the 2 best, then the desk may follow at the minimum size.`).catch(() => null);
  if (wals.length && send) await send(`👛 <b>GRID LIVE: proven wallets on every launch</b>\n${wals.map((b) => `• ${b.label.replace(/[<>&]/g, " ")}\n  ${exitText(b.exit)}`).join("\n")}\n\nThe moment proven wallets buy a launch (from the firehose, any launch, no King call needed). Paper on live coins.`).catch(() => null);
  if (runners.length && send) await send(`🏃 <b>GRID LIVE: runner mode</b>\n${runners.map((b) => `• ${b.label.replace(/[<>&]/g, " ")}\n  ${exitText(b.exit)}`).join("\n")}\n\nPaper on live coins. The runner exam: ${RUNNER_MIN}+ trips, in profit, and still in profit without its 2 best.`).catch(() => null);
  if (revived.length && send) await send(`♻️ <b>GRID LIVE: back in the race</b>\n${revived.map((b) => { const st = statOf(b.key); return `• ${b.label.replace(/[<>&]/g, " ")}\n  ${exitText(b.exit)}\n  last ${st.n}: ${st.winRate}% won, ${st.pnl >= 0 ? "+" : ""}${st.pnl} SOL, PF ${st.pfLessBest}`; }).join("\n")}\n\nClose to the exam: it keeps trading (up to ${EXTEND_MAX} trips) and passes the moment its last 30 do.`).catch(() => null);
  const hot = hotBook();
  let added: LBook[] = [];
  if (hot && !SPAWNED.includes(hot.key)) {
    const room = SPAWN_MAX - BOOKS.filter((b) => b.parent).length;
    added = spawnOf(hot, now)
      .filter((b) => !BOOKS.some((x) => x.key === b.key) && !dropReason(statOf(b.key)))
      .slice(0, Math.max(0, room));
    if (added.length) {
      BOOKS = [...BOOKS, ...added];
      SPAWNED = [...SPAWNED, hot.key].slice(-50);
      await redis().set(SPAWNED_KEY, SPAWNED).catch(() => null);
      const st = statOf(hot.key);
      if (send) await send(`🧬 <b>GRID LIVE: the hot strategy got its family</b>\n${hot.label.replace(/[<>&]/g, " ")}\n${st.n} trips, ${st.winRate}% won, ${st.pnl >= 0 ? "+" : ""}${st.pnl} SOL, PF ${st.pfLessBest}\n\n${added.map((b) => `• ${b.any ? "same rule on every launch" : exitText(b.exit)}`).join("\n")}\n\nThey race to the exam; the desk follows the first that passes.`).catch(() => null);
    }
  }
  refreshCheck();
  if (dropped.length || added.length || revived.length || runners.length || wals.length || seers.length || sigs.length || fl.added.length || fl.dropped.length || BOOKS.length !== before) await saveBooks();
  return { dropped: dropped.map((b) => ({ key: b.key, why: dropReason(statOf(b.key)) })), added: added.map((b) => b.key), revived: revived.map((b) => b.key), hot: hot?.key ?? null };
}
/**
 * v0.1.82: books dropped at 30 trips before the extension existed, rebuilt from their key (filter, entry and exit are
 * all in it) when their record is close to the exam. Never a twin (its trigger is not in the key), at most 4 at a time.
 * v0.1.85: also a strategy that left with no drop reason and money made (8+ trips, in profit): it was lost, not ruled
 * out (the boot that loaded zero books). Up to REVIVE_MAX of these at once, in their own slots.
 */
export const REVIVE_MAX = 8;
export const REVIVE_MIN_TRIPS = 8;
/** v0.1.85: a record worth bringing back: close to the exam at 30+ trips, or in profit at 8+ with nothing against it. */
export const reviveWorthy = (st: LStat) => !dropReason(st) && (st.n >= 30 || (st.n >= REVIVE_MIN_TRIPS && st.pnl > 0));
export function bookFromKey(key: string, now: number): LBook | null {
  if (key.startsWith("any:")) return null;
  const [filter, mode] = key.split("|");
  const exit = exitOfKey(key);
  const m = MODES.find((x) => x.id === mode);
  if (!filter || !m || !exit) return null;
  const parts = filter === "all" ? [] : filter.split("+");
  const labels = parts.map((id) => PREDS.find((p) => p.id === id)?.label);
  if (labels.some((l) => !l)) return null;
  if (keyOf(filter, mode, exit) !== key) return null;
  return { key, label: `${filter === "all" ? "every call" : labels.join(" + ")}, buy ${m.label}`, filter, mode, exit, since: now, grid: { testN: 0, testAvg: 0, pass: false, explore: true } };
}
function reviveBooks(now: number): LBook[] {
  const byKey = new Map<string, LTrip[]>();
  for (const t of TRIPS) (byKey.get(t.k) || byKey.set(t.k, []).get(t.k)!).push(t);
  const out: LBook[] = [];
  let room = REVIVE_MAX - BOOKS.filter((b) => b.back).length;
  // the best records first (the cap keeps the strongest)
  const cands = [...byKey]
    .filter(([k]) => !BOOKS.some((b) => b.key === k))
    .map(([k, ts]) => ({ b: bookFromKey(k, now), ts }))
    .filter((x): x is { b: LBook; ts: LTrip[] } => !!x.b)
    .map((x) => ({ ...x, st: bookStat(x.b, x.ts) }))
    .filter((x) => reviveWorthy(x.st))
    .sort((a, z) => z.st.pnl - a.st.pnl);
  for (const { b } of cands) {
    if (out.length >= 4 || room <= 0) break;
    b.back = true;
    out.push(b);
    room--;
  }
  if (out.length) BOOKS = [...BOOKS, ...out];
  return out;
}
// v0.1.89: the RUNNER family. The King's BOND call (8.6% of them bond, 4x the base rate), with and without a proven
// wallet, the hot near-migration rule, and a proven wallet with momentum, each with runner exits.
export const RUNNER_MAX = 8;
export const RUNNER_SEEDS: string[] = [
  keyOf("bond", "now", RUNNER_EXITS[0]),
  keyOf("bond", "now", RUNNER_EXITS[1]),
  keyOf("bond+pw1", "now", RUNNER_EXITS[0]),
  keyOf("pw1", "c5", RUNNER_EXITS[0]),
  keyOf("p70+r5", "now", RUNNER_EXITS[0]),
  keyOf("s60", "now", RUNNER_EXITS[2]),
];
// ---------------------------------------------------------------- v0.1.110 SIGNALS family (EVIDENCE SPEED)
// The new rules (origin, attention, SEER, KOL flows, events, themes) have too few calls to make GRID's top list, so
// they would never trade live. Their own slots: after each GRID run, the rules with the best lift (30+ calls, 1.5x+)
// trade on paper, each with a runner exit; rules that need no King call also run on every launch (the moment the coin
// shows the signal), so they collect trips from every launch, not only calls. When one is dropped by its record, the
// next best rule takes the slot. The lift table is read again every GRID run: the family follows the evidence.
export const SIGNAL_MAX = 8;
export const SIGNAL_RULES = ["seer", "seertop", "seerfirst", "first", "alpha", "lowauto", "dexpaid", "boosted", "kol3", "kolsmall", "hold20", "firstpost", "bigfirst", "mediapost", "repeatpost", "meme70", "thanimal", "thpolitical", "thai", "thcelebrity", "thculture", "themehot"];
/** Rules that need no King call (known from the firehose, the indexes and DexScreener on any launch). */
export const SIGNAL_ANY = new Set(["seer", "seertop", "seerfirst", "first", "alpha", "lowauto", "dexpaid", "boosted", "kol3", "kolsmall", "hold20"]);
let SIG_LIFTS: { id: string; calls: number; lift: number }[] = [];
/** After each GRID run (worker): its lift table. */
export const gridLiveSignals = (lifts: { id: string; calls: number; lift: number }[] | null | undefined) => (SIG_LIFTS = (lifts || []).filter((l) => SIGNAL_RULES.includes(l.id)));
let ANY_SX: ((mint: string, now: number) => { sx: Record<string, unknown>; kf?: number | null; kmu?: number | null; kx?: number | null; e20?: number | null } | null) | null = null;
/** v0.1.110: what every-launch books know about a coin without a call (worker: origin, DexScreener, flow). */
export const setAnySignals = (f: typeof ANY_SX) => (ANY_SX = f);
export function seedSignals(now: number): LBook[] {
  const out: LBook[] = [];
  let room = SIGNAL_MAX - BOOKS.filter((b) => b.by === "signals" && !b.fv).length;
  const rules = SIG_LIFTS.filter((l) => l.calls >= 30 && l.lift >= 1.5).sort((a, z) => z.lift - a.lift);
  for (const r of rules) {
    const keys = [keyOf(r.id, "now", RUNNER_EXITS[0]), ...(SIGNAL_ANY.has(r.id) ? [`any:${keyOf(r.id, "now", RUNNER_EXITS[0])}`] : [])];
    for (const k of keys) {
      if (room <= 0) break;
      if (BOOKS.some((b) => b.key === k)) continue;
      const ts = TRIPS.filter((t) => t.k === k);
      const inner = bookFromKey(k.replace(/^any:/, ""), now);
      if (!inner) continue;
      const b: LBook = k.startsWith("any:") ? { ...inner, key: k, label: `every launch: ${inner.label}`, any: true, by: "signals", why: `lift ${r.lift}x on ${r.calls} calls` } : { ...inner, by: "signals", why: `lift ${r.lift}x on ${r.calls} calls` };
      if (ts.length && dropReason(bookStat(b, ts))) continue; // its own record ruled it out
      out.push(b);
      room--;
    }
  }
  if (out.length) BOOKS = [...BOOKS, ...out];
  return out;
}

function seedRunners(now: number): LBook[] {
  const out: LBook[] = [];
  let room = RUNNER_MAX - BOOKS.filter((b) => b.by === "runner" && !b.fv).length;
  for (const k of RUNNER_SEEDS) {
    if (room <= 0) break;
    if (BOOKS.some((b) => b.key === k)) continue;
    const ts = TRIPS.filter((t) => t.k === k);
    if (ts.length && dropReason(runnerStat(ts))) continue; // its own record ruled it out
    const b = bookFromKey(k, now);
    if (!b) continue;
    b.by = "runner";
    out.push(b);
    room--;
  }
  if (out.length) BOOKS = [...BOOKS, ...out];
  return out;
}

// v0.1.90: the WALLETS family. GRID's best explorers all use "a proven wallet bought" (pw1|c5: 63% won, avg +29% on 8
// test trips). These run on every launch the moment the firehose sees proven wallets buy it, with runner and regular
// exits. Own slots, like the runners.
export const WALLETS_MAX = 8;
const REG = { initials: 2, trail: 0.25, stop: 0.25, timeMin: 60, mig: "hold" as const };
export const WALLET_SEEDS: string[] = [
  `any:${keyOf("pw2", "now", RUNNER_EXITS[0])}`,
  `any:${keyOf("pw1+u25", "now", RUNNER_EXITS[0])}`,
  `any:${keyOf("pw1+bs70", "now", RUNNER_EXITS[0])}`,
  `any:${keyOf("pw1", "c5", RUNNER_EXITS[0])}`,
  `any:${keyOf("pw2", "now", REG)}`,
  `any:${keyOf("pw1+u25", "now", REG)}`,
];
function seedWallets(now: number): LBook[] {
  const out: LBook[] = [];
  let room = WALLETS_MAX - BOOKS.filter((b) => b.by === "wallets" && !b.fv).length;
  for (const k of WALLET_SEEDS) {
    if (room <= 0) break;
    if (BOOKS.some((b) => b.key === k)) continue;
    const inner = bookFromKey(k.replace(/^any:/, ""), now);
    if (!inner) continue;
    const b: LBook = { ...inner, key: k, label: `every launch: ${inner.label}`, any: true, by: "wallets" };
    const ts = TRIPS.filter((t) => t.k === k);
    if (ts.length && dropReason(bookStat(b, ts))) continue; // its own record ruled it out
    out.push(b);
    room--;
  }
  if (out.length) BOOKS = [...BOOKS, ...out];
  return out;
}

function refreshCheck() {
  CHECK.clear();
  const hot = hotBook();
  for (const b of BOOKS) {
    const st = statOf(b.key);
    if (b.key === LEADER || b.key === hot?.key || b.parent || (st.n >= 10 && st.pnl > 0)) CHECK.add(b.key);
  }
}

// ---------------------------------------------------------------- v0.1.82: RESEARCHER's books
export const RESEARCH_MAX = 4;
/** Books RESEARCHER may still add, and whether a key may be added (not trading now, not ruled out by its record). */
export const researchRoom = () => Math.max(0, RESEARCH_MAX - BOOKS.filter((b) => b.by === "researcher" && !b.fv).length);
export function researchOk(key: string) {
  if (BOOKS.some((b) => b.key === key)) return "already trading";
  const ts = TRIPS.filter((t) => t.k === key);
  if (ts.length) {
    const why = dropReason(bookStat({ grid: { testN: 0, testAvg: 0, pass: false, explore: true } }, ts));
    if (why) return `its live record ruled it out (${why})`;
  }
  return null;
}
/** Add RESEARCHER's strategies as exploring books (45+ trips and positive overall to pass, like GRID's explorers). */
export async function gridLiveAddResearch(add: { filter: string; mode: string; exit: GExit; label: string; why: string }[], now = Date.now()) {
  const out: LBook[] = [];
  for (const a of add) {
    if (out.length >= researchRoom()) break;
    const key = keyOf(a.filter, a.mode, a.exit);
    if (researchOk(key) || out.some((b) => b.key === key)) continue;
    out.push({ key, label: a.label, filter: a.filter, mode: a.mode, exit: a.exit, since: now, grid: { testN: 0, testAvg: 0, pass: false, explore: true }, by: "researcher", why: a.why.slice(0, 280) });
  }
  if (out.length) {
    BOOKS = [...BOOKS, ...out];
    refreshCheck();
    await saveBooks();
  }
  return out;
}

/** Tests: reset the memory. */
export function gridLiveReset() {
  BOOKS = [];
  PEND.clear();
  POS.clear();
  LAST.clear();
  HIST.clear();
  TRIPS = [];
  FILLS.clear();
  TRIG.clear();
  CHECK.clear();
  QUEUE.length = 0;
  SPAWNED = [];
  LEADER = null;
  FLOWX = [];
  FLOW_PICKS = { picks: [FLOW_SEED], learned: false, at: 0 };
  loaded = true;
  booksOk = true;
}
/** Tests: a worker that has just booted (nothing read from Redis yet). */
export function _gridLiveUnload() {
  gridLiveReset();
  loaded = false;
  booksOk = false;
}
export const gridLiveState = () => ({ pend: PEND, pos: POS, trips: TRIPS, fills: FILLS, check: CHECK, queue: QUEUE });
/** Tests: set the books directly. */
export const _setBooks = (b: LBook[]) => (BOOKS = b);
export const _setTrips = (t: LTrip[]) => (TRIPS = t);
