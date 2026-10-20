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
import { HORIZONS, tickReady } from "./tick";
import { redis } from "./redis";
import { archiveTrip } from "./archive";
import { BAG_HOURS, BAG_IDS, bagOf, ladderStudy, newShadows, rideTick, ridingBag, shadowClose, shadowTick, type Shadow } from "./ladder";
import { setClassPaper } from "./classgate";
import { ATA_RENT, sellProceeds, slipOf, txCost, venueFee, type CostCfg } from "./costs";
import { SITE } from "@/config/site";
import { GEXITS, GRID_SOL, HOLD_MS, MODES, PREDS, RUNNER_EXITS, exitOfPart, scoreModel, profitModel, winModel, withScoreModels, asModels, type Models, exitText, firstSell, holdMax, isRunner, keyOf, type GCoin, type GExit, type GRow } from "./grid";

const D = (SITE as any).desk || {};
// v0.1.96: the priority fee paper pays is what live transactions paid (lib/livecost.ts), the setting until there are 10
const COST: CostCfg = { jitoTipMinSol: D.jitoTipMinSol, jitoTipMaxSol: D.jitoTipMaxSol, get paperPrioritySol() { return paperPriority(D.paperPrioritySol); } };
export const LIVE_MAX_BOOKS = 16; // v0.1.73: 8 to 16 (paper costs nothing; more books in parallel = records sooner)
const MAX_OPEN = 10; // per book
const MAX_OPEN_ANY = 25; // v0.1.78: a twin on every launch sees many more entries (and holds up to 6h)
const MAX_OPEN_RUN = 40; // v0.1.89: runners hold up to 24h (most coins hit the stop within the hour)
const MAX_OPEN_TICK = 40; // v0.1.120: TICK books make many small bets
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
// v0.1.126 RUG GUARD: what a coin looked like at the moment a paper position opened (age since launch in seconds, dev
// buy in SOL, buyers and buy share of the last minute, whale buys, dev sold, origin rank: 1 = the original name)
export type EntryF = {
  age: number | null;
  dev: number | null;
  u60: number | null;
  bs60: number | null;
  wh: number | null;
  ds: boolean | null;
  og: number | null;
  // v0.1.128 (lib/smartbuy.ts): FOMO crowd, earners and proven wallets in the last minute, crews counted once
  fc?: number | null;
  ea?: number | null;
  pwi?: number | null;
  pwr?: number | null;
  bt?: number | null; // v0.1.130: bots (30+ round trips a day) that bought in the last minute
  fr?: number | null; // v0.1.132: callout front-runners that bought in the last minute
  fm?: number | null; // v0.1.132: FOMO retail money now vs its 6-hour average (1 = normal)
};
let ENTRY_FX: ((mint: string, now: number) => EntryF | null) | null = null;
export const setEntryFeatures = (f: typeof ENTRY_FX) => (ENTRY_FX = f);
const entryNow = (mint: string, now: number) => {
  try {
    return ENTRY_FX ? ENTRY_FX(mint, now) : null;
  } catch {
    return null;
  }
};
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
  by?: "researcher" | "runner" | "wallets" | "seer" | "signals" | "score" | "early" | "tick" | "smart";
  /** v0.1.115: an EARLY book: trades the 2-minute read of every launch (lib/early.ts), never a King call */
  early?: boolean;
  /** v0.1.117: the reading age it trades (seconds; 120 when not set) */
  earlySec?: number;
  /** v0.1.120 NO QUICK KILLS: its record says drop, but it is younger than BOOK_KEEP_DAYS: it keeps trading on paper (outside the slot counts) until then */
  cold?: { at: number; why: string; room?: boolean } | null;
  /** v0.1.120 TICK: a TICK MODEL book (horizon minutes, margin over cost) */
  tick?: { h: number; m: number };
  why?: string;
  /** v0.1.85: brought back by its own live record (reviveBooks); its own slots, outside GRID's 16 */
  back?: boolean;
  /** v0.1.108 FLOW EXIT twin: the same strategy as `fxOf`, plus this flow exit variant (lib/flowx.ts) */
  fv?: string;
  fxOf?: string;
};
type Pend = { key: string; mint: string; symbol: string; callAt: number; p0: number; px0: number; until: number; fillAfter: number | null; mult?: number; sent?: number };
export type LPos = { key: string; mint: string; symbol: string; openedAt: number; fillPx: number; tokens: number; cost: number; back: number; peak: number; initials: boolean; tEnd: number; lastPx: number; lastReal: number; pool?: boolean; sender?: boolean; f0?: { kx: number | null; e20: number | null } | null; fx?: { at: number; pct: number; why: string } | null; fl?: Partial<Record<Trig, number>>; fd?: boolean; ef?: EntryF | null; sh?: Record<string, Shadow> };
export type LTrip = { k: string; mint: string; symbol: string; openedAt: number; closedAt: number; pnl: number; pnlPct: number; why: string; ef?: EntryF | null; rug?: boolean; sh?: Record<string, number>; mc0?: number; pk?: number };

let BOOKS: LBook[] = [];
const PEND = new Map<string, Pend>(); // key|mint
const POS = new Map<string, LPos>(); // key|mint
const LAST = new Map<string, { at: number; px: number; real: number; p: number; done: boolean; pool?: boolean }>();
const HIST = new Map<string, { t: number; p: number }[]>(); // curve % over the last 3 minutes (curve speed)
let TRIPS: LTrip[] = [];
// v0.1.75: FOLLOW. The leader (the best strategy that passed the exam live) hands every entry to the desk
type FollowOrder = { key: string; label: string; exit: GExit; mint: string; symbol: string; at: number; pool: boolean; early?: boolean; xp?: "book" | "desk"; pcts?: number[]; probation?: boolean; fv?: string; mult?: number; px0?: number; rug?: string };
let FOLLOW: ((o: FollowOrder) => void) | null = null;
export const setGridFollow = (f: ((o: FollowOrder) => void) | null) => (FOLLOW = f);
let LEADER: string | null = null;
// v0.1.123 RUNNER HOLD (Stan, 19 Oct: "it's there for a reason, listen to the agents"): a runner book that once passed
// its full exam keeps being followed at the minimum size while its whole record stays in profit. It is dropped only when
// that total goes negative (the full pass also needs it in profit without its 2 best; a hold does not)
const EVER = new Set<string>();
// v0.1.130 CLASS GATE: the paper trips of the strategies the desk follows (ever passed, or leading now)
setClassPaper(() => TRIPS.filter((t) => t.sh && (EVER.has(t.k) || t.k === LEADER || LEADERS.has(t.k))));
export const HOLD_FLOOR = () => {
  const v = Number(process.env.HOLD_FLOOR ?? 0.1);
  return Number.isFinite(v) ? v : 0.1;
};
export const _setEver = (keys: string[]) => (EVER.clear(), keys.forEach((k) => EVER.add(k)));
export const gridLeaderKey = () => LEADER;
/** The strategy the desk follows: passed live (bookStat), best live P&L first. */
// v0.1.132 FOLLOW 3: the desk follows the best FOLLOW_N strategies at once, ranked on their whole record without its
// 2 best trips (lessTop2), full passes before probation and holds. A strategy whose record is negative without its 2
// best never leads (20 Oct: the desk followed pw1|c5 at -0.064 SOL without its 2 best while 3 passed books were
// above +0.2). More trades in proven setups means the bank compounds faster.
export const FOLLOW_N = () => Math.max(1, Math.min(5, Number(process.env.GRID_FOLLOW_N ?? 3) || 3));
let LEADERS = new Set<string>();
export const gridLeaderKeys = () => [...LEADERS];
export function gridLeaders(n = FOLLOW_N()): LBook[] {
  return BOOKS.map((b) => ({ b, s: bookStat(b, TRIPS.filter((t) => t.k === b.key)) }))
    .filter((x) => x.s.passed && !gapBlock(x.b.key) && (x.s.lessTop2 ?? x.s.pnl) > 0)
    // v0.1.135: ranked by the record after the real gap (what real money would have made), when one is measured
    .map((x) => ({ ...x, e: edgeOf(x.b.key).lessTop2, m: edgeAdj(x.b.key).src !== "none" }))
    .sort((a, z) => Number(!!a.s.probation) - Number(!!z.s.probation) || (z.m ? z.e : (z.s.lessTop2 ?? z.s.pnl)) - (a.m ? a.e : (a.s.lessTop2 ?? a.s.pnl)))
    .slice(0, n)
    .map((x) => x.b);
}
export function gridLeader(): LBook | null {
  const passed = BOOKS.map((b) => ({ b, s: bookStat(b, TRIPS.filter((t) => t.k === b.key)) }))
    .filter((x) => x.s.passed && !gapBlock(x.b.key))
    .sort((a, z) => Number(!!a.s.probation) - Number(!!z.s.probation) || z.s.pnl - a.s.pnl); // v0.1.102: a full pass leads a SEER probation
  return passed[0]?.b ?? null;
}
let loaded = false;
// v0.1.78: real-fill check. Jupiter (the route live money takes, tawtis' point on Reels: not PumpSwap directly) quoted
// at every paper fill of the strategies that matter, so the gap between paper and real is measured before money moves.
type Fill = { bn: number; bg: number; sn: number; sg: number; nr: number; v?: number; lag?: number };
// v0.1.118: fill checks before this build compared a delayed quote with the fill-time price (see drain): dropped once
const FILL_V = 118;
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
    const [b, pos, trips, fills, sp, fxs, ever] = await Promise.all([
      tryRead(() => r.get<LBook[]>(BOOKS_KEY)),
      r.hgetall<Record<string, LPos>>(POS_KEY).catch(() => null),
      tryRead(() => r.lrange<LTrip>(LIVE_TRIPS, 0, TRIPS_MAX - 1)),
      r.hgetall<Record<string, Fill>>(FILLS_KEY).catch(() => null),
      r.get<string[]>(SPAWNED_KEY).catch(() => null),
      r.lrange<FlowX>(FLOWX_KEY, 0, 1999).catch(() => null), // v0.1.108: the learner's record survives a restart
      r.hgetall<Record<string, unknown>>(PASSED_KEY).catch(() => null), // v0.1.123: every full pass on record (RUNNER HOLD)
    ]);
    if (b === FAIL || trips === FAIL) continue;
    loaded = true;
    booksOk = true;
    for (const [k, f0] of Object.entries(fills || {})) {
      const f = f0 as Fill;
      if (!f || typeof f !== "object") continue;
      if (f.v === FILL_V) FILLS.set(k, f);
      // a strategy the old check blocked stays blocked until the new check has its 8 quotes each way
      else if (f.bn >= 8 && f.sn >= 8 && f.bg + f.sg <= GAP_LIMIT) RECHECK.add(k);
    }
    SPAWNED = Array.isArray(sp) ? sp : SPAWNED;
    for (const k of Object.keys(ever || {})) if (!k.endsWith("#probation")) EVER.add(k);
    if (Array.isArray(fxs) && !FLOWX.length) FLOWX = (fxs as FlowX[]).filter(Boolean);
    // books added while the read was failing (a GRID run, RESEARCHER) join the saved ones instead of replacing them
    const saved = Array.isArray(b) ? (b as LBook[]) : [];
    BOOKS = [...saved, ...BOOKS.filter((x) => !saved.some((y) => y.key === x.key))];
    for (const [k, p] of Object.entries(pos || {})) if (p && typeof p === "object" && !POS.has(k)) POS.set(k, p as LPos);
    const got = ((trips || []) as LTrip[]).filter(Boolean);
    const seen = new Set(got.map((g) => `${g.k}|${g.mint}|${g.closedAt}`));
    TRIPS = keepTrips([...TRIPS.filter((t) => !seen.has(`${t.k}|${t.mint}|${t.closedAt}`)), ...got]);
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
/**
 * v0.1.120 NO QUICK KILLS (Stan, 17 Oct): a strategy is not thrown out after an hour or a day of bad trips; narratives
 * fade, strategies need time. A book whose record says drop but that is younger than BOOK_KEEP_DAYS (default 7) turns
 * COLD: it keeps trading on paper, outside every family's slot count (new candidates still get their slots), and turns
 * warm again the moment its record recovers. Only after BOOK_KEEP_DAYS is it removed (its trips stay, a revive can bring
 * it back). Live money was never the question: the desk only follows strategies that pass the exam.
 */
export const KEEP_MS = () => Math.max(0, Number(process.env.BOOK_KEEP_DAYS ?? 7) || 0) * 86400_000;
export const COLD_MAX = () => Math.max(0, Number(process.env.COLD_MAX ?? 250) || 0);
const young = (b: Pick<LBook, "since">, now: number) => now - (Number(b.since) || 0) < KEEP_MS();
/** Sort the books: what to drop (old and ruled out), what goes cold (young and ruled out), what warms up again. */
function coolOff(now: number) {
  const out: LBook[] = [];
  for (const b of BOOKS) {
    const why = dropReason(statOf(b.key));
    if (!why) {
      // v0.1.123: a book benched to make room for a passed one stays cold (paper) until a slot frees or it passes
      if (b.cold && !b.cold.room) b.cold = null;
      continue;
    }
    if (young(b, now)) {
      if (!b.cold) b.cold = { at: now, why };
    } else out.push(b);
  }
  // past COLD_MAX cold books, the ones cold the longest go first
  const cold = BOOKS.filter((b) => b.cold && !out.includes(b)).sort((a, z) => a.cold!.at - z.cold!.at);
  for (const b of cold.slice(0, Math.max(0, cold.length - COLD_MAX()))) out.push(b);
  return out;
}
/**
 * v0.1.123: make room for passed rows. The weakest warm books that never passed (lowest total on their record) go cold:
 * they keep trading on paper, nothing is deleted. Returns how many slots were freed.
 */
export function benchForRoom(pool: LBook[], need: number, now: number): number {
  const cands = pool
    .filter((b) => !b.cold && !b.grid?.pass)
    .map((b) => ({ b, s: statOf(b.key) }))
    .filter((x) => !x.s.passed)
    .sort((a, z) => (a.s.totalPnl ?? a.s.pnl ?? 0) - (z.s.totalPnl ?? z.s.pnl ?? 0));
  let n = 0;
  for (const { b } of cands) {
    if (n >= need) break;
    b.cold = { at: now, why: "benched: its slot went to a strategy that passed", room: true };
    n++;
  }
  return n;
}
/** v0.1.82: near the exam on its last 30 trips: worth more trips (a rolling window, the next trades can pass it). */
export const closeToPass = (l: LStat) => l.winRate >= 40 && l.pnl > 0 && l.pfLessBest >= 1.0;
const statOf = (key: string) => bookStat(BOOKS.find((b) => b.key === key) ?? { grid: { testN: 0, testAvg: 0, pass: false } }, TRIPS.filter((t) => t.k === key));

export async function gridLiveSetBooks(rows: GRow[], now = Date.now()) {
  if (!booksOk) await gridLiveLoad(1, 0).catch(() => false); // v0.1.85: never decide on a list that was not read
  const out = coolOff(now); // v0.1.120: young ruled-out books go cold, they are not dropped
  const keep = BOOKS.filter((b) => !out.includes(b));
  const dropped = out.map((b) => ({ key: b.key, why: dropReason(statOf(b.key)) }));
  const cand = rows
    .filter((r) => !keep.some((b) => b.key === r.key))
    // never bring back a strategy its own live record already ruled out
    .filter((r) => !dropReason(statOf(r.key)));
  // v0.1.78: spawned books (variants, twins) have their own slots on top of GRID's 16 (v0.1.82: RESEARCHER's too)
  const base = keep.filter((b) => !b.cold && !b.parent && !b.by && !b.back && !b.fv);
  let room = Math.max(0, LIVE_MAX_BOOKS - base.length);
  // v0.1.123: a row that passed GRID always gets a book. With the slots full, the weakest book that never passed goes cold
  const passedN = cand.filter((r) => r.pass).length;
  if (passedN > room) room += benchForRoom(base, passedN - room, now);
  const fresh = [...cand.filter((r) => r.pass), ...cand.filter((r) => !r.pass)]
    .slice(0, room)
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
// v0.1.120: rules by id (cold books keep trading, so more books read every curve update: no linear search per rule)
let PRED_BY: Map<string, (typeof PREDS)[number]> | null = null;
const predOf = (id: string) => (PRED_BY ??= new Map(PREDS.map((p) => [p.id, p]))).get(id);
const filterOk = (filter: string, c: GCoin) => filter === "all" || filter.split("+").every((id) => predOf(id)?.ok(c) ?? false);
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
    if (b.any || b.early || b.tick) continue; // twins trigger on the curve itself (gridLiveCurve); EARLY books on the 2-minute read; TICK books on the model
    if (PEND.has(id(b.key, mint)) || POS.has(id(b.key, mint))) continue;
    if (!filterOk(b.filter, c)) continue;
    const m = MODES.find((x) => x.id === b.mode);
    if (!m) continue;
    PEND.set(id(b.key, mint), { key: b.key, mint, symbol: c.symbol, callAt: now, p0: last.p, px0: last.px, until: now + Math.max(30_000, m.win * 60_000), fillAfter: m.kind === "now" ? now + 2_000 : null });
    earlyFollow(b, PEND.get(id(b.key, mint)), now); // v0.1.138b
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
    earlyFollow(b, PEND.get(k), now); // v0.1.138b
  }
}
// v0.1.132 SMART family: callout front-runners, the FOMO crowd arriving, a running story. Each signal arrives with the
// coin (worker: lib/frontrun.ts, lib/smartbuy.ts, lib/origin.ts); the books buy on paper at the next price and the
// exam decides, like every other family. A signal before the coin has a price waits for its first one (2 minutes).
const SMART_SX = new Map<string, { fr?: number; fc?: number; st?: number; at: number }>();
const SMART_Q = new Map<string, number>();
// v0.1.137 BAG STUDY. Does keeping a bag pay? Every paper trip of a strategy the desk follows (or followed) runs the
// desk's ladder with a 10/20/30% bag as shadows (lib/ladder.ts). When the strategy closes, a bag whose ladder steps
// all sold keeps riding: 50% trail off the peak, up to 24 hours after the buy, on the coin's live price (curve, then
// pool). Each trip's result is recorded once every bag has settled, next to the desk's ladder on the same trip, so the
// study compares like with like on every trip (not only the coins that ran).
type Ride = { k: string; mint: string; fill: number; peak: number; last: number; until: number; opened: number; closedAt: number; mc0?: number; desk: number | null; done: Record<string, number>; open: Record<string, Shadow> };
export type BagTrip = { k: string; mint: string; closedAt: number; mc0?: number; desk: number; bags: Record<string, number> };
const RIDES = new Map<string, Ride>(); // key|mint
let BAGX: BagTrip[] = [];
const RIDES_KEY = "rn:bag:rides";
const BAGX_KEY = "rn:bag:trips";
export const RIDES_MAX = 4000;
const bagEligible = (k: string) => EVER.has(k) || k === LEADER || LEADERS.has(k);
function bagStart(pos: LPos, t: LTrip, now: number) {
  if (typeof t.sh?.desk !== "number") return;
  const done: Record<string, number> = {};
  const open: Record<string, Shadow> = {};
  for (const id of BAG_IDS) {
    const st = pos.sh?.[id];
    if (!st) continue;
    if (ridingBag(id, st)) open[id] = { ...st };
    else if (typeof t.sh?.[id] === "number") done[id] = t.sh[id];
  }
  const r: Ride = { k: pos.key, mint: pos.mint, fill: pos.fillPx, peak: pos.peak, last: pos.lastPx, until: pos.openedAt + BAG_HOURS * 3600_000, opened: pos.openedAt, closedAt: now, mc0: t.mc0, desk: t.sh.desk, done, open };
  if (!Object.keys(open).length) return bagFinish(r);
  if (RIDES.size >= RIDES_MAX) return; // full: this trip is left out of the study (both sides), not counted as a loss
  RIDES.set(`${pos.key}|${pos.mint}`, r);
}
function bagFinish(r: Ride) {
  if (r.desk == null || BAG_IDS.some((id) => typeof r.done[id] !== "number")) return;
  BAGX = [{ k: r.k, mint: r.mint, closedAt: r.closedAt, mc0: r.mc0, desk: r.desk, bags: r.done }, ...BAGX].slice(0, 3000);
  BAG_DIRTY = true;
}
let BAG_DIRTY = false;
function rideStep(mint: string, px: number, now: number) {
  for (const [key, r] of RIDES) {
    if (r.mint !== mint || !(r.fill > 0)) continue;
    r.last = px;
    r.peak = Math.max(r.peak, px);
    const xr = px / r.fill;
    for (const [id, st] of Object.entries(r.open)) {
      if (rideTick(st, xr, r.peak / r.fill)) {
        r.done[id] = Math.round(st.g * 1000) / 1000;
        delete r.open[id];
      }
    }
    if (!Object.keys(r.open).length || now >= r.until) rideEnd(key, r);
  }
}
function rideEnd(key: string, r: Ride) {
  const xr = r.last / r.fill;
  for (const [id, st] of Object.entries(r.open)) r.done[id] = Math.round((st.g + (1 - st.s) * xr) * 1000) / 1000;
  r.open = {};
  RIDES.delete(key);
  bagFinish(r);
}
/** Every sweep: bags past their 24 hours are sold at their last price (a coin that stopped trading included). */
export function rideSweep(now = Date.now()) {
  for (const [key, r] of RIDES) if (now >= r.until) rideEnd(key, r);
}
export const BAG_MIN = 60;
let LADDER_VIEW: ReturnType<typeof ladderStudy> | null = null;
/** Per bag: average % a trip vs the desk's ladder on the same trips, older 70% / newest 30%. The pick beats the
 *  desk's ladder on both halves (60+ trips); BAG_MODE (off, auto, 10, 20, 30) can override. */
export function bagStudy() {
  const xs = [...BAGX].sort((a, z) => a.closedAt - z.closedAt);
  const cut = Math.floor(xs.length * 0.7);
  const avg = (a: BagTrip[], f: (t: BagTrip) => number) => (a.length ? Math.round((a.reduce((s, t) => s + f(t), 0) / a.length - 1) * 1000) / 10 : null);
  const desk = { all: avg(xs, (t) => t.desk), old: avg(xs.slice(0, cut), (t) => t.desk), new: avg(xs.slice(cut), (t) => t.desk) };
  const rows = BAG_IDS.map((id) => ({ id, bag: bagOf(id)!, all: avg(xs, (t) => t.bags[id]), old: avg(xs.slice(0, cut), (t) => t.bags[id]), new: avg(xs.slice(cut), (t) => t.bags[id]), ran: xs.filter((t) => t.bags[id] > t.desk + 0.05).length }));
  const best = xs.length >= BAG_MIN ? rows.filter((r) => r.old! > desk.old! && r.new! > desk.new!).sort((a, z) => z.all! - a.all!)[0] ?? null : null;
  return { n: xs.length, riding: RIDES.size, desk, rows, best: best?.id ?? null };
}
/** The bag the live desk keeps (share of the position), or null for none. */
export function bagPick(): number | null {
  const m = String(process.env.BAG_MODE ?? "auto").trim().toLowerCase();
  if (m === "off" || m === "0") return null;
  if (/^\d+$/.test(m)) {
    const v = Number(m) / 100;
    return v > 0 && v < 1 ? v : null;
  }
  const b = bagStudy().best;
  return b ? bagOf(b) : null;
}
export async function bagLoad() {
  const r = redis();
  const [rides, trips] = await Promise.all([r.get<Ride[]>(RIDES_KEY).catch(() => null), r.get<BagTrip[]>(BAGX_KEY).catch(() => null)]);
  for (const x of rides || []) if (x?.k && x.mint) RIDES.set(`${x.k}|${x.mint}`, x);
  if (trips?.length) BAGX = trips;
  return { rides: RIDES.size, trips: BAGX.length };
}
export async function bagSave(force = false) {
  const r = redis();
  await r.set(RIDES_KEY, [...RIDES.values()].slice(0, RIDES_MAX), { ex: 2 * 86400 }).catch(() => null);
  if (BAG_DIRTY || force) {
    BAG_DIRTY = false;
    await r.set(BAGX_KEY, BAGX, { ex: 14 * 86400 }).catch(() => null);
  }
}
export const _bagReset = () => (RIDES.clear(), (BAGX = []), (BAG_DIRTY = false));
export const _bagState = () => ({ rides: RIDES, trips: BAGX });
export const _bagStart = (pos: LPos, t: LTrip, now: number) => bagStart(pos, t, now);
export const _setBagTrips = (xs: BagTrip[]) => (BAGX = xs);

/** v0.1.133 RAT KING CHECK: the coin's last curve read and the paper books holding it right now. */
export function gridLiveHolding(mint: string) {
  const l = LAST.get(mint);
  const keys = [...POS.values()].filter((p) => p.mint === mint).map((p) => p.key);
  return { px: l?.px ?? null, p: l?.p ?? null, done: !!l?.done, pool: !!l?.pool, at: l?.at ?? null, books: keys.length, passed: keys.filter((k) => LEADERS.has(k) || k === LEADER).length };
}
export const smartLiveStats = { signals: 0, fired: 0 };
export function gridLiveSmart(mint: string, sx: { fr?: number; fc?: number; st?: number }, now = Date.now()) {
  const prev = SMART_SX.get(mint);
  SMART_SX.set(mint, { ...(prev && now - prev.at < 600_000 ? prev : {}), ...sx, at: now });
  if (SMART_SX.size > 5000) SMART_SX.delete(SMART_SX.keys().next().value as string);
  smartLiveStats.signals++;
  const last = LAST.get(mint);
  if (last && last.px > 0 && !last.done) return smartFire(mint, last.p, last.px, now);
  SMART_Q.set(mint, now);
  if (SMART_Q.size > 2000) SMART_Q.delete(SMART_Q.keys().next().value as string);
}
function smartFire(mint: string, p: number, px: number, now: number) {
  SMART_Q.delete(mint);
  const sm = SMART_SX.get(mint);
  if (!sm || now - sm.at > 120_000) return;
  const fx = LIVE_FX ? LIVE_FX(mint) : null;
  const c = { mint, symbol: "", at: now, createdAt: now, verdict: "", score: 0, nano: null, progress: p, rise60: 0, uniq: null, spb: null, bs: null, sn: null, sm: 0, ds: !!fx?.ds, soc: 0, pw: fx?.pw ?? null, u60: fx?.u60 ?? null, bs60: fx?.bs60 ?? null, wh: fx?.wh ?? null, sx: { fr: sm.fr ?? null, fc: sm.fc ?? null, st: sm.st ?? null } } as unknown as GCoin;
  for (const b of BOOKS) {
    if (!b.any || b.by !== "smart") continue;
    const k = id(b.key, mint);
    if (TRIG.has(k) || PEND.has(k) || POS.has(k)) continue;
    if (!filterOk(b.filter, c)) continue;
    const m = MODES.find((x) => x.id === b.mode);
    if (!m || m.kind === "mig") continue;
    TRIG.add(k);
    smartLiveStats.fired++;
    PEND.set(k, { key: b.key, mint, symbol: SYM.get(mint) || mint.slice(0, 4), callAt: now, p0: p, px0: px, until: now + Math.max(30_000, m.win * 60_000), fillAfter: m.kind === "now" ? now + 2_000 : null });
    earlyFollow(b, PEND.get(k), now); // v0.1.138b
  }
}
export const SMART_MAX = 6;
export const SMART_SEEDS: string[] = [
  `any:${keyOf("front", "now", RUNNER_EXITS[0])}`,
  `any:${keyOf("front2", "now", RUNNER_EXITS[0])}`,
  `any:${keyOf("front", "now", { initials: 2, trail: 0.25, stop: 0.25, timeMin: 30, mig: "hold" })}`,
  `any:${keyOf("fomohot", "now", RUNNER_EXITS[0])}`,
  `any:${keyOf("story", "now", RUNNER_EXITS[0])}`,
  `any:${keyOf("story+first", "now", RUNNER_EXITS[0])}`,
];
function seedSmart(now: number): LBook[] {
  const out: LBook[] = [];
  let room = SMART_MAX - BOOKS.filter((b) => !b.cold && b.by === "smart" && !b.fv).length;
  for (const k of SMART_SEEDS) {
    if (room <= 0) break;
    if (BOOKS.some((b) => b.key === k)) continue;
    const inner = bookFromKey(k.replace(/^any:/, ""), now);
    if (!inner) continue;
    const b: LBook = { ...inner, key: k, label: `every launch: ${inner.label}`, any: true, by: "smart" };
    const ts = TRIPS.filter((t) => t.k === k);
    if (ts.length && dropReason(bookStat(b, ts))) continue;
    out.push(b);
    room--;
  }
  if (out.length) BOOKS = [...BOOKS, ...out];
  return out;
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
  let room = SEER_MAX - BOOKS.filter((b) => !b.cold && b.by === "seer" && !b.fv).length;
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
  if (SMART_Q.has(mint) && px > 0 && !v.complete) smartFire(mint, p, px, now); // v0.1.132
  if (RIDES.size && px > 0) rideStep(mint, px / 1e9, now); // v0.1.137 bags riding after their strategy closed
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
    earlyFollow(b, PEND.get(k), now); // v0.1.138b
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
    earlyFollow(b, pe, now); // v0.1.138b: the signal is now
    return;
  }
  const capOf = () => capOfBook(b);
  earlyFollow(b, pe, now);
  if (now < pe.fillAfter) return;
  PEND.delete(k);
  const open = [...POS.values()].filter((p) => p.key === b.key).length;
  if (open >= capOf()) return;
  const px0 = last.px / 1e9;
  if (!(px0 > 0)) return;
  const sol = GRID_SOL;
  const inPool = !!last.pool;
  const fillPx = px0 * (1 + slipOf(sol, inPool, last.real));
  const pos: LPos = { key: b.key, mint: pe.mint, symbol: pe.symbol, openedAt: now, fillPx, tokens: (sol * (1 - venueFee(inPool, last.px))) / fillPx, cost: sol + txCost(sol, COST) + ATA_RENT, back: 0, peak: px0, initials: false, tEnd: now + b.exit.timeMin * 60_000, lastPx: px0, lastReal: last.real, pool: inPool, f0: flowNow(pe.mint), ef: entryNow(pe.mint, now) };
  POS.set(k, pos);
  redis().hset(POS_KEY, { [k]: pos }).catch(() => null);
  if (CHECK.has(b.key)) queueCheck({ side: "buy", key: b.key, mint: pe.mint, amount: BigInt(Math.round(sol * 1e9)), paper: pos.tokens, sol, at: now });
  if (!pe.sent && followed(b.key)) emitFollow(b, pe, px0, inPool, rugBlock(pos.ef) ?? undefined, now, false);
}
const followed = (k: string) => !!FOLLOW && (LEADERS.size ? LEADERS.has(k) : LEADER === k);
const capOfBook = (b: LBook) => (b.tick ? MAX_OPEN_TICK : b.any || b.early ? MAX_OPEN_ANY : isRunner(b.exit) ? MAX_OPEN_RUN : MAX_OPEN);
// v0.1.138 FAST FILL: the paper fills 2 seconds after the signal (its model of a real buy's delay). The live desk gets
// the order AT the signal, so its real buy lands about when the paper fills, not 2 seconds plus a desk beat later
// (20 Oct overnight: 48 of 79 live stops came within 10 seconds of the buy: the desk bought the top of the burst).
// v0.1.138b: armed where the entry is created (and where a climb or dip fires), not on the coin's next price tick: on a
// quiet coin that tick came after the paper fill and no order went out early (first 3 orders after the deploy)
function earlyFollow(b: LBook, pe: Pend | undefined, now: number) {
  if (!pe || pe.sent || pe.fillAfter == null || now >= pe.fillAfter || !followed(b.key)) return;
  const last = LAST.get(pe.mint);
  if (!last || !(last.px > 0) || last.done) return;
  if ([...POS.values()].filter((p) => p.key === b.key).length >= capOfBook(b)) return;
  pe.sent = now;
  emitFollow(b, pe, last.px / 1e9, !!last.pool, rugBlock(entryNow(pe.mint, now)) ?? undefined, now, true);
}
export const fastStats = { early: 0, atFill: 0 };
function emitFollow(b: LBook, pe: Pend, px0: number, inPool: boolean, rug: string | undefined, now: number, early: boolean) {
  if (!FOLLOW) return;
  try {
    // v0.1.95: its whole live record goes with the order (net % per trip): the desk sizes the trade from it
    const mine = TRIPS.filter((t) => t.k === b.key);
    FOLLOW({ key: b.key, label: b.label, exit: b.exit, mint: pe.mint, symbol: pe.symbol, at: now, pool: inPool, xp: exitPick(b.key).pick, pcts: (() => { const e = edgeAdj(b.key); return mine.map((t) => Math.round(e.adj(t) * 10) / 10); })(), probation: !!bookStat(b, mine).probation, fv: b.fv, px0, rug, early, ...(pe.mult ? { mult: pe.mult } : {}) });
    if (early) fastStats.early++;
    else fastStats.atFill++;
  } catch {}
}

function sell(pos: LPos, frac: number, px: number, real: number) {
  const amt = frac >= 1 ? pos.tokens : pos.tokens * frac;
  pos.back += sellProceeds(amt, px, !!pos.pool, real, COST, frac >= 1);
  pos.tokens -= amt;
}
function close(k: string, pos: LPos, now: number, why: string) {
  if (pos.tokens > 1e-12) {
    // the market part of the paper sale (no tx costs), to set against Jupiter's quote for the same tokens
    if (CHECK.has(pos.key)) queueCheck({ side: "sell", key: pos.key, mint: pos.mint, amount: BigInt(Math.floor(pos.tokens * 1e6)), paper: sellProceeds(pos.tokens, pos.lastPx, !!pos.pool, pos.lastReal, { fastExec: false, paperPrioritySol: 0 } as CostCfg), tokens: pos.tokens, at: now });
    sell(pos, 1, pos.lastPx, pos.lastReal);
  }
  POS.delete(k);
  const pnl = pos.back - pos.cost;
  const t: LTrip = { k: pos.key, mint: pos.mint, symbol: pos.symbol, openedAt: pos.openedAt, closedAt: now, pnl: Math.round(pnl * 1e6) / 1e6, pnlPct: Math.round((pnl / pos.cost) * 1000) / 10, why };
  if (pos.fillPx > 0 && pos.peak > 0) t.pk = Math.round((pos.peak / pos.fillPx) * 1000) / 1000; // v0.1.138: its peak
  // v0.1.126: a rug = stopped out at -30% or worse within 90 seconds of the buy
  if (pos.ef) (t.ef = pos.ef), (t.rug = now - pos.openedAt <= RUG_SECS * 1000 && t.pnlPct <= -30);
  // v0.1.127: what each take-profit ladder would have made on this trip, and the market cap (SOL) at the buy
  const bagWatch = !!pos.sh && pos.fillPx > 0 && bagEligible(pos.key);
  if (pos.sh && pos.fillPx > 0) (t.sh = shadowClose(pos.sh, pos.lastPx / pos.fillPx, bagWatch)), (t.mc0 = Math.round(pos.fillPx * 1e9 * 1000) / 1000);
  if (bagWatch) bagStart(pos, t, now); // v0.1.137
  if (pos.f0 && pos.f0.kx != null) {
    // (a coin whose flow is unknown, not seen from its create, is left out of the record)
    // v0.1.105: the same trip, had it sold when the flow turned. v0.1.108: every flow-watched trip is kept (also those
    // where nothing fired: they count for every variant at their actual result), with a note per trigger
    const fx: FlowX = { k: pos.key, mint: pos.mint, at: now, act: t.pnlPct, flag: pos.fx ? pos.fx.pct : t.pnlPct, why: pos.fx ? pos.fx.why : "none", fl: pos.fl || {} };
    FLOWX = [fx, ...FLOWX].slice(0, 2000);
    redis().lpush(FLOWX_KEY, fx).then(() => redis().ltrim(FLOWX_KEY, 0, 1999)).catch(() => null);
  }
  TRIPS = keepTrips([t, ...TRIPS]);
  pairPending(t); // v0.1.135: a live follow waiting for this paper trip
  // v0.1.123: every paper trip also goes to Postgres, so a record can never be lost again (book "grid:<key>")
  archiveTrip({ book: `grid:${pos.key}` as any, mint: pos.mint, symbol: pos.symbol, openedAt: pos.openedAt, closedAt: now, costSol: pos.cost, backSol: pos.back, how: pos.key.split(":")[0].split("|")[0].slice(0, 40), reason: why, data: pos.ef || t.sh ? { ...(pos.ef ? { ef: pos.ef, rug: !!t.rug } : {}), ...(t.sh ? { sh: t.sh, mc0: t.mc0 } : {}) } : undefined });
  const r = redis();
  r.hdel(POS_KEY, k).catch(() => null);
  r.lpush(LIVE_TRIPS, t).then(() => r.ltrim(LIVE_TRIPS, 0, TRIPS_MAX - 1)).catch(() => null);
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
  // v0.1.127: every take-profit ladder runs as a shadow on the same ticks
  if (!pos.sh) pos.sh = newShadows();
  shadowTick(pos.sh, x, firstSell(x), xr, pos.peak / pos.fillPx);
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
  if (RIDES.size) rideStep(mint, q.mcSol / 1e9, now);
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

export type LStat = { n: number; wins: number; winRate: number; avgPct: number; pnl: number; pfLessBest: number; passed: boolean; pending?: boolean; total?: number; totalPnl?: number; runner?: boolean; lessTop2?: number; probation?: boolean; hold?: boolean };
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
  // v0.1.123 RUNNER HOLD: passed the runner exam before, whole record still in profit: followed at the minimum size
  // v0.1.124: and its record without the 2 best (open positions marked now) is not deep under water: at most
  // HOLD_FLOOR SOL down (19 Oct: the 2x book was held at -0.58 SOL without its 2 best and lost 8 of 9 live trades)
  if (st.runner && !st.passed && b.key && EVER.has(b.key) && (st.totalPnl ?? 0) > 0 && (st.lessTop2 ?? -1) >= -HOLD_FLOOR()) return { ...st, passed: true, probation: true, hold: true };
  // v0.1.112 FAST LANE: a book GRID proved offline (the test, the plateau, the newest slice and the luck bar) gets the
  // same probation: live at the minimum size after 15 good trips instead of 30
  // v0.1.117: an EARLY book too (its 2-minute momentum books were the only ones in profit on 17 Oct)
  if (st.passed || !b.key || !(/^any:[^|]*\bseer/.test(b.key) || fastLane(b) || /^early\d*:/.test(b.key))) return st;
  const total = trips.reduce((a, t) => a + t.pnl, 0);
  const top = trips.map((t) => t.pnl).sort((a, z) => z - a);
  const lessTop2 = total - Math.max(0, top[0] ?? 0) - Math.max(0, top[1] ?? 0);
  return trips.length >= PROBATION_MIN() && total > 0 && lessTop2 > 0 && tStat(trips) >= PROBATION_T() ? { ...st, passed: true, probation: true, total: trips.length, totalPnl: Math.round(total * 1e4) / 1e4, lessTop2: Math.round(lessTop2 * 1e4) / 1e4 } : st;
}
export const SEER_PROBATION = 25;
// v0.1.122 PROOF FIRST: a probation pass must also clear a luck bar. With 150+ books on paper, some show 15 good trips
// by chance alone (18 Oct: the desk followed probation books for 29 live trades, 14 of 49 round trips won, -0.17 SOL).
// Without its 2 best trips, the book's average trip must sit PROBATION_T standard errors above zero.
export const PROBATION_T = () => {
  const v = Number(process.env.PROBATION_T ?? 2);
  return Number.isFinite(v) ? v : 2;
};
export const PROBATION_MIN = () => Math.max(5, Number(process.env.PROBATION_MIN ?? SEER_PROBATION) || SEER_PROBATION);
export function tStat(trips: LTrip[]): number {
  const p = trips.map((t) => t.pnlPct).sort((a, z) => z - a).slice(2);
  if (p.length < 3) return 0;
  const m = p.reduce((a, v) => a + v, 0) / p.length;
  const sd = Math.sqrt(p.reduce((a, v) => a + (v - m) ** 2, 0) / (p.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(p.length)) : m > 0 ? 99 : 0;
}
// v0.1.122: the trip record kept per book, so one busy family (TICK: 1,348 trips in 16 hours) can't push every other
// book's record out of a shared buffer (it held 3,000, about 20 hours, and the exams read what was left)
// v0.1.123: 150 cold EARLY books filled the 20,000 in a day and pushed TICK's whole record out. Cold books and books no
// longer listed keep their last 60 (enough for the revive check and their screen line); active books keep 400
export const TRIPS_MAX = 40_000;
export const TRIPS_PER_BOOK = 400;
export const TRIPS_PER_COLD = 60;
export function keepTrips(ts: LTrip[], capOf?: (k: string) => number): LTrip[] {
  const warm = capOf ? null : new Set(BOOKS.filter((b) => !b.cold).map((b) => b.key));
  const cap = capOf || ((k: string) => (!BOOKS.length || warm!.has(k) ? TRIPS_PER_BOOK : TRIPS_PER_COLD));
  const per = new Map<string, number>();
  const out: LTrip[] = [];
  for (const t of ts) {
    const n = per.get(t.k) || 0;
    if (n >= cap(t.k)) continue;
    per.set(t.k, n + 1);
    out.push(t);
    if (out.length >= TRIPS_MAX) break;
  }
  return out;
}
/** v0.1.112: GRID-proven (passed every GRID check), not an explore row. */
export const fastLane = (b: Pick<LBook, "grid">) => !!b.grid?.pass && !b.grid?.explore;
export const earlyLane = (b: { key?: string }) => /^early\d*:/.test(String(b.key || ""));
function bookStat0(b: Pick<LBook, "grid"> & { key?: string; exit?: GExit }, trips: LTrip[]): LStat {
  // v0.1.89: a runner is judged on its whole record (few wins, big ones), not on 40% won over its last 30
  const x = b.exit ?? (b.key ? exitOfKey(b.key) : null);
  if (isRunner(x)) return runnerStat(b.key ? [...openMarks(b.key), ...trips] : trips);
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
/**
 * v0.1.124 OPEN MARKS: a runner's record counts its open positions at their value now, less EXIT_HAIRCUT for the
 * exit costs (19 Oct: the two runner books held 36 open positions, 24 of them up 100%+, and the record only saw the
 * stopped-out trips). Each open position counts as one trip at what it would bring back if sold now.
 */
export const EXIT_HAIRCUT = 0.1;
// v0.1.138 KEEP SHARE: an open position up on paper is not money yet. Of the gain a closed trip had at its peak, how
// much did it keep at the close? Learned on the last 500 closed trips that ran 30%+ (KEEP_MIN needed, else KEEP_DEF). An
// open gain counts at that share: a runner book can no longer pass on one hot hour of marks (20 Oct: 10 runner books
// passed at 15:55 on 20+ open positions each and failed again at 16:10 once the marks came down).
export const KEEP_DEF = 0.5;
export const KEEP_MIN = 150;
let KEEP_AT = 0;
let KEEP: { k: number; n: number } = { k: KEEP_DEF, n: 0 };
export function keepShare(now = Date.now()) {
  if (now - KEEP_AT < 60_000) return KEEP;
  KEEP_AT = now;
  const xs = TRIPS.filter((t) => t.pk != null && t.pk >= 1.3 && t.why !== "open (marked now)").slice(0, 500);
  // v0.1.139: 150 needed (the first 39 after a restart were the quick reversals: they read 0%)
  if (xs.length < KEEP_MIN) return (KEEP = { k: KEEP_DEF, n: xs.length });
  const v = xs.reduce((a, t) => a + Math.max(-1, Math.min(1, (t.pnlPct / 100) / (t.pk! - 1))), 0) / xs.length;
  return (KEEP = { k: Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000, n: xs.length });
}
export const _keepReset = () => ((KEEP_AT = 0), (KEEP = { k: KEEP_DEF, n: 0 }));
/** Tests: pin the share (Infinity holds it until the next reset). */
export const _setKeep = (k: number) => ((KEEP = { k, n: 0 }), (KEEP_AT = Number.MAX_SAFE_INTEGER));
let OPEN_AT = 0;
let OPEN_BY = new Map<string, LTrip[]>();
export function openMarks(key: string, now = Date.now()): LTrip[] {
  if (now - OPEN_AT > 5_000) {
    OPEN_AT = now;
    OPEN_BY = new Map();
    for (const p of POS.values()) {
      if (!(p.lastPx > 0) || !(p.cost > 0)) continue;
      const value = p.back + p.tokens * p.lastPx * (1 - EXIT_HAIRCUT);
      // v0.1.138: an open gain counts at the share closed trips kept of theirs
      const pnl = value > p.cost ? (value - p.cost) * keepShare(now).k : value - p.cost;
      const t: LTrip = { k: p.key, mint: p.mint, symbol: p.symbol, openedAt: p.openedAt, closedAt: now, pnl: Math.round(pnl * 1e6) / 1e6, pnlPct: Math.round((pnl / p.cost) * 1000) / 10, why: "open (marked now)" };
      (OPEN_BY.get(p.key) || OPEN_BY.set(p.key, []).get(p.key)!).push(t);
    }
  }
  return OPEN_BY.get(key) || [];
}
/**
 * v0.1.124b: merge trips from the archive into the record (a restart reloads only what the Redis list still held).
 * Same trip = same book, coin and close time (to the second). Returns how many were added.
 */
export function gridLiveBackfill(rows: LTrip[]): number {
  if (!rows?.length) return 0;
  const sec = (t: number) => Math.round(t / 1000);
  const have = new Set(TRIPS.map((t) => `${t.k}|${t.mint}|${sec(t.closedAt)}`));
  const add = rows.filter((t) => t && t.k && !have.has(`${t.k}|${t.mint}|${sec(t.closedAt)}`));
  if (!add.length) return 0;
  TRIPS = keepTrips([...TRIPS, ...add].sort((a, z) => z.closedAt - a.closedAt));
  OPEN_AT = 0;
  return add.length;
}
/**
 * v0.1.126 RUG GUARD. Every paper position notes the coin's state at the buy (EntryF). Each rule below marks a kind of
 * entry to skip. A rule goes live only when the paper trips it would have skipped lost money, older 70% and newest 30%
 * alike, at least RUG_MIN_N of them in each, and rugged at 1.5x the rate of the trips it keeps. Until the study has its
 * own verdict on it, the 45 to 90 second window is skipped live (19 Oct: 6 of 6 live buys at 60 to 70 seconds rugged
 * within 20 seconds). Paper keeps trading everything, so the study keeps measuring every rule.
 */
export const RUG_SECS = 90;
export const RUG_MIN_N = 20;
// v0.1.130: the who-is-buying rules count only trips from v0.1.130 on (the state carries bt): before it, FOMO counted
// shared accounts, crews chained 1,755 bots and "earners" were sniper bots
// v0.1.128: `sig` rules are about who is buying, not rugs: they need the money tests only (not the 1.5x rug rate), and
// only trips whose state has that field count for them
export const RUG_RULES: { id: string; label: string; hit: (f: EntryF) => boolean; sig?: true; known?: (f: EntryF) => boolean }[] = [
  { id: "age45_90", label: "45 to 90 seconds after launch", hit: (f) => f.age != null && f.age >= 45 && f.age < 90 },
  { id: "age_lt30", label: "under 30 seconds after launch", hit: (f) => f.age != null && f.age < 30 },
  { id: "dev_lt03", label: "dev bought under 0.3 SOL", hit: (f) => f.dev != null && f.dev < 0.3 },
  { id: "dev_ge3", label: "dev bought 3+ SOL", hit: (f) => f.dev != null && f.dev >= 3 },
  { id: "copy", label: "copies an earlier coin's name or ticker", hit: (f) => f.og != null && f.og > 1 },
  { id: "few_buyers", label: "under 5 buyers in the last minute", hit: (f) => f.u60 != null && f.u60 < 5 },
  { id: "hot_flow", label: "85%+ of the last minute's SOL was buying", hit: (f) => f.bs60 != null && f.bs60 >= 0.85 },
  { id: "dev_sold", label: "the dev already sold", hit: (f) => f.ds === true },
  { id: "no_fomo", label: "no FOMO trader bought in the last minute", hit: (f) => f.fc === 0, sig: true, known: (f) => f.fc != null && f.bt != null },
  { id: "fomo_late", label: "5+ FOMO traders already bought in the last minute", hit: (f) => (f.fc ?? 0) >= 5, sig: true, known: (f) => f.fc != null && f.bt != null },
  { id: "no_earner", label: "no earner (a wallet with a profitable record) bought in the last minute", hit: (f) => f.ea === 0, sig: true, known: (f) => f.ea != null && f.bt != null },
  { id: "one_crew", label: "2+ proven wallets bought, but they are one crew", hit: (f) => (f.pwr ?? 0) >= 2 && (f.pwi ?? 0) <= 1, sig: true, known: (f) => f.pwi != null && f.bt != null },
  { id: "bots_in", label: "2+ bots (30+ round trips a day) bought in the last minute", hit: (f) => (f.bt ?? 0) >= 2, sig: true, known: (f) => f.bt != null },
  { id: "fomo_cold", label: "FOMO retail money is under 60% of its 6-hour average", hit: (f) => f.fm != null && f.fm < 0.6, sig: true, known: (f) => f.fm != null },
];
const SAFE_DEFAULT = new Set(["age45_90"]);
let RUG_AT = 0;
let RUG_LIVE = new Set<string>(SAFE_DEFAULT);
type RugSide = { n: number; rugs: number; pnl: number; won: number };
export type RugRow = { id: string; label: string; train: RugSide; test: RugSide; keptRug: number; skipRug: number; verdict: "live" | "off" | "safety" | "waiting" };
// v0.1.128: a rule that would skip most trips is not a guard, it is the whole strategy: never live
export const SKIP_MAX = 0.6;
export function rugStudy(trips: LTrip[], now = Date.now()) {
  const xs = trips.filter((t) => t.ef).sort((a, z) => a.closedAt - z.closedAt);
  const side = (a: LTrip[]): RugSide => ({ n: a.length, rugs: a.filter((t) => t.rug).length, pnl: Math.round(a.reduce((s, t) => s + t.pnl, 0) * 1e4) / 1e4, won: Math.round(a.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) * 1e4) / 1e4 });
  const rate = (a: LTrip[]) => (a.length ? a.filter((t) => t.rug).length / a.length : 0);
  const live = new Set<string>();
  const rows: RugRow[] = RUG_RULES.map((r) => {
    const ys = r.known ? xs.filter((t) => r.known!(t.ef!)) : xs;
    const cut = Math.floor(ys.length * 0.7);
    const tr = ys.slice(0, cut), te = ys.slice(cut);
    const trS = tr.filter((t) => r.hit(t.ef!)), teS = te.filter((t) => r.hit(t.ef!));
    const teK = te.filter((t) => !r.hit(t.ef!));
    const enough = trS.length >= RUG_MIN_N && teS.length >= RUG_MIN_N;
    // most paper trips lose, so "the skipped trips lost" alone would block anything: they must also do worse per trip
    // than the trips kept, on both halves
    const avg = (a: LTrip[]) => (a.length ? a.reduce((x, t) => x + t.pnl, 0) / a.length : 0);
    const trK = tr.filter((t) => !r.hit(t.ef!));
    const good = enough && side(trS).pnl < 0 && side(teS).pnl < 0 && avg(trS) < avg(trK) && avg(teS) < avg(teK) && (!!r.sig || rate(teS) >= 1.5 * rate(teK)) && teS.length <= SKIP_MAX * te.length;
    const verdict: RugRow["verdict"] = good ? "live" : enough ? "off" : SAFE_DEFAULT.has(r.id) ? "safety" : "waiting";
    if (verdict === "live" || verdict === "safety") live.add(r.id);
    return { id: r.id, label: r.label, train: side(trS), test: side(teS), keptRug: Math.round(rate(teK) * 1000) / 10, skipRug: Math.round(rate(teS) * 1000) / 10, verdict };
  });
  RUG_LIVE = live;
  return { at: now, trips: xs.length, rugs: xs.filter((t) => t.rug).length, live: [...live], rows };
}
/** The live rule a coin's entry state breaks, or null (an unknown state never blocks). */
export function rugBlock(ef: EntryF | null | undefined): string | null {
  if (!ef) return null;
  for (const r of RUG_RULES) if (RUG_LIVE.has(r.id) && r.hit(ef)) return r.label;
  return null;
}
export const _setRugLive = (ids: string[]) => (RUG_LIVE = new Set(ids));
export const _resetOpenMarks = () => ((OPEN_AT = 0), (OPEN_BY = new Map()));
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
    if (!b.live.probation) EVER.add(b.key);
    const fresh = await redis().hsetnx(PASSED_KEY, b.live.probation ? `${b.key}#probation` : b.key, { at: now, ...b.live }).catch(() => 0);
    const tp = b.live.totalPnl ?? 0;
    const l2 = b.live.lessTop2 ?? 0;
    if (fresh && b.live.probation) await send(`${fastLane(b) ? "⚡ <b>GRID LIVE: a GRID-proven strategy passed its probation (FAST LANE)</b>" : earlyLane(b) ? "⏱ <b>GRID LIVE: an EARLY strategy passed its probation</b>" : "🔮 <b>GRID LIVE: a SEER strategy passed its probation</b>"}\n${b.label.replace(/[<>&]/g, " ")}\n${b.exitLabel}\n${b.live.total} trips, ${tp >= 0 ? "+" : ""}${tp} SOL on 0.05 SOL trades, ${l2 >= 0 ? "+" : ""}${l2} SOL without the 2 best.\n\nNext: the desk may follow it at the minimum size until it passes the full exam.`).catch(() => null);
    else if (fresh) await send(`🏁 <b>GRID LIVE: a strategy passed the exam on live coins</b>\n${b.label.replace(/[<>&]/g, " ")}\n${b.exitLabel}\n${b.live.n} trips, ${b.live.winRate}% won, ${b.live.pnl >= 0 ? "+" : ""}${b.live.pnl} SOL on 0.05 SOL trades, PF ${b.live.pfLessBest} without the best.\n\nNext: the desk trades it.`).catch(() => null);
  }
  // v0.1.78: a strategy that passed but whose real fills are too far from paper is not followed, and says so once
  for (const b of books) {
    if (!b.live.passed || !b.fills?.blocked || !send) continue;
    const fresh = await redis().hsetnx(GAPBLOCK_KEY, b.key, { at: now, ...b.fills }).catch(() => 0);
    const ed = b.fills.edge;
    if (fresh) await send(`⚠️ <b>GRID LIVE: passed on paper, but not with real money</b>\n${b.label.replace(/[<>&]/g, " ")}\n${ed ? `After the real gap (${ed.gap ?? "-"} points, ${ed.src}${ed.pairs ? `, ${ed.pairs} measured` : ""}): ${ed.avg}% a trade, ${ed.lessTop2} SOL without the 2 best.` : `Jupiter vs paper: buy ${b.fills.buyGap}% (${b.fills.buyN}), sell ${b.fills.sellGap}% (${b.fills.sellN}).`}\nThe desk does not follow it.`).catch(() => null);
  }
  if (FILLS.size) await redis().hset(FILLS_KEY, Object.fromEntries(FILLS)).catch(() => null);
  await pairsSave(); // v0.1.135
  rideSweep(now);
  await bagSave(); // v0.1.137
  if (now - RUG_AT > 10 * 60_000) {
    RUG_AT = now;
    const rv = rugStudy(TRIPS, now);
    redis().set("rn:rug:view", rv, { ex: 2 * 86400 }).catch(() => null);
    LADDER_VIEW = ladderStudy(TRIPS, LEADER, now);
    redis().set("rn:ladder:view", LADDER_VIEW, { ex: 2 * 86400 }).catch(() => null);
  }
  const leads = gridLeaders();
  LEADERS = new Set(leads.map((x) => x.key));
  const lead = leads[0] ?? null;
  const leadChanged = (lead?.key ?? null) !== LEADER;
  LEADER = lead?.key ?? null;
  const follow = lead ? { key: lead.key, label: lead.label, exit: lead.exit, exitLabel: exitText(lead.exit), live: bookStat(lead, byKey.get(lead.key) || []), at: now } : null;
  if (follow) await redis().set("rn:grid:follow", { ...follow, all: leads.map((x) => ({ key: x.key, label: x.label, live: bookStat(x, byKey.get(x.key) || []) })) }, { ex: 3600 }).catch(() => null);
  else await redis().del("rn:grid:follow").catch(() => null);
  if (leadChanged && send) await send(lead ? `🧭 <b>The desk now follows GRID LIVE's "${lead.label.replace(/[<>&]/g, " ")}"</b>\n${exitText(lead.exit)}\nIts entries go to the desk the moment they fill. Desk mode decides paper or live money.` : "🧭 The desk stopped following GRID LIVE (no passed strategy right now).").catch(() => null);
  refreshCheck();
  const hot = hotBook();
  const view = { at: now, books, past, follow, hot: hot?.key ?? null, gapLimit: GAP_LIMIT * 100, edgeMin: EDGE_MIN(), keep: keepShare(), fast: fastStats, realGap: pairsView(), bags: { ...bagStudy(), live: bagPick() }, ladder: LADDER_VIEW, recent: TRIPS.slice(0, 15), trips: TRIPS.length };
  await redis().set(LIVE_VIEW, view, { ex: 2 * 86400 }).catch(() => null);
  return view;
}

// ---------------------------------------------------------------- v0.1.78: real-fill check (Jupiter)

const WSOL = "So11111111111111111111111111111111111111112";
const JUP = process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
const jupHeaders = (): Record<string, string> => (process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {});
/** The books whose fills are checked: the leader, the hot strategy and its family, and any book in profit after 10+ trips. */
const CHECK = new Set<string>();
type Check = { side: "buy" | "sell"; key: string; mint: string; amount: bigint; paper: number; sol?: number; tokens?: number; at?: number };
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
/** v0.1.118: paper's fill for this check at the live price right now (the same model as the paper fill). */
function reprice(c: Check) {
  const l = LAST.get(c.mint);
  if (!l || !(l.px > 0) || l.done) return c;
  const px = l.px / 1e9;
  const pool = !!l.pool;
  if (c.side === "buy" && c.sol) c.paper = (c.sol * (1 - venueFee(pool, l.px))) / (px * (1 + slipOf(c.sol, pool, l.real)));
  else if (c.side === "sell" && c.tokens) c.paper = sellProceeds(c.tokens, px, pool, l.real, { fastExec: false, paperPrioritySol: 0 } as CostCfg);
  return c;
}
/** Tests only. */
export const _reprice = (c: Check) => reprice({ ...c });
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
      // v0.1.118 (audit): the quote comes up to a minute after the fill (the queue, 1.5s apart). On a coin climbing 15
      // curve points a minute, the price moved in between, so Jupiter looked 11% worse than paper on the EARLY momentum
      // books and blocked them: price drift, not the route. Paper is now priced again at the moment of the quote, from
      // the same live curve, so only the route's own cost is measured
      reprice(c);
      const got = await QUOTE(c).catch(() => null);
      if (got != null) {
        const f = FILLS.get(c.key) || { bn: 0, bg: 0, sn: 0, sg: 0, nr: 0, v: FILL_V, lag: 0 };
        f.v = FILL_V;
        if (c.at) f.lag = Math.round(((f.lag || 0) * (f.bn + f.sn) + (Date.now() - c.at)) / (f.bn + f.sn + 1));
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

// v0.1.135 REAL GAP and EDGE AFTER FILLS. The Jupiter quote measures the route, not the whole gap: the live desk buys
// a moment after the paper fill, on a coin that is moving. So every live GRID follow is paired with its book's paper
// trip on the same coin (opened within PAIR_SECS), and the real gap = live % minus paper % (paper at the desk's own
// take-profit ladder when it has one). A book is then judged on its paper record PLUS its real gap:
//   its own pairs (8+), else its family's (same filter and entry, 8+), else every pair (8+), else the Jupiter quotes.
// It is followed only while that adjusted record makes EDGE_MIN % a trade and stays positive without its 2 best trips.
// This replaces the flat 10% gap limit, which blocked the best books (+51% a trade on paper, 17% gap) for nothing,
// and missed the gap that cost the desk overnight (entries 48 of 79 stopped within 10 seconds).
export const PAIR_SECS = 180;
export const PAIR_MIN = 8;
export const GAP_COST = 6; // % points: fees and slippage of a round trip (as the class gate)
export const EDGE_MIN = () => {
  const v = Number(process.env.GRID_EDGE_MIN ?? 5);
  return Number.isFinite(v) ? v : 5;
};
export type LivePair = { k: string; mint: string; at: number; live: number; paper: number; exact: boolean; sym?: string };
const PAIRS_KEY = "rn:grid:pairs";
let PAIRS: LivePair[] = [];
const PAIR_SEEN = new Set<string>();
let LIVE_WAIT: { k?: string; mint: string; openedAt: number; pct: number; at: number }[] = [];
let PAIRS_DIRTY = false;
const paperPct = (t: LTrip) => (t.sh && typeof t.sh.desk === "number" ? Math.round((t.sh.desk - 1) * 1000) / 10 : t.pnlPct);
export const familyOf = (k: string) => k.replace(/~.*$/, "").split("|").slice(0, 2).join("|");
function addPair(x: LivePair) {
  const id = `${x.k}|${x.mint}|${Math.round(x.at / 1000)}`;
  if (PAIR_SEEN.has(id)) return false;
  PAIR_SEEN.add(id);
  PAIRS = [x, ...PAIRS].slice(0, 2000);
  PAIRS_DIRTY = true;
  return true;
}
function matchPaper(x: { k?: string; mint: string; openedAt: number }) {
  return TRIPS.filter((t) => t.mint === x.mint && (!x.k || t.k === x.k) && Math.abs(t.openedAt - x.openedAt) <= PAIR_SECS * 1000 && t.why !== "open (marked now)");
}
/** A closed live follow (desk). k unknown (older trades): paired with every book that traded the coin then. */
export function gridNoteLive(x: { k?: string; mint: string; openedAt: number; pct: number }, now = Date.now()) {
  const ts = matchPaper(x);
  if (!ts.length) {
    if (now - x.openedAt < 6 * 3600_000) LIVE_WAIT = [{ ...x, at: now }, ...LIVE_WAIT].slice(0, 300);
    return 0;
  }
  let n = 0;
  const seenK = new Set<string>();
  for (const t of ts) {
    if (seenK.has(t.k)) continue;
    seenK.add(t.k);
    if (addPair({ k: t.k, mint: x.mint, at: x.openedAt, live: Math.round(x.pct * 10) / 10, paper: paperPct(t), exact: !!x.k, sym: t.symbol })) n++;
  }
  return n;
}
function pairPending(t: LTrip) {
  if (!LIVE_WAIT.length) return;
  const now = Date.now();
  LIVE_WAIT = LIVE_WAIT.filter((w) => now - w.at < 6 * 3600_000);
  for (const w of LIVE_WAIT) if (w.mint === t.mint && (!w.k || w.k === t.k) && Math.abs(t.openedAt - w.openedAt) <= PAIR_SECS * 1000) addPair({ k: t.k, mint: w.mint, at: w.openedAt, live: Math.round(w.pct * 10) / 10, paper: paperPct(t), exact: !!w.k, sym: t.symbol });
  if (LIVE_WAIT.some((w) => w.mint === t.mint && w.k === t.k)) LIVE_WAIT = LIVE_WAIT.filter((w) => !(w.mint === t.mint && w.k === t.k));
}
// v0.1.136: evidence counts in distinct LIVE trades (an older trade pairs with every book that held the coin: 8 live
// trades made 85 pairs on 20 Oct), each live trade once per level (its pairs averaged). And the gap never adds edge:
// real money cannot beat paper by design, so a positive gap is noise (20 Oct: +69 points on 8 trades made a book at
// -1.4% a trade on paper look like +29% and the desk followed it)
const avgGap = (ps: LivePair[]) => {
  const by = new Map<string, number[]>();
  for (const p of ps) (by.get(`${p.mint}|${p.at}`) || by.set(`${p.mint}|${p.at}`, []).get(`${p.mint}|${p.at}`)!).push(p.live - p.paper);
  const per = [...by.values()].map((v) => v.reduce((a, x) => a + x, 0) / v.length);
  const raw = per.length ? per.reduce((a, x) => a + x, 0) / per.length : 0;
  // paper here is gross (the desk's ladder before costs), so the gap is at least the cost of a trade
  return { n: per.length, gap: Math.round(Math.min(-GAP_COST, raw) * 10) / 10, raw: Math.round(raw * 10) / 10 };
};
/** The real gap (live minus paper, in % points a trade, never above -GAP_COST) for a book: its own, its family's, or all. */
export function realGap(k: string): { n: number; gap: number; raw: number; src: "book" | "family" | "all" } | null {
  const own = avgGap(PAIRS.filter((p) => p.k === k));
  if (own.n >= PAIR_MIN) return { ...own, src: "book" };
  const fam = familyOf(k);
  const f = avgGap(PAIRS.filter((p) => familyOf(p.k) === fam));
  if (f.n >= PAIR_MIN) return { ...f, src: "family" };
  const all = avgGap(PAIRS);
  return all.n >= PAIR_MIN ? { ...all, src: "all" } : null;
}
/** How a book's paper % a trip turns into a real-money % a trip. */
// adj takes a paper TRIP: with a real gap, the base is the trip at the desk's own ladder (what the gap was measured
// against: live follows sell on the desk's ladder); with quotes or nothing, the book's own net %
// v0.1.137 EXIT PICK: the live desk runs each strategy with the exit that made more on that strategy's own paper
// trips: its own exit ("book": e.g. 70% at 2x, 30% riding a 50% trail up to 24h) or the desk's ladder. The book's
// exit is picked when it beats the ladder on both the older and the newer half of its last 60 closed trips (30+).
// (20 Oct: the passed runner books made +37 to +59% a trade with their own exit, and about 0% with the ladder, which
// sells everything by 5x: their edge is the part that keeps riding.)
export function exitPick(k: string): { pick: "book" | "desk"; book: number | null; desk: number | null; n: number } {
  const ts = TRIPS.filter((t) => t.k === k && typeof t.sh?.book === "number" && typeof t.sh?.desk === "number" && t.why !== "open (marked now)").slice(0, 60);
  const avg = (a: LTrip[], id: string) => (a.length ? Math.round((a.reduce((s, t) => s + t.sh![id], 0) / a.length - 1) * 1000) / 10 : null);
  const half = Math.floor(ts.length / 2);
  const newer = ts.slice(0, half);
  const older = ts.slice(half);
  const book = avg(ts, "book");
  const desk = avg(ts, "desk");
  const wins = ts.length >= 30 && (avg(newer, "book") ?? -1e9) > (avg(newer, "desk") ?? 1e9) && (avg(older, "book") ?? -1e9) > (avg(older, "desk") ?? 1e9);
  return { pick: wins ? "book" : "desk", book, desk, n: ts.length };
}
export function edgeAdj(k: string): { adj: (t: LTrip) => number; src: string; gap: number | null; n: number; exit: "book" | "desk" } {
  const rg = realGap(k);
  const xp = exitPick(k).pick;
  // the gap was measured against paper before costs: the base is the picked exit's gross multiple on the same trip
  const base = (t: LTrip) => (typeof t.sh?.[xp] === "number" ? Math.round((t.sh[xp] - 1) * 1000) / 10 : paperPct(t));
  if (rg) return { adj: (t) => base(t) + rg.gap, src: rg.src, gap: rg.gap, n: rg.n, exit: xp };
  const f = FILLS.get(k);
  // net % a trip on the picked exit (the book's own result is net already; the ladder's shadow is gross)
  const net = (t: LTrip) => (xp === "desk" && typeof t.sh?.desk === "number" ? (t.sh.desk - 1) * 100 - GAP_COST : t.pnlPct);
  if (f && f.bn >= 8 && f.sn >= 8) return { adj: (t) => ((1 + net(t) / 100) * (1 + f.bg) * (1 + f.sg) - 1) * 100, src: "quotes", gap: Math.round((f.bg + f.sg) * 1000) / 10, n: Math.min(f.bn, f.sn), exit: xp };
  return { adj: (t) => t.pnlPct, src: "none", gap: null, n: 0, exit: xp };
}
/** The book's last 30 trips after the real gap: average % a trade and SOL without the 2 best (0.05 SOL trades). */
export function edgeOf(k: string, trips?: LTrip[]) {
  const e = edgeAdj(k);
  const ts = (trips ?? TRIPS.filter((t) => t.k === k)).slice(0, 30);
  const ps = ts.map((t) => e.adj(t));
  const sol = ps.map((p) => (GRID_SOL * p) / 100).sort((a, z) => z - a);
  const l2 = sol.reduce((a, v) => a + v, 0) - Math.max(0, sol[0] ?? 0) - Math.max(0, sol[1] ?? 0);
  const avg = ps.length ? ps.reduce((a, v) => a + v, 0) / ps.length : 0;
  return { n: ps.length, avg: Math.round(avg * 10) / 10, lessTop2: Math.round(l2 * 1e4) / 1e4, src: e.src, gap: e.gap, pairs: e.n, exit: e.exit, ok: ps.length > 0 && avg >= EDGE_MIN() && l2 > 0 };
}
export const pairsView = () => {
  const one = new Map<string, LivePair>();
  for (const p of PAIRS) if (!one.has(`${p.mint}|${p.at}`)) one.set(`${p.mint}|${p.at}`, p);
  const u = [...one.values()];
  const g = avgGap(PAIRS);
  return { pairs: PAIRS.length, trades: u.length, exact: PAIRS.filter((p) => p.exact).length, gap: g.gap, raw: g.raw, waiting: LIVE_WAIT.length };
};
export async function pairsLoad() {
  const xs = (await redis().get<LivePair[]>(PAIRS_KEY).catch(() => null)) || [];
  for (const x of xs.reverse()) addPair(x);
  PAIRS_DIRTY = false;
  return PAIRS.length;
}
export async function pairsSave() {
  if (!PAIRS_DIRTY) return;
  PAIRS_DIRTY = false;
  await redis().set(PAIRS_KEY, PAIRS.slice(0, 2000)).catch(() => null);
}
export const _pairsReset = () => ((PAIRS = []), PAIR_SEEN.clear(), (LIVE_WAIT = []), (PAIRS_DIRTY = false));
const RECHECK = new Set<string>();
export function gapBlock(key: string) {
  const f = FILLS.get(key);
  const quoted = !!f && f.bn >= 8 && f.sn >= 8;
  if (RECHECK.has(key) && !quoted) return true; // an old blocking record waits for the new check
  // v0.1.135: with a real gap (live follows) or 8+ quotes each way, the book is judged on its edge after that gap
  // (no trips yet: the old flat rule on the quotes holds until there is a record to judge)
  if (quoted || realGap(key)) {
    const e = edgeOf(key);
    if (!e.n) return quoted && f!.bg + f!.sg <= GAP_LIMIT;
    return !e.ok;
  }
  return false;
}
export const _gbClear = () => {};
export const _setFill = (k: string, f: { bn: number; bg: number; sn: number; sg: number }) => FILLS.set(k, { nr: 0, v: FILL_V, lag: 0, ...f } as any);
const fillView = (key: string) => {
  const f = FILLS.get(key);
  if (!f) return null;
  const r = (x: number) => Math.round(x * 1000) / 10;
  const e = edgeOf(key);
  return { buyN: f.bn, buyGap: r(f.bg), sellN: f.sn, sellGap: r(f.sg), noRoute: f.nr, blocked: gapBlock(key), lagMs: f.lag ?? null, edge: { avg: e.avg, lessTop2: e.lessTop2, src: e.src, gap: e.gap, pairs: e.pairs, exit: e.exit, pick: exitPick(key) } };
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
  let room = FLOW_MAX - BOOKS.filter((b) => !b.cold && b.fv).length;
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
  const c = BOOKS.filter((b) => !b.parent && !b.fv && !b.any && !b.early && !isRunner(b.exit)) // v0.1.89: runners have no exit family
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
  const dropped = coolOff(now); // v0.1.120: young ruled-out books go cold instead
  BOOKS = BOOKS.filter((b) => !dropped.includes(b));
  const revived = reviveBooks(now);
  // v0.1.89: the RUNNER family trades on live coins from the first tend (its own slots)
  const runners = seedRunners(now);
  // v0.1.90: the WALLETS family: proven wallets buying, on every launch (not only King calls)
  const wals = seedWallets(now);
  // v0.1.102: the SEER family: coins on the watchlist before they were launched, bought in their first seconds
  const seers = seedSeer(now);
  // v0.1.132: the SMART family (front-runners, FOMO crowd, stories)
  const smarts = seedSmart(now);
  if (smarts.length && send) await send(`🧠 <b>GRID LIVE: SMART books</b>\n${smarts.map((b) => `• ${b.label.replace(/[<>&]/g, " ")}`).join("\n")}\n\nWallets that buy before KOL callouts, the FOMO crowd arriving, stories that already migrated a coin. Paper on live coins; the exam decides.`).catch(() => null);
  // v0.1.110: the SIGNALS family follows GRID's lift table
  const sigs = seedSignals(now);
  // v0.1.120: the TICK family, once a horizon's model is warm
  const tks = seedTick(now, tickReady, HORIZONS);
  if (tks.length && send) await send(`📈 <b>GRID LIVE: TICK MODEL books</b>\n${tks.map((b) => `• ${b.label.replace(/[<>&]/g, " ")}`).join("\n")}\n\nThe model learns from every moment of every live coin and buys when its prediction beats the coin's costs. Paper on live coins; the exam decides.`).catch(() => null);
  // v0.1.112: the SCORE family, once GRID has fitted a score
  const scs = seedScore(now);
  if (scs.length && send) await send(`🧮 <b>GRID LIVE: GRID SCORE on live calls</b>\n${scs.map((b) => `• ${b.label.replace(/[<>&]/g, " ")}`).join("\n")}\n\nEvery signal combined into one score (each weighted by what it adds that the others do not), fitted on the older calls. Paper on live coins; the exam decides.`).catch(() => null);
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
    const room = SPAWN_MAX - BOOKS.filter((b) => !b.cold && b.parent).length;
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
  // v0.1.117: the EARLY family (exit one step each way for the best EARLY book)
  const eh = earlyHot();
  let eAdded: LBook[] = [];
  if (eh) {
    eAdded = spawnEarly(eh, now);
    SPAWNED = [...SPAWNED, eh.key].slice(-50);
    await redis().set(SPAWNED_KEY, SPAWNED).catch(() => null);
    if (eAdded.length) {
      BOOKS = [...BOOKS, ...eAdded];
      const st = statOf(eh.key);
      if (send) await send(`⏱ <b>GRID LIVE: the best EARLY strategy got its family</b>\n${eh.label.replace(/[<>&]/g, " ")}\n${st.n} trips, ${st.winRate}% won, ${st.pnl >= 0 ? "+" : ""}${st.pnl} SOL, PF ${st.pfLessBest}\n\n${eAdded.map((b) => `• ${exitText(b.exit)}`).join("\n")}\n\nThey race to the exam; the desk follows the first that passes.`).catch(() => null);
    }
  }
  refreshCheck();
  if (tks.length || eAdded.length || dropped.length || added.length || revived.length || runners.length || wals.length || seers.length || sigs.length || scs.length || fl.added.length || fl.dropped.length || BOOKS.length !== before) await saveBooks();
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
  let room = REVIVE_MAX - BOOKS.filter((b) => !b.cold && b.back).length;
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
export const SIGNAL_RULES = ["seer", "seertop", "seerfirst", "first", "alpha", "lowauto", "dexpaid", "boosted", "kol3", "kolsmall", "hold20", "firstpost", "bigfirst", "mediapost", "repeatpost", "meme70", "thanimal", "thpolitical", "thai", "thcelebrity", "thculture", "themehot", "tiktok", "insta", "social"];
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
  let room = SIGNAL_MAX - BOOKS.filter((b) => !b.cold && b.by === "signals" && !b.fv).length;
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

// ---------------------------------------------------------------- v0.1.112 SCORE family
// The GRID SCORE (every signal combined, lib/grid.ts) trades on live calls from the moment a model exists: its top
// 10% and top 20% with the runner exit, in their own slots, paper like every family. GRID judges the score on its test
// like any rule; this family gathers the live record at the same time instead of after.
export const SCORE_MAX = 6;
// v0.1.115: the WIN SCORE's bands first (fitted on the size of the win), then the PROFIT SCORE's, then the migration score's
export const SCORE_SEEDS = ["wscore10", "wscore20", "pscore10", "pscore20", "score10", "score20"].map((f) => keyOf(f, "now", RUNNER_EXITS[0]));
/** v0.1.115: the WIN SCORE trades when its top 20% beat the average trade by 5+ points on the newer calls. */
export const WIN_MIN_EDGE = 5;
const scoreWorthy = (k: string) => {
  const m = k.startsWith("wscore") ? winModel() : k.startsWith("pscore") ? profitModel() : scoreModel();
  return k.startsWith("wscore") ? (m?.edge ?? -99) >= WIN_MIN_EDGE : (m?.auc ?? 0) >= SCORE_MIN_AUC;
};
/** A score worth trading: it ranks the newer calls it never saw better than a coin flip by a margin (AUC 0.55+). */
export const SCORE_MIN_AUC = 0.55;
export function seedScore(now: number): LBook[] {
  const out: LBook[] = [];
  let room = SCORE_MAX - BOOKS.filter((b) => !b.cold && b.by === "score" && !b.fv).length;
  for (const k of SCORE_SEEDS) {
    if (room <= 0) break;
    if (!scoreWorthy(k)) continue;
    if (BOOKS.some((b) => b.key === k)) continue;
    const ts = TRIPS.filter((t) => t.k === k);
    const b = bookFromKey(k, now);
    if (!b) continue;
    if (ts.length && dropReason(bookStat(b, ts))) continue; // its own record ruled it out
    b.by = "score";
    out.push(b);
    room--;
  }
  if (out.length) BOOKS = [...BOOKS, ...out];
  return out;
}

// ---------------------------------------------------------------- v0.1.115 EARLY family
// The EARLY search (GRID on every launch read at 2 minutes, lib/early.ts) has its own scores and its own candidates.
// Its best strategies trade the same 2-minute read on live launches, in their own slots (paper; the exam decides).
export const EARLY_MAX = 6; // the 2-minute read
export const EARLY_MAX_OTHER = 3; // v0.1.117: each other reading age
export const earlyPrefix = (sec = 120) => (sec === 120 ? "early:" : `early${sec}:`);
const secOf = (b: Pick<LBook, "earlySec">) => b.earlySec ?? 120;
const EARLY_MODELS = new Map<number, Models>();
export const setEarlyModels = (m: Partial<Record<keyof Models, any>> | null | undefined, sec = 120) => {
  const x = asModels(m);
  EARLY_MODELS.set(sec, x);
  return x;
};
export const earlyModels = (sec = 120) => EARLY_MODELS.get(sec) ?? { mig: null, pft: null, win: null };
/** After each EARLY search (worker, one per reading age): passed rows first, then the ones in profit on its test, then explore rows. */
export async function gridLiveEarlyBooks(rows: GRow[], explore: GRow[] = [], now = Date.now(), sec = 120) {
  if (!booksOk) await gridLiveLoad(1, 0).catch(() => false);
  if (!booksOk) return [];
  const pre = earlyPrefix(sec);
  const mine = BOOKS.filter((b) => !b.cold && b.early && !b.fv && !b.parent && secOf(b) === sec);
  // a kept EARLY book gets its newest numbers
  for (const b of mine) {
    const r = [...rows, ...explore].find((x) => `${pre}${x.key}` === b.key);
    if (r) b.grid = { testN: r.test.n, testAvg: r.test.avgPct, pass: r.pass, explore: !!r.explore };
  }
  const ranked = [...rows.filter((r) => r.pass), ...rows.filter((r) => !r.pass && r.test.n >= 10 && r.test.avgPct > 0), ...explore];
  let room = (sec === 120 ? EARLY_MAX : EARLY_MAX_OTHER) - mine.length;
  // v0.1.123: a row that passed the EARLY search always gets a book (19 Oct: the 60s pass found no free slot)
  const passedNew = rows.filter((r) => r.pass && !BOOKS.some((b) => b.key === `${pre}${r.key}`)).length;
  room = Math.max(0, room);
  if (passedNew > room) room += benchForRoom(mine, passedNew - room, now);
  const out: LBook[] = [];
  for (const r of ranked) {
    if (room <= 0) break;
    const key = `${pre}${r.key}`;
    if (BOOKS.some((b) => b.key === key) || out.some((b) => b.key === key)) continue;
    const ts = TRIPS.filter((t) => t.k === key);
    const age = sec % 60 === 0 ? `${sec / 60} minute${sec === 60 ? "" : "s"}` : `${sec} seconds`;
    const b: LBook = { key, label: `${age} after launch: ${r.filterLabel}`, filter: r.filter, mode: "now", exit: r.exit, since: now, grid: { testN: r.test.n, testAvg: r.test.avgPct, pass: r.pass, explore: !!r.explore }, by: "early", early: true, ...(sec !== 120 ? { earlySec: sec } : {}) };
    if (ts.length && dropReason(bookStat(b, ts))) continue;
    out.push(b);
    room--;
  }
  if (out.length) BOOKS = [...BOOKS, ...out];
  if (out.length || mine.length) await saveBooks();
  return out;
}
/** A launch was read (worker, lib/early.ts): the EARLY books of that reading age whose filter takes it start their entry. */
export function gridLiveEarly(mint: string, c: GCoin, now = Date.now(), sec = 120) {
  const last = LAST.get(mint);
  if (!last || last.done || !(last.px > 0)) return 0;
  let n = 0;
  const ms = earlyModels(sec);
  for (const b of BOOKS) {
    if (!b.early || secOf(b) !== sec) continue;
    if (PEND.has(id(b.key, mint)) || POS.has(id(b.key, mint))) continue;
    if (!withScoreModels(ms, () => filterOk(b.filter, c))) continue;
    PEND.set(id(b.key, mint), { key: b.key, mint, symbol: c.symbol, callAt: now, p0: last.p, px0: last.px, until: now + 30_000, fillAfter: now + 2_000 });
    earlyFollow(b, PEND.get(id(b.key, mint)), now); // v0.1.138b
    n++;
  }
  return n;
}
/**
 * v0.1.117 EARLY FAMILY: the EARLY book doing best (12+ trips, in profit, PF 1.2+ without the best, +5% a trip) gets
 * its exit one step each way, same filter and reading age, in their own slots. They race to the exam like GRID's family.
 */
export const EARLY_SPAWN_MAX = 8;
export function earlyHot(): LBook | null {
  const c = BOOKS.filter((b) => b.early && !b.parent && !b.fv && !isRunner(b.exit))
    .map((b) => ({ b, s: statOf(b.key) }))
    .filter((x) => x.s.n >= 12 && x.s.pnl > 0 && x.s.pfLessBest >= 1.2 && x.s.avgPct >= 5)
    .sort((a, z) => z.s.pnl - a.s.pnl);
  return c.find((x) => !SPAWNED.includes(x.b.key))?.b ?? null;
}
function spawnEarly(hot: LBook, now: number): LBook[] {
  const pre = earlyPrefix(secOf(hot));
  const room = EARLY_SPAWN_MAX - BOOKS.filter((b) => !b.cold && b.early && b.parent).length;
  return neighborExits(hot.exit)
    .map((e) => ({ ...hot, key: `${pre}${keyOf(hot.filter, "now", e)}`, exit: e, since: now, parent: hot.key, grid: { ...hot.grid, explore: true } }) as LBook)
    .filter((b) => !BOOKS.some((x) => x.key === b.key) && !dropReason(statOf(b.key)))
    .slice(0, Math.max(0, room));
}

// ---------------------------------------------------------------- v0.1.120 TICK family
// The TICK MODEL (lib/tick.ts) predicts every live coin's next 2, 5 and 15 minutes. Its books buy when the prediction
// beats the coin's round-trip cost (by 0 or 5 points), hold up to the horizon (sooner on a 2x target, the trail or the
// stop), on paper. Two books per horizon. The desk follows one only through the exams.
export const TICK_MARGINS = [0, 0.05];
export const tickExit = (h: number): GExit => ({ initials: 2, trail: 0.25, stop: 0.3, timeMin: h, mig: "sell" });
export const tickKey = (h: number, m: number) => `tick:h${h}m${Math.round(m * 100)}|now|${keyOf("all", "now", tickExit(h)).split("|")[2]}`;
export function seedTick(now: number, ready: (h: number) => boolean, horizons: number[]): LBook[] {
  const out: LBook[] = [];
  for (const h of horizons) {
    if (!ready(h)) continue;
    for (const m of TICK_MARGINS) {
      const key = tickKey(h, m);
      if (BOOKS.some((b) => b.key === key)) continue;
      const b: LBook = { key, label: `TICK MODEL: predicted ${h}-minute return beats the coin's costs${m ? ` by ${Math.round(m * 100)}+ points` : ""}`, filter: "all", mode: "now", exit: tickExit(h), since: now, grid: { testN: 0, testAvg: 0, pass: false, explore: true }, by: "tick", tick: { h, m } };
      const ts = TRIPS.filter((t) => t.k === key);
      if (ts.length && dropReason(bookStat(b, ts)) && !young(b, now)) continue;
      out.push(b);
    }
  }
  if (out.length) BOOKS = [...BOOKS, ...out];
  return out;
}
/** A TICK signal (worker): the books of that horizon whose margin it beats start their entry (2 seconds later). */
export function gridLiveTick(mint: string, symbol: string, h: number, ev: number, now = Date.now()) {
  const last = LAST.get(mint);
  if (!last || last.done || !(last.px > 0)) return 0;
  let n = 0;
  for (const b of BOOKS) {
    if (!b.tick || b.tick.h !== h || ev < b.tick.m) continue;
    if (PEND.has(id(b.key, mint)) || POS.has(id(b.key, mint))) continue;
    // sized by the prediction when the desk follows: 1x at the margin, up to 2x for a prediction 10 points above it
    const mult = Math.round(Math.max(0.5, Math.min(2, 1 + (ev - b.tick.m) * 10)) * 100) / 100;
    PEND.set(id(b.key, mint), { key: b.key, mint, symbol, callAt: now, p0: last.p, px0: last.px, until: now + 30_000, fillAfter: now + 2_000, mult });
    earlyFollow(b, PEND.get(id(b.key, mint)), now); // v0.1.138b
    n++;
  }
  return n;
}

function seedRunners(now: number): LBook[] {
  const out: LBook[] = [];
  let room = RUNNER_MAX - BOOKS.filter((b) => !b.cold && b.by === "runner" && !b.fv).length;
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
  let room = WALLETS_MAX - BOOKS.filter((b) => !b.cold && b.by === "wallets" && !b.fv).length;
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
export const researchRoom = () => Math.max(0, RESEARCH_MAX - BOOKS.filter((b) => !b.cold && b.by === "researcher" && !b.fv).length);
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
  RECHECK.clear();
  TRIG.clear();
  CHECK.clear();
  QUEUE.length = 0;
  SPAWNED = [];
  LEADER = null;
  EVER.clear();
  RUG_LIVE = new Set(SAFE_DEFAULT);
  RUG_AT = 0;
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
export const _setLeaders = (ks: string[]) => ((LEADERS = new Set(ks)), (LEADER = ks[0] ?? null));
export const _setTrips = (t: LTrip[]) => (TRIPS = t);
