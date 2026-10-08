import { PublicKey } from "@solana/web3.js";
import { launchesCached } from "./lcache";
import { CALL_MAX_AGE_MS, CALL_ON_TIME_MS, CHECKPOINTS, PUMP_MINT_AUTHORITY } from "@/config/site";
import { K, dayKey, hourKey, redis } from "./redis";
import { conn, parsedTx, fetchOffchain, getCurves, parseCreateTx, pmap, safeErr, solUsd, lane, RPS } from "./solana";
import { score, Verdict, KING_VERSION, verdictOf } from "./king";
import { assignWork, recordWork } from "./rats";
import { getSettings } from "./settings";
import { contributions, emptyModel, features, FeatureInput, learn, NanoModel, nanoReady, nanoScore, NANO_MIN, NANO_V } from "./nano";
import { readTape, Tape } from "./tape";
import { whyOf, type Why } from "./why";
import { noteCall } from "./receipts";
import { queueBonded, queueCall } from "./tg";
import { reviewCall } from "./film";
import { pulseMatch, pulseView } from "./pulse";
import { candidatesOf, closeTweet, dueTweets, matchOne, noteBondLink, noteMatch, noteOutcome, noteTweetLink, recentTweets, tweetIdOf, tweetLinks, accountOf, type WireMatch, type XTweet } from "./wire";
import { creditResolve, GK, Graph, readGraph } from "./graph";
import { Meta, metaBond, metaLaunch, readMeta } from "./meta";
import { enroll, Run, runnerPass } from "./runner";
import { migrated, poolUsd, readPools } from "./pool";
import { ensureEpoch } from "./epoch";
import { acquire, holds, release, withLock, type Lock } from "./lock";
import { trackFees, trackWeights } from "./fees";
import { agentLog } from "./agents";
import { enqueueLens } from "./lens";
import { enqueueMind } from "./mind";
import { addVamp, featOf, loadW, notePickSet, pickedOn, pickLessons, scoreOf, vampWatch, VAMP_MAX, type Cand } from "./picker";
import { KING_V1, computeCal, loadCal, noteCal, posWeight, v1Verdict, type Cal } from "./kingcal";
import { ensureSolHistory, recordSol, Regime, regimeAt } from "./regime";
import { memo } from "./memo";
import { bwMul } from "./bwgov";

// Extra reads for the coins worth it (curve high enough at the read): trades, wallets, narrative.
type Extra = { tape: Tape | null; g: Graph | null; meta: Meta | null; px: number; rg?: Regime | null };
const REPLAY_KEY = "rn:replay"; // recent lessons, replayed in small batches so the models learn faster
const REPLAY_MAX = 4000;
const REPLAY_PER_RUN = 64;
// Tapes are the expensive read (~30 RPC calls each). Scaled to the RPC plan: 2 per run on Helius free (10/s), 12 at 50/s.
const MAX_TAPES_PER_RUN = Math.max(2, Math.min(12, Math.floor(RPS / 4)));
// Every lesson waits for the same label window: "bonded within 2h". Without it, winners (which bond in minutes) would be
// learned long before losers (which take up to 24h to resolve), and the models would learn that everything bonds.
// Research: 85% of graduates bond within an hour (pumpfundata, Apr 2026), so 2h keeps label noise and lag small.
export const LABEL_MS = 2 * 3600_000;

export type Outcome = "BONDED" | "ALIVE" | "DIED";
type Stage = keyof typeof CHECKPOINTS;
type Cp = { p: number; mcap: number; at: number };

export type Launch = {
  mint: string;
  sig: string;
  createdAt: number;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  image: string;
  description: string;
  twitter: string;
  telegram: string;
  website: string;
  devBuySol: number;
  devN: number; // creator's launches before this one (since the rats started digging)
  devB: number; // of which bonded
  dugAt: number;
  dugBy: string;
  p0: number;
  mcap0: number;
  pNow?: number;
  mcapNow?: number;
  peak?: number;
  near?: boolean;
  cp: Partial<Record<Stage, Cp>>;
  call?: Call;
  early?: { at: number; score: number; verdict: Verdict; curve: number; x: number[] } | null; // minute-1 read
  xpre?: number[]; // v0.1.27 and older: dig-time features of a coin that bonded before its call (no longer learned)
  learned?: boolean;
  tape?: Tape | null;
  g?: Graph | null;
  meta?: Meta | null;
  outcome?: Outcome;
  resolvedAt?: number;
  bondSecs?: number;
  wire?: WireMatch | null; // born from a tracked X post (see lib/wire.ts)
  pulse?: { term: string; x: number; mood: string } | null; // named after a narrative rising on X right now (see lib/pulse.ts)
  completeAt?: number; // curve hit 100%: waiting for proof it migrated into its canonical pool
  stuck?: boolean; // curve completed but never migrated: not a graduation
  supply?: number; // token supply from the curve (1B on standard pump.fun)
};

export type Call = {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  createdAt: number;
  at: number;
  score: number;
  verdict: Verdict;
  counted: boolean;
  progress: number;
  version: string;
  nano: { score: number; verdict: Verdict } | null;
  x: number[];
  outcome: Outcome | null;
  devN?: number;
  devB?: number;
  soc?: number;
  px?: number; // curve price (SOL) at the call, so the desk knows when it would be chasing
  farm?: string; // why the tape flagged it as a farm (never sent to the desk)
  why?: Why; // the reasons behind the score, in plain words
  v0?: { score: number; verdict: Verdict }; // v0 rules, kept on the card once v1 (nano-led) makes the call
  parts?: Record<string, number>; // v0 points per rule (admin scorecard)
  nc?: [string, number][]; // nano: strongest feature pulls on the logit (admin scorecard)
  tp?: { n: number; uniq: number; spb: number; bs: number; sn: number; sm: number; cl: number; ds: number } | null; // tape + graph summary
};

/** Compact row for the explorer index (short keys keep the payload small). */
export type IdxRow = {
  m: string; // mint
  s: string; // symbol
  n: string; // name
  t: number; // created
  v: number; // v0 score
  V: string; // v0 verdict B/W/D
  ns: number | null; // nano score
  NV: string; // nano verdict or ""
  o: string; // outcome B/A/D or "" pending
  p: number; // curve at call
  c: 0 | 1; // counted
  dn: number;
  db: number;
  so: number; // socials count
  bs: number | null; // seconds to bond
};

const IDX_WINDOW_MS = 24 * 3600_000;

function idxRow(call: Call, bondSecs?: number): IdxRow {
  return {
    m: call.mint,
    s: (call.symbol || "").slice(0, 12),
    n: (call.name || "").slice(0, 24),
    t: call.createdAt,
    v: call.score,
    V: call.verdict[0],
    ns: call.nano?.score ?? null,
    NV: call.nano ? call.nano.verdict[0] : "",
    o: call.outcome ? call.outcome[0] : "",
    p: call.progress,
    c: call.counted ? 1 : 0,
    dn: call.devN ?? 0,
    db: call.devB ?? 0,
    so: call.soc ?? 0,
    bs: bondSecs ?? null,
  };
}

// v0.1.41: the worker keeps the explorer index in memory (it is the only writer); the explorer page is built from it
// once a minute instead of every server instance reading the whole hash (a day of calls, up to ~1MB)
let IDXM: Map<string, IdxRow> | null = null;
let IDXM_AT = 0;
export async function idxRows(): Promise<IdxRow[]> {
  if (!IDXM || Date.now() - IDXM_AT > 30 * 60_000) {
    const h = ((await redis().hgetall<Record<string, IdxRow>>(K.idx)) || {}) as Record<string, IdxRow>;
    IDXM = new Map(Object.entries(h));
    IDXM_AT = Date.now();
  }
  return Array.from(IDXM.values());
}

/** The explorer keeps every call the King or nano liked, plus every coin that bonded, for 24h. */
function indexCall(c: Ctx, call: Call, bondSecs?: number) {
  const liked = call.verdict !== "DUST" || (call.nano && call.nano.verdict !== "DUST");
  if (!liked && call.outcome !== "BONDED") return;
  const row = idxRow(call, bondSecs);
  IDXM?.set(call.mint, row);
  c.p.hset(K.idx, { [call.mint]: row });
  c.p.zadd(K.idxT, { score: call.createdAt, member: call.mint });
}

export type Grad = {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  createdAt: number;
  bondedAt: number;
  secs: number;
  devN: number;
  v0: { score: number; verdict: Verdict; counted: boolean } | null;
  nano: { score: number; verdict: Verdict } | null;
  lead?: number | null; // seconds between the King's call and the bond
};

const HR_TTL = 60 * 60 * 24 * 3;
const bucket = (score: number) => Math.min(9, Math.max(0, Math.floor(score / 10)));
function hrInc(c: Ctx, at: number, field: string, n = 1) {
  const k = K.hr(hourKey(at));
  c.p.hincrby(k, field, n);
  c.p.expire(k, HR_TTL);
  // the same counter per day (kept 120 days) for the long-range charts on the feed
  const dk = `rn:dayh:${new Date(at).toISOString().slice(0, 10)}`;
  c.p.hincrby(dk, field, n);
  c.p.expire(dk, 120 * 86400);
}

export type FeedItem = {
  kind: "dig" | Stage | "call" | "resolve" | "near" | "grad";
  rat: string;
  mint: string;
  symbol: string;
  name: string;
  at: number;
  text: string;
};

const LAUNCH_TTL = 60 * 60 * 30;
const DEAD_TTL = 60 * 60 * 6;
const BONDED_TTL = 60 * 60 * 24 * 7;
const CALL_TTL = 60 * 60 * 24 * 2;
const MAX_TX_PER_RUN = 60;
export const BOND_CALLS = "rn:bondcalls"; // newest counted BOND calls (mints)
const MAX_DUE_PER_RUN = 300;
const FRESH_MS = 10 * 60_000;
const EARLY_MAX_AGE_MS = 3 * 60_000; // a minute-1 read later than 3 minutes is skipped, not made late
const MAX_HOT_PER_RUN = 300;
const HOT_MIN = 2; // curve % that puts a launch on the hot watch
const HOT_TOP = 200; // highest curves checked every run
const HOT_ROT = 200; // plus a rotating slice of the rest of the hot set
export const EARLY_DEATH = { curve: 1, peak: 3 }; // at the 1h check: under 1% now and never above 3% = DIED

type Pipe = ReturnType<ReturnType<typeof redis>["pipeline"]>;
type Ctx = {
  p: Pipe;
  now: number;
  feed: FeedItem[];
  stat: Record<string, number>;
  model: NanoModel;
  modelDirty: boolean;
  model1: NanoModel;
  model1Dirty: boolean;
  nanoLog: { n: number; loss: number; acc: number; pos: number; at: number }[];
  ops: NanoOp[]; // lessons for the live models, applied atomically in flush (see applyNano)
};

// Models are loaded once per dig() and shared by every step of the run.
let M1: NanoModel = emptyModel();
// Coins that bonded or stopped during this run, for the runner model; USD market caps the rats read off the curves.
let RUN_EV: { bonded: string[]; died: string[]; stuck: string[] } = { bonded: [], died: [], stuck: [] };
let CURVE_USD: Record<string, number> = {};
let SOL_USD = 0;
let CAL: Cal | null = null; // King v1 lines (lib/kingcal.ts), reloaded every dig
let CAL_AT = 0;

function newCtx(model: NanoModel): Ctx {
  return { p: redis().pipeline(), now: Date.now(), feed: [], stat: {}, model, modelDirty: false, model1: M1, model1Dirty: false, nanoLog: [], ops: [] };
}
const inc = (c: Ctx, k: string, n = 1) => (c.stat[k] = (c.stat[k] || 0) + n);

async function flush(c: Ctx) {
  const p = c.p;
  for (const [k, v] of Object.entries(c.stat)) p.hincrby(K.stat, k, v);
  if (c.stat.bonded) {
    p.hincrby(K.day(dayKey()), "bonded", c.stat.bonded);
  }
  if (c.feed.length) {
    p.lpush(K.feed, ...c.feed);
    p.ltrim(K.feed, 0, 299);
  }
  await p.exec();
  if (c.ops.length) await applyNano(c.ops);
}

export type NanoOp = { k: 0 | 1; x: number[]; y: boolean; pw?: number; sw?: number; rp?: boolean };

/**
 * The only way the live models (nano and nano-1) are trained: under a lock, on the latest saved copy. Before
 * v0.1.22 the rats' lanes and the historian each loaded the model, trained their own copy for up to a minute and
 * saved it over the others: whole batches of lessons were lost, and the training-loss chart jumped backwards
 * (the zigzag at the end of the line on /lab).
 */
const NANO_PENDING = "rn:nano:pending"; // lessons waiting for the trainer when the lock was busy
/**
 * Curve % a launch needs for the rats to read its trades (v0.1.34: at least 8% at minute 5 and 5% at minute 1). A tape
 * is ~42 chain reads; without stream trades every tape comes from the chain. Settings saved before v0.1.34 kept 5/3,
 * so the floor applies whatever is stored. The historian uses the same floor (what the models learn on matches live).
 */
export function tapeFloor(d: { tapeMinCurve?: number; earlyMinCurve?: number }) {
  return { t5: Math.max(8, Number(d?.tapeMinCurve ?? 8)), t1: Math.max(5, Number(d?.earlyMinCurve ?? 5)) };
}

// v0.1.40: the trainer keeps both models in memory with the version it saved; it re-reads them only when another
// process saved since (the version moved). Before, every lesson batch (every ~4s) read both models first.
const NANO_VER = "rn:nano:ver";
let NANO_MEM: { ver: string; m: NanoModel; m1: NanoModel } | null = null;
export async function applyNano(ops0: NanoOp[]) {
  if (!ops0.length) return;
  const r = redis();
  let l: Lock | null = null;
  for (let i = 0; i < 30 && !l; i++) {
    l = await acquire("rn:lock:nano", 15_000);
    if (!l) await new Promise((res) => setTimeout(res, 100));
  }
  if (!l) {
    // never train without the lock (that was the lost-lessons bug): park the lessons, the next holder learns them
    await r.rpush(NANO_PENDING, ...ops0).catch(() => {});
    await r.ltrim(NANO_PENDING, -20_000, -1).catch(() => {});
    return;
  }
  try {
    await migrateNanoHeld();
    const parked = ((await r.lpop<NanoOp[]>(NANO_PENDING, 2000).catch(() => null)) || []) as NanoOp[];
    const ops = [...(Array.isArray(parked) ? parked : []), ...ops0];
    const ver = String((await r.get(NANO_VER).catch(() => "x")) ?? "0");
    if (!NANO_MEM || NANO_MEM.ver !== ver || ver === "x") {
      const [a, b] = await Promise.all([loadModel(), loadModel(K.nano1)]);
      NANO_MEM = { ver, m: a, m1: b };
    }
    // learn on copies: if the save below does not happen, memory must not run ahead of Redis
    const m: NanoModel = structuredClone(NANO_MEM.m);
    const m1: NanoModel = structuredClone(NANO_MEM.m1);
    const logs: { n: number; loss: number; acc: number; pos: number; at: number }[] = [];
    let d0 = false;
    let d1 = false;
    for (const o of ops) {
      if (o.k === 0) {
        learn(m, o.x, o.y, o.pw, o.sw ?? 1, !!o.rp);
        d0 = true;
        if (!o.rp && m.n % 25 === 0) logs.push({ n: m.n, loss: round4(m.loss), acc: round4(m.acc), pos: m.pos, at: Date.now() });
      } else {
        learn(m1, o.x, o.y, o.pw, o.sw ?? 1, !!o.rp);
        d1 = true;
      }
    }
    const p = r.pipeline();
    if (d0) p.set(K.nano, m);
    if (d1) p.set(K.nano1, m1);
    // v0.1.41: a fresh random version (a counter could be deleted and climb back to the same number)
    const newVer = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    p.set(NANO_VER, newVer);
    for (const l of logs) p.rpush(K.nanoLog, l);
    if (logs.length) p.ltrim(K.nanoLog, -500, -1);
    // a lock that expired mid-training: another trainer may have saved since; park these instead of overwriting it
    if (!(await holds(l))) {
      await r.rpush(NANO_PENDING, ...ops).catch(() => {});
      return;
    }
    await p.exec();
    NANO_MEM = { ver: newVer, m, m1 };
  } finally {
    await release(l);
  }
}

/**
 * King v1.1 (v0.1.29): move nano and nano-1 to the v2 learner, once. The v1 models are kept (rn:nano:v1, rn:nano1:v1).
 * The new ones start warm: the last 4,000 live lessons are learned once in order (counted) and twice more shuffled
 * (replays), so they are useful from the first call instead of starting at zero. The historian then replays its
 * window again with the v0.1.28 clean labels, and the runner model starts over on the same learner.
 */
// v0.1.41: warm-started once more, because the history flag was standardized (live coins were pushed toward BOND):
// the models restart from the stored live lessons, and the historian replays its window again (lib/nano.ts zOf)
const WARM = "0.1.41";
export async function migrateNano() {
  const l = await acquire("rn:lock:nano", 60_000);
  if (!l) return { nano: "busy" };
  try {
    return await migrateNanoHeld();
  } finally {
    await release(l);
  }
}
let nanoChecked = false; // v0.1.40: the version check needs one read per process, not one per training batch
async function migrateNanoHeld() {
  if (nanoChecked) return { nano: "v2" };
  const r = redis();
  const cur = await r.get<NanoModel>(K.nano);
  if (cur?.v === NANO_V && cur.warm === WARM) nanoChecked = true;
  // "warm" marks the build that warm-started it: v0.1.30 does it once more, because the v0.1.28 code ran for a few
  // minutes on 7 Oct (a reverted push) and trained the new model the old way
  if (cur?.v === NANO_V && cur.warm === WARM) return { nano: "v2" };
  const lessons = (((await r.lrange<Lesson>(REPLAY_KEY, 0, -1).catch(() => [])) || []) as Lesson[]).reverse(); // oldest first
  const m = emptyModel();
  const m1 = emptyModel();
  m.warm = m1.warm = WARM;
  for (const l of lessons) {
    if (l.x) learn(m, l.x, l.y === 1);
    if (l.x1) learn(m1, l.x1, l.y === 1);
  }
  for (let e = 0; e < 2; e++) {
    const sh = lessons.slice().sort(() => Math.random() - 0.5);
    for (const l of sh) {
      if (l.x) learn(m, l.x, l.y === 1, undefined, 0.5, true);
      if (l.x1) learn(m1, l.x1, l.y === 1, undefined, 0.5, true);
    }
  }
  const old1 = await r.get<NanoModel>(K.nano1);
  const p = r.pipeline();
  if (cur && cur.v !== NANO_V) p.set("rn:nano:v1", cur);
  if (old1 && old1.v !== NANO_V) p.set("rn:nano1:v1", old1);
  p.set(K.nano, m);
  p.set(K.nano1, m1);
  p.del(NANO_VER);
  NANO_MEM = null;
  // v0.1.41: the historian replays its window again, so the wallet and cluster records it credited start over too
  // (else every replayed launch would be counted twice). Funders (fof) stay: they are facts, not counts.
  if (WARM === "0.1.41") p.del(GK.cN, GK.cB, GK.cM, GK.sN, GK.sB, GK.sM);
  // the historian walks its window again (clean labels since v0.1.28), the runner model starts over on v2
  p.del("rn:h:state2", "rn:h:q2", "rn:h:seen", "rn:runner", K.nanoLog);
  p.lpush(K.deskEv, { agent: "KING", at: Date.now(), text: `King v1.1: nano rebuilt (standardized inputs, small capped steps, one class weight). warm start on ${lessons.length} recent lessons, ${m.pos} bonds. v0 rules call until v1.1's own lines are calibrated`, tone: "info" });
  await p.exec();
  return { nano: "migrated", lessons: lessons.length };
}

export async function loadModel(key: string = K.nano): Promise<NanoModel> {
  const m = await redis().get<NanoModel>(key);
  return m && Array.isArray(m.w) ? m : emptyModel();
}

/** True while the always-on worker is running its loops (it writes rn:worker:at every 20s). */
export async function workerAlive() {
  if (process.env.RATNET_WORKER) return false; // the worker itself
  const w = Number((await redis().get("rn:worker:at").catch(() => 0)) || 0);
  return Date.now() - w < 90_000;
}

/**
 * One full dig: the fallback for when the worker is down (the minute ping). It holds both of the worker's lane locks,
 * so it can never run next to them. Before v0.1.25 every open page POSTed /api/dig every 15s and ran this on Vercel
 * next to the worker, on its own lock and its own RPC limiter: due checkpoints and lessons were processed twice and
 * the two limiters together went far over the plan (the 429 storms).
 */
export async function dig(): Promise<Record<string, unknown>> {
  if (await workerAlive()) return { skipped: "worker" };
  const out = await withLock("rn:lock:digfast", 150_000, () => withLock("rn:lock:digslow", 300_000, () => lane.run(1, digInner)));
  return out as Record<string, unknown>;
}

async function digInner(): Promise<Record<string, unknown>> {
  const started = Date.now();
  try {
    const ep = await ensureEpoch().catch((e) => ({ epochError: safeErr(e) }));
    const model = await loadModel();
    M1 = await loadModel(K.nano1);
    RUN_EV = { bonded: [], died: [], stuck: [] };
    CURVE_USD = {};
    SOL_USD = (await solUsd().catch(() => null)) || SOL_USD;
    await recordSol(SOL_USD).catch(() => {});
    ensureSolHistory().catch(() => {});
    CAL = await loadCal().catch(() => CAL);
    if (Date.now() - CAL_AT > 600_000) {
      CAL_AT = Date.now();
      CAL = await computeCal().catch(() => CAL);
    }
    const dug = await digNew(model);
    const tl = await tweetLinks().catch((e) => ({ tlinkError: safeErr(e) }));
    const wire = await wirePicks().catch((e) => ({ wireError: safeErr(e) }));
    const due = await processDue(model);
    const hot = await hotWatch(model);
    const mig = await migrations(model).catch((e) => ({ migError: safeErr(e) }));
    const les = await lessons(model);
    const run = await runnerPass(CURVE_USD, RUN_EV, SOL_USD).catch((e) => ({ runnerError: safeErr(e) }));
    // live $RAT fee pool and payout weights for the money pages (each throttled, cheap when fresh)
    await Promise.all([trackFees().catch(() => null), trackWeights().catch(() => null)]);
    return { ok: true, ...(ep || {}), ...dug, ...tl, ...wire, ...due, ...hot, ...mig, ...les, ...run, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: safeErr(e) };
  }
}

/** Shared state for a dig pass (models, SOL price, calibration). */
// v0.1.38: the fast lane runs every second and used to read both models, the calibration and the epoch from Redis
// and write the SOL price on every pass (~6 commands a second, the models are tens of KB each). The fast lane only
// scores, so it reads them at most every 15s (calibration every 60s, epoch every 5 minutes); the slow lane, which
// learns and writes the model, still reads it fresh every pass. The SOL price is written once an hour.
let solHourWritten = "";
async function digPrep(fast = false) {
  await memo(fast ? "dig:epoch" : "dig:epoch:slow", fast ? 300_000 : 60_000, () => ensureEpoch().catch(() => null));
  // v0.1.40: the slow lane too (it only scores with them; applyNano trains on its own copy under the lock)
  void fast;
  const model = await memo("dig:nano", 15_000, () => loadModel());
  M1 = await memo("dig:nano1", 15_000, () => loadModel(K.nano1));
  SOL_USD = (await solUsd().catch(() => null)) || SOL_USD;
  const hr = new Date().toISOString().slice(0, 13);
  if (hr !== solHourWritten && SOL_USD) {
    solHourWritten = hr;
    await recordSol(SOL_USD).catch(() => (solHourWritten = ""));
  }
  CAL = await memo("dig:cal", 60_000, () => loadCal()).catch(() => CAL);
  if (Date.now() - CAL_AT > 600_000) {
    CAL_AT = Date.now();
    CAL = await computeCal().catch(() => CAL);
  }
  return model;
}

/**
 * The worker's fast lane (every ~1s): fill launches the stream missed, WIRE picks, and the minute-1 reads and
 * minute-5 calls the moment they are due. Before v0.1.21 all of this waited behind the slow work below in one pass,
 * and launches were dug ~12 minutes late, so the "minute-5" call was made at minute 12.
 */
let lastBackfill = 0;
const BACKFILL_MS = Number(process.env.BACKFILL_MS || 10_000);
export async function digFast(): Promise<Record<string, unknown>> {
  const out = await withLock("rn:lock:digfast", 60_000, () => lane.run(1, async () => {
    const t0 = Date.now();
    try {
      const model = await digPrep(true); // v0.1.40: models from memory (15s), both lanes only score with them
      // the chain backfill (launches the stream missed) every 10s instead of every pass: one call a second was ~86K
      // credits a day on its own, and the stream already delivers nearly every launch within a second (v0.1.36)
      const dug = Date.now() - lastBackfill >= BACKFILL_MS ? ((lastBackfill = Date.now()), await digNew(model).catch((e) => ({ digError: safeErr(e) }))) : { dug: 0 };
      const wire = await wirePicks().catch((e) => ({ wireError: safeErr(e) }));
      const due = await processDue(model);
      return { ok: true, ...dug, ...wire, ...due, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: safeErr(e) };
    }
  }));
  return out as Record<string, unknown>;
}

/** The worker's slow lane (every ~4s): hot curves re-read, migrations, lessons, runners, fees. */
export async function digSlow(): Promise<Record<string, unknown>> {
  const out = await withLock("rn:lock:digslow", 90_000, () => lane.run(1, async () => {
    const t0 = Date.now();
    try {
      const model = await digPrep(true); // v0.1.40: models from memory (15s), both lanes only score with them
      const tl = await tweetLinks().catch((e) => ({ tlinkError: safeErr(e) }));
      const hot = await hotWatch(model);
      const mig = await migrations(model).catch((e) => ({ migError: safeErr(e) }));
      const les = await lessons(model);
      // the runner pass takes the events gathered since its last run (from both lanes), then starts a fresh list
      const ev = RUN_EV;
      const cu = CURVE_USD;
      RUN_EV = { bonded: [], died: [], stuck: [] };
      CURVE_USD = {};
      const run = await runnerPass(cu, ev, SOL_USD).catch((e) => ({ runnerError: safeErr(e) }));
      await Promise.all([trackFees().catch(() => null), trackWeights().catch(() => null)]);
      return { ok: true, ...tl, ...hot, ...mig, ...les, ...run, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: safeErr(e) };
    }
  }));
  return out as Record<string, unknown>;
}

// ---------------------------------------------------------------- new launches

export const LAT = (k: string) => `rn:lat:${k}`; // last 200 latencies (seconds) per step, for the speed panel
const SEEN_SIG = (sig: string) => `rn:sig:${sig}`; // create txs the PumpPortal stream already delivered

async function digNew(model: NanoModel) {
  const r = redis();
  const cursor = (await r.get<string>(K.cursor)) || undefined;
  const raw = await conn().getSignaturesForAddress(new PublicKey(PUMP_MINT_AUTHORITY), {
    until: cursor,
    limit: cursor ? 1000 : 40,
  });
  if (!raw.length) return { dug: 0 };
  if (cursor && raw.length >= 1000) await r.hincrby(K.stat, "gaps", 1);

  // only launches at least 20s old: the stream delivers and stores a launch within a few seconds, and the backfill is
  // for the ones it missed. v0.1.28 read the youngest ones while the stream was still storing them, so most launches
  // were paid for twice (part of the ~18 calls a second on the rats' lane)
  const all = [...raw].reverse();
  const young = all.findIndex((x) => !x.blockTime || Date.now() - x.blockTime * 1000 < 20_000);
  const oldestFirst = young < 0 ? all : all.slice(0, young);
  if (!oldestFirst.length) return { dug: 0, waiting: all.length };
  // the stream normally delivers every launch within a second: the chain read only fills what it missed, so a
  // launch the stream already brought costs nothing here (no parse, no RPC) and the backfill keeps up easily
  const seen = await r.mget<(number | null)[]>(...oldestFirst.map((x) => SEEN_SIG(x.signature))).catch(() => [] as (number | null)[]);
  // v0.1.36: a launch older than 10 minutes is past its minute-1 read and its minute-5 call, so it is not read at all.
  // After a budget pause the backfill used to read the whole gap (up to 1,000 creates) the moment the day reset, and
  // spent the day's head start in minutes (8 Oct: 10.8K credits in the first 9 minutes, then the rats paused again)
  const STALE_MS = 10 * 60_000;
  const unseen = oldestFirst.filter((x, i) => !seen[i] && !!x.blockTime && Date.now() - x.blockTime * 1000 < STALE_MS);
  const batch = unseen.slice(0, MAX_TX_PER_RUN);
  // cursor: past everything the stream covered, up to the last tx we parse now
  const lastIdx = batch.length ? oldestFirst.indexOf(batch[batch.length - 1]) : oldestFirst.length - 1;
  const newCursor = oldestFirst[unseen.length > MAX_TX_PER_RUN ? lastIdx : oldestFirst.length - 1].signature;
  const ok = batch.filter((x) => !x.err);
  if (!ok.length) {
    await r.set(K.cursor, newCursor);
    return { dug: 0, scanned: oldestFirst.length, skipped: oldestFirst.length - unseen.length };
  }

  const FAIL = Symbol("fail");
  const txs = await pmap(ok, 6, async (x) => {
    try {
      return parseCreateTx(
        x.signature,
        await parsedTx(x.signature)
      );
    } catch (e) {
      LAST_PARSE_ERR = safeErr(e);
      return FAIL as any;
    }
  });
  // a read that failed (timeout, budget, 5xx) is retried next pass: the cursor stops just before it. Before v0.1.28 the
  // cursor moved past failed reads and those launches were lost for good. A tx that fails 3 passes in a row is let go.
  let cursor2 = newCursor;
  const failIdx = txs.findIndex((t, i) => t === FAIL && (PARSE_FAILS.set(ok[i].signature, (PARSE_FAILS.get(ok[i].signature) || 0) + 1), PARSE_FAILS.get(ok[i].signature)! < 3));
  if (failIdx >= 0) {
    const at = oldestFirst.indexOf(ok[failIdx]);
    cursor2 = at > 0 ? oldestFirst[at - 1].signature : cursor || "";
  }
  // forget the oldest strikes only (a full clear used to restart the 3 strikes of every failing tx, an endless retry)
  if (PARSE_FAILS.size > 500) for (const k of Array.from(PARSE_FAILS.keys()).slice(0, 250)) PARSE_FAILS.delete(k);
  const setCursor = () => (cursor2 ? r.set(K.cursor, cursor2) : Promise.resolve(null));
  const launches = txs.filter((x): x is NonNullable<ReturnType<typeof parseCreateTx>> => !!x && x !== FAIL);
  if (!launches.length) {
    await setCursor();
    return { dug: 0, scanned: batch.length, ...(failIdx >= 0 ? { retry: txs.filter((t) => t === FAIL).length, why: LAST_PARSE_ERR.slice(0, 60) } : {}) };
  }
  const res = await ingest(model, launches, "chain");
  // marked seen only once the launch is stored: a failed ingest is dug again on the next pass
  const lagP = r.pipeline();
  for (const l of launches) {
    lagP.lpush(LAT("intake_rpc"), Math.round((Date.now() - l.createdAt) / 1000));
    lagP.set(SEEN_SIG(l.sig), 1, { ex: 3 * 3600 });
  }
  lagP.ltrim(LAT("intake_rpc"), 0, 199);
  await lagP.exec().catch(() => {});
  await setCursor();
  return { ...res, scanned: batch.length, behind: raw.length - batch.length, ...(failIdx >= 0 ? { retry: txs.filter((t) => t === FAIL).length, why: LAST_PARSE_ERR.slice(0, 60) } : {}) };
}
let LAST_PARSE_ERR = "";
const PARSE_FAILS = new Map<string, number>();

/** Launches straight from the PumpPortal stream (worker): dug about a second after they are born, no chain read. */
export async function ingestStream(items: { mint: string; sig: string; creator: string; name: string; symbol: string; uri: string; devBuySol: number; createdAt: number }[]) {
  return lane.run(1, async () => {
    const r = redis();
    // a launch without its signature is still stored (only the backfill's "already seen" mark needs the signature)
    const fresh = items.filter((x) => x.mint);
    if (!fresh.length) return { dug: 0 };
    // never overwrite a launch already dug (the chain backfill may have it)
    const have = await r.mget<(Launch | null)[]>(...fresh.map((x) => K.launch(x.mint))).catch(() => [] as (Launch | null)[]);
    const todo = fresh.filter((_, i) => !have[i]);
    const markSeen = async (xs: typeof fresh) => {
      if (!xs.length) return;
      const p = r.pipeline();
      for (const x of xs) if (x.sig) p.set(SEEN_SIG(x.sig), 1, { ex: 3 * 3600 });
      await p.exec().catch(() => {});
    };
    await markSeen(fresh.filter((_, i) => !!have[i]));
    if (!todo.length) return { dug: 0 };
    const model = await memo("dig:nano", 15_000, () => loadModel());
    if (!SOL_USD) SOL_USD = (await solUsd().catch(() => null)) || SOL_USD;
    // seen only after the launch is stored: if ingest fails, the chain backfill digs it (before v0.1.28 it was marked
    // seen first, so a failed ingest lost the launch for good)
    const out = await ingest(model, todo, "stream");
    await markSeen(todo);
    return out;
  });
}

/** Every new launch, from the stream or the chain: metadata, dev record, WIRE and PULSE matches, the checkpoints. */
async function ingest(model: NanoModel, launches: { mint: string; sig: string; creator: string; name: string; symbol: string; uri: string; devBuySol: number; createdAt: number }[], via: "stream" | "chain") {
  const r = redis();
  const s = await getSettings();
  const creators = Array.from(new Set(launches.map((l) => l.creator).filter(Boolean)));
  const [off, curves, devN, devB] = await Promise.all([
    // metadata (IPFS): 1.5s at most, a slow gateway never holds the launch back (socials stay empty, LENS reads them later)
    pmap(launches, 12, (l) => fetchOffchain(l.uri, 1500)),
    // a failed curve read never drops the launches: they are stored at 0% and the hot watch reads the curve again
    getCurves(launches.map((l) => l.mint)).catch(() => ({} as Awaited<ReturnType<typeof getCurves>>)),
    creators.length ? r.hmget<Record<string, number>>(K.devN, ...creators) : Promise.resolve(null),
    creators.length ? r.hmget<Record<string, number>>(K.devB, ...creators) : Promise.resolve(null),
  ]);
  const work = await assignWork(launches.length, s);
  const c = newCtx(model);
  const p = c.p;
  const last: Record<string, unknown> = {};
  const seenDev: Record<string, number> = {};
  const posts: XTweet[] = await recentTweets().catch(() => []);
  const rising = (await pulseView().catch(() => null))?.rising || [];
  const dueAdds: { score: number; member: string }[] = [];
  const hotAdds: { score: number; member: string }[] = [];
  const radarAdds: { score: number; member: string }[] = [];

  launches.forEach((l, i) => {
    const o = off[i];
    const cv = curves[l.mint];
    const prior = Number(devN?.[l.creator] || 0) + (seenDev[l.creator] || 0);
    seenDev[l.creator] = (seenDev[l.creator] || 0) + 1;
    const rec: Launch = {
      ...l,
      image: o?.image || "",
      description: o?.description || "",
      twitter: o?.twitter || "",
      telegram: o?.telegram || "",
      website: o?.website || "",
      devN: prior,
      devB: Number(devB?.[l.creator] || 0),
      dugAt: c.now,
      dugBy: work.names[i],
      p0: cv?.progress ?? 0,
      mcap0: cv?.mcapSol ?? 0,
      pNow: cv?.progress ?? 0,
      peak: cv?.progress ?? 0,
      cp: {},
    };
    if (l.creator) p.hincrby(K.devN, l.creator, 1);
    metaLaunch(p, l.name, l.symbol);
    // WIRE: was this coin born from a tracked post?
    const wm = posts.length ? matchOne({ ...l, description: rec.description, twitter: rec.twitter }, posts) : null;
    const pm = !wm && rising.length ? pulseMatch(l, rising) : null;
    if (pm) rec.pulse = pm;
    // a post WIRE was not watching: fetch it (lib/wire.ts tweetLinks) and treat it as a match
    const tid = !wm ? tweetIdOf(rec.twitter, rec.description, rec.website) : null;
    if (tid) noteTweetLink(p, tid, l.mint, l.createdAt);
    if (wm) {
      rec.wire = wm;
      noteMatch(p, l.mint, l.createdAt, wm);
      agentLog(p, [{ agent: "WIRE", at: c.now, mint: l.mint, symbol: l.symbol, text: `$${l.symbol} launched ${wm.lagSec}s after @${wm.h} posted (${wm.how})`, tone: "info" }]);
    }
    const socials = [rec.twitter && "x", rec.telegram && "tg", rec.website && "web"].filter(Boolean).join(" ");
    const devTxt = prior > 0 ? ` · dev ${prior} prior${rec.devB ? `, ${rec.devB} bonded` : ""}` : "";
    c.feed.push({
      kind: "dig",
      rat: work.names[i],
      mint: l.mint,
      symbol: l.symbol,
      name: l.name,
      at: c.now,
      text: `dev buy ${l.devBuySol}◎ · curve ${rec.p0}%${socials ? " · " + socials : ""}${devTxt}`,
    });
    last[work.names[i]] = { mint: l.mint, symbol: l.symbol, at: c.now, kind: "dig" };

    if (cv?.complete) {
      completed(c, rec, LAUNCH_TTL);
      return;
    }
    p.set(K.launch(l.mint), rec, { ex: LAUNCH_TTL });
    (Object.keys(CHECKPOINTS) as Stage[]).forEach((st) => {
      const at = Math.max(l.createdAt + CHECKPOINTS[st], c.now + 1000);
      dueAdds.push({ score: at, member: `${l.mint}|${st}` });
    });
    if (rec.p0 >= HOT_MIN) {
      hotAdds.push({ score: l.createdAt, member: l.mint });
      radarAdds.push({ score: rec.p0, member: l.mint });
    }
  });
  if (dueAdds.length) p.zadd(K.due, dueAdds[0], ...dueAdds.slice(1));
  if (hotAdds.length) {
    p.zadd(K.hot, hotAdds[0], ...hotAdds.slice(1));
    p.zadd(K.radar, radarAdds[0], ...radarAdds.slice(1));
    p.zadd(K.peak, { gt: true }, radarAdds[0], ...radarAdds.slice(1));
  }

  inc(c, "dug", launches.length);
  const perHour: Record<number, number> = {};
  for (const l of launches) {
    const h = Math.floor(l.createdAt / 3600_000) * 3600_000;
    perHour[h] = (perHour[h] || 0) + 1;
  }
  for (const [h, n] of Object.entries(perHour)) hrInc(c, Number(h), "d", n);
  p.hincrby(K.day(dayKey()), "dug", launches.length);
  p.expire(K.day(dayKey()), 60 * 60 * 24 * 40);
  const lastL = launches[launches.length - 1];
  if (via === "chain" || Math.random() < 0.2) agentLog(p, [{ agent: "SCOUT", at: c.now, mint: lastL.mint, symbol: lastL.symbol, text: `dug ${launches.length} new launch${launches.length > 1 ? "es" : ""}${via === "stream" ? " the second they were born" : " the chain path caught"}, latest $${lastL.symbol}`, tone: "info" }]);
  await flush(c);
  await recordWork(work.counts, last, work.real);
  return { dug: launches.length, via };
}

// ---------------------------------------------------------------- resolution

function compactRow(l: Launch) {
  return {
    mint: l.mint,
    created_at: new Date(l.createdAt).toISOString(),
    name: l.name,
    symbol: l.symbol,
    description: l.description,
    twitter: l.twitter,
    telegram: l.telegram,
    website: l.website,
    creator: l.creator,
    dev_prior_launches: l.devN ?? 0,
    dev_prior_bonded: l.devB ?? 0,
    dev_buy_sol: l.devBuySol,
    curve_at_dig: l.p0,
    curve_5m: l.cp.t5?.p ?? null,
    curve_1h: l.cp.h1?.p ?? null,
    curve_24h: l.cp.d1?.p ?? null,
    curve_peak: l.peak ?? null,
    mcap_sol_5m: l.cp.t5?.mcap ?? null,
    mcap_sol_1h: l.cp.h1?.mcap ?? null,
    king_v0_score: l.call?.score ?? null,
    king_v0_verdict: l.call?.verdict ?? null,
    king_nano_score: l.call?.nano?.score ?? null,
    king_counted: l.call?.counted ?? null,
    features: l.call?.x ?? null,
    bond_secs: l.bondSecs ?? null,
    outcome: l.outcome,
  };
}

function resolve(c: Ctx, rec: Launch, outcome: Outcome, at = c.now) {
  const p = c.p;
  rec.outcome = outcome;
  rec.resolvedAt = c.now;
  inc(c, "resolved");
  inc(c, outcome.toLowerCase());

  const bonded = outcome === "BONDED";
  if (bonded) {
    RUN_EV.bonded.push(rec.mint);
    metaBond(p, rec.name, rec.symbol);
    // just migrated: LENS looks, then MIND judges whether it keeps going (most bonded coins dump within 20 minutes)
    enqueueLens(p, rec.mint, "bond");
    enqueueMind(p, rec.mint, "bonded");
    // every bonded coin is followed for a week so the runner model sees how far it really went
    if (!rec.tape) enroll(p, runOf(rec, c.now));
  } else RUN_EV.died.push(rec.mint);
  // wallet, cluster and early-read records are credited at the label window (see lessons()), never here

  if (outcome === "BONDED") {
    rec.bondSecs = Math.max(0, Math.round((at - rec.createdAt) / 1000));
    rec.peak = 100;
    rec.pNow = 100;
    if (rec.creator) p.hincrby(K.devB, rec.creator, 1);
    hrInc(c, rec.createdAt, "b");
    const call0 = rec.call;
    const lead = call0 ? Math.max(0, Math.round((c.now - call0.at) / 1000)) : null;
    if (call0?.counted) {
      // v0's own score: once v1 makes the call, call.score is nano's (before v0.1.28 the v0 table mixed both)
      p.hincrby(K.calib, `v${bucket(call0.v0?.score ?? call0.score)}b`, 1);
      if (call0.nano) p.hincrby(K.calib, `n${bucket(call0.nano.score)}b`, 1);
      if (call0.verdict === "BOND") {
        queueBonded(p, { mint: rec.mint, symbol: rec.symbol, score: call0.score, bondSecs: rec.bondSecs ?? 0, leadSecs: lead });
        hrInc(c, rec.createdAt, "bh");
        inc(c, "lead_sum", lead || 0);
        inc(c, "lead_n");
      }
      if (call0.nano?.verdict === "BOND") hrInc(c, rec.createdAt, "nbh");
    }
    const g: Grad = {
      mint: rec.mint,
      symbol: rec.symbol,
      name: rec.name,
      image: rec.image,
      createdAt: rec.createdAt,
      bondedAt: c.now,
      secs: rec.bondSecs,
      devN: rec.devN ?? 0,
      v0: rec.call ? { score: rec.call.score, verdict: rec.call.verdict, counted: rec.call.counted } : null, // the call as made (field name kept for old records)
      nano: rec.call?.nano || null,
      lead,
    };
    p.lpush(K.grads, g);
    p.ltrim(K.grads, 0, 299);
    const said = rec.call
      ? ` · king said ${rec.call.verdict} ${rec.call.score}${rec.call.verdict === "BOND" && lead ? ` ${fmtSecs(lead)} early` : ""}${rec.call.nano ? ` · nano ${rec.call.nano.score}` : ""}`
      : " · bonded before the call";
    c.feed.push({ kind: "grad", rat: "LEDGER", mint: rec.mint, symbol: rec.symbol, name: rec.name, at: c.now, text: `GRADUATED in ${fmtSecs(rec.bondSecs)}${said}` });
  } else {
    c.feed.push({
      kind: "resolve",
      rat: "LEDGER",
      mint: rec.mint,
      symbol: rec.symbol,
      name: rec.name,
      at: c.now,
      text: `${outcome}${rec.call ? ` · king said ${rec.call.verdict} ${rec.call.score}` : ""}`,
    });
  }

  if (rec.call) {
    const call = rec.call;
    call.outcome = outcome;
    p.set(K.call(rec.mint), call, { ex: CALL_TTL });
    if (call.counted) {
      tally(c, "", call.verdict, outcome);
      if (call.nano) tally(c, "n", call.nano.verdict, outcome);
    }
    indexCall(c, call, rec.bondSecs);
    p.lpush(K.callRes, call);
    p.ltrim(K.callRes, 0, 199);
    // the models learn this launch at createdAt + 2h (see LABEL_MS), not now
  }

  // Graduated before the 5-minute call: no lesson. Before v0.1.28 these were learned from dig-time features with
  // label "bonded" and nothing else: only winners got that shape of lesson (no losers looked like it), which taught
  // the models that a thin dig-time picture means BOND. Counted only, for the record.
  if (!rec.call && outcome === "BONDED") inc(c, "bond_precall");

  // WIRE learns which accounts' posts make coins that bond; bonded coins that link a post point at new accounts
  if (rec.wire) noteOutcome(p, rec.wire.h, outcome === "BONDED");
  if (outcome === "BONDED") noteBondLink(p, rec.twitter);
  // FILM: the call meets its outcome. Misses and false BONDs go to the film room with the reasons behind them.
  if (rec.call) {
    const why = rec.call.why || whyOf({ ...rec, progress: rec.call.progress, progress0: rec.p0, twitter: !!rec.twitter, telegram: !!rec.telegram, website: !!rec.website, tape: rec.tape ?? null, g: rec.g ?? null, meta: rec.meta ?? null });
    const fr = reviewCall(p, { ...rec.call, why }, outcome === "BONDED", rec.bondSecs ?? null);
    if (fr) agentLog(p, [{ agent: "FILM", at: c.now, mint: rec.mint, symbol: rec.symbol, text: fr.text, tone: fr.tone }]);
  }
  p.rpush(K.resolvedHour(hourKey(rec.createdAt)), compactRow(rec));
  p.expire(K.resolvedHour(hourKey(rec.createdAt)), 60 * 60 * 24 * 4);
  p.set(K.launch(rec.mint), rec, { ex: outcome === "BONDED" ? BONDED_TTL : DEAD_TTL });
  p.zrem(K.hot, rec.mint);
  p.zrem(K.radar, rec.mint);
  p.zrem(K.peak, rec.mint);
  p.zrem(K.due, ...(Object.keys(CHECKPOINTS) as Stage[]).map((st) => `${rec.mint}|${st}`));
}

function tally(c: Ctx, prefix: string, verdict: Verdict, outcome: Outcome) {
  const v = prefix + verdict.toLowerCase();
  inc(c, `${v}_res`);
  if (verdict === "BOND" && outcome === "BONDED") inc(c, `${v}_hit`);
  if (verdict === "DUST" && outcome !== "BONDED") inc(c, `${v}_hit`);
  if (verdict === "WATCH" && outcome === "BONDED") inc(c, `${v}_bonded`);
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
export function fmtSecs(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ---------------------------------------------------------------- checkpoints + calls

async function pruneIndex() {
  const r = redis();
  const old = (await r.zrange<string[]>(K.idxT, 0, Date.now() - IDX_WINDOW_MS, { byScore: true, offset: 0, count: 1000 })) || [];
  if (!old.length) return;
  const p = r.pipeline();
  p.hdel(K.idx, ...old);
  p.zrem(K.idxT, ...old);
  await p.exec();
  for (const m of old) IDXM?.delete(m);
}

export async function processDue(model: NanoModel) {
  const r = redis();
  const now = Date.now();
  await pruneIndex();
  // Fresh checkpoints first (the minute-1 reads and minute-5 calls are only worth anything on time), then the backlog.
  // Oldest-first alone let a backlog push every call past its 15-minute window.
  const fresh = ((await r.zrange<string[]>(K.due, now - FRESH_MS, now, { byScore: true, offset: 0, count: MAX_DUE_PER_RUN })) || []) as string[];
  const old = fresh.length < MAX_DUE_PER_RUN ? (((await r.zrange<string[]>(K.due, 0, now - FRESH_MS - 1, { byScore: true, offset: 0, count: MAX_DUE_PER_RUN - fresh.length })) || []) as string[]) : [];
  const members = [...fresh, ...old];
  if (!members.length) return { checked: 0 };

  const items = members.map((m) => {
    const [mint, stage] = m.split("|");
    return { m, mint, stage: stage as Stage };
  });
  const mints = Array.from(new Set(items.map((i) => i.mint)));
  const recsArr = await r.mget<(Launch | null)[]>(...mints.map((m) => K.launch(m)));
  const recs: Record<string, Launch> = {};
  mints.forEach((m, i) => {
    if (recsArr[i]) recs[m] = recsArr[i] as Launch;
  });
  const live = Object.keys(recs);
  const [curves, peaks] = await Promise.all([getCurves(live), live.length ? r.zmscore(K.peak, live) : Promise.resolve(null)]);
  const peakOf: Record<string, number> = {};
  live.forEach((m, i) => (peakOf[m] = Number(peaks?.[i] ?? 0)));
  if (SOL_USD) for (const m of live) if (curves[m] && !curves[m]!.complete) CURVE_USD[m] = curves[m]!.mcapSol * SOL_USD;
  const s = await getSettings();

  // Coins about to get a read (minute 1) or a call (minute 5): narrative for all, trades and wallets for the ones moving.
  const reading = items.filter((it) => {
    const rec = recs[it.mint];
    const cv = curves[it.mint];
    if (!rec || rec.outcome || !cv || cv.complete) return false;
    const age = now - rec.createdAt;
    return (it.stage === "t5" && !rec.call && age <= CALL_MAX_AGE_MS) || (it.stage === "t1" && !rec.early && age <= EARLY_MAX_AGE_MS);
  });
  const tapeable = reading
    .filter((it) => (curves[it.mint]?.progress ?? 0) >= (it.stage === "t5" ? tapeFloor(s.desk).t5 : tapeFloor(s.desk).t1))
    // minute-5 calls first (they go to the desk), then the fullest curves
    .sort((a, b) => (a.stage === b.stage ? 0 : a.stage === "t5" ? -1 : 1) || (curves[b.mint]?.progress ?? 0) - (curves[a.mint]?.progress ?? 0))
    .slice(0, MAX_TAPES_PER_RUN);
  const [metaMap, st] = await Promise.all([
    readMeta(reading.map((it) => ({ mint: it.mint, name: recs[it.mint].name, symbol: recs[it.mint].symbol }))).catch(() => ({} as Record<string, Meta>)),
    r.hmget<Record<string, number>>(K.stat, "tape_n", "tape_b"),
  ]);
  const base = tapeBase(st);
  const rg = await regimeAt(now).catch(() => null);
  const extras: Record<string, Extra> = {};
  for (const it of reading) extras[it.m] = { tape: null, g: null, meta: metaMap[it.mint] || null, px: curves[it.mint]?.priceSol || 0, rg };
  await pmap(tapeable, 4, async (it) => {
    const rec = recs[it.mint];
    const tape = await readTape(rec.mint, rec.creator, rec.createdAt);
    const g = await readGraph(rec.creator, tape?.early || [], base).catch(() => null);
    extras[it.m] = { ...extras[it.m], tape, g };
  });

  const work = await assignWork(items.length, s);
  const c = newCtx(model);
  const p = c.p;
  const last: Record<string, unknown> = {};
  const touched = new Set<string>();
  const hotAdds: { score: number; member: string }[] = [];
  const radarAdds: { score: number; member: string }[] = [];

  const order: Record<Stage, number> = { t1: -1, t5: 0, h1: 1, d1: 2 };
  items.sort((a, b) => order[a.stage] - order[b.stage]);
  p.zrem(K.due, ...members);

  // one call per coin, whatever runs at the same time (v0.1.38). The King called $FLY twice within 4 seconds on
  // 7 Oct: two passes read the launch before either had saved its call. Each call now claims the coin first in Redis
  // (SET NX), and a pass that loses the claim skips it.
  const wantsCall = items.filter((it) => it.stage === "t5" && recs[it.mint] && !recs[it.mint].call && !recs[it.mint].outcome && c.now - recs[it.mint].createdAt <= CALL_MAX_AGE_MS);
  const claimed = new Set<string>();
  await Promise.all(
    wantsCall.map(async (it) => {
      const ok = await r.set(`rn:callclaim:${it.mint}`, c.now, { nx: true, ex: 6 * 3600 }).catch(() => "OK");
      if (ok) claimed.add(it.mint);
    }),
  );

  items.forEach((it, i) => {
    const rec = recs[it.mint];
    const rat = work.names[i];
    if (!rec || rec.outcome) return;
    const cv = curves[it.mint];
    const prog = cv?.progress ?? rec.pNow ?? rec.p0;
    const cp: Cp = { p: prog, mcap: cv?.mcapSol ?? 0, at: c.now };
    rec.cp[it.stage] = cp;
    rec.pNow = prog;
    rec.peak = Math.max(rec.peak ?? 0, peakOf[it.mint] || 0, prog);
    if (cv) rec.mcapNow = cv.mcapSol;
    touched.add(it.mint);
    last[rat] = { mint: rec.mint, symbol: rec.symbol, at: c.now, kind: it.stage };

    if (cv?.supply) rec.supply = cv.supply;
    if (cv?.complete || rec.completeAt) {
      completed(c, rec);
      touched.delete(it.mint);
      return;
    }

    const age = c.now - rec.createdAt;
    if (it.stage === "t1") {
      // a late minute-1 read would be scored on data from much later: skip it rather than teach the model wrong
      if (!rec.early && !rec.call && age <= EARLY_MAX_AGE_MS) makeEarly(c, rec, cp.p, extras[it.m] || { tape: null, g: null, meta: null, px: cv?.priceSol || 0 });
      else if (!rec.early) inc(c, "early_missed");
    } else if (it.stage === "t5" && !rec.call && age > CALL_MAX_AGE_MS) {
      // too late to count, and its features would describe the coin long after minute 5: no call, no lesson
      inc(c, "calls_missed");
    } else if (it.stage === "t5" && !rec.call && claimed.has(it.mint)) {
      makeCall(c, rec, cp.p, extras[it.m] || { tape: null, g: null, meta: null, px: cv?.priceSol || 0 });
    } else if (it.stage === "t5" && !rec.call) {
      inc(c, "calls_dup_skipped");
    } else if (it.stage === "h1") {
      // Dead on arrival: nothing on the curve after an hour and it never got going. Resolve now so
      // the scoreboard and the learner see losers as fast as winners.
      if (prog < EARLY_DEATH.curve && (rec.peak ?? 0) < EARLY_DEATH.peak) {
        resolve(c, rec, "DIED");
        touched.delete(it.mint);
        return;
      }
      c.feed.push({ kind: "h1", rat, mint: rec.mint, symbol: rec.symbol, name: rec.name, at: c.now, text: `1h sniff · curve ${cp.p}% · peak ${rec.peak}%` });
    } else if (it.stage === "d1") {
      resolve(c, rec, cp.p < 5 ? "DIED" : "ALIVE");
      touched.delete(it.mint);
      return;
    }
    if (prog >= HOT_MIN) {
      hotAdds.push({ score: rec.createdAt, member: rec.mint });
      radarAdds.push({ score: prog, member: rec.mint });
    }
  });
  if (hotAdds.length) {
    p.zadd(K.hot, hotAdds[0], ...hotAdds.slice(1));
    p.zadd(K.radar, radarAdds[0], ...radarAdds.slice(1));
    p.zadd(K.peak, { gt: true }, radarAdds[0], ...radarAdds.slice(1));
  }

  for (const m of touched) p.set(K.launch(m), recs[m], { ex: LAUNCH_TTL });
  p.zremrangebyrank(K.calls, 0, -5001);
  await flush(c);
  await recordWork(work.counts, last, work.real);
  return { checked: items.length };
}

function tapeBase(st: Record<string, number> | null) {
  const n = Number(st?.tape_n || 0);
  const b = Number(st?.tape_b || 0);
  return n >= 200 ? Math.max(0.005, b / n) : 0.08; // bond rate of coins moving enough to be taped
}

function featIn(rec: Launch, curveNow: number, ex: Extra): FeatureInput {
  return {
    curve5: curveNow,
    curve0: rec.p0,
    devBuySol: rec.devBuySol,
    twitter: !!rec.twitter,
    telegram: !!rec.telegram,
    website: !!rec.website,
    description: rec.description,
    symbol: rec.symbol,
    name: rec.name,
    devN: rec.devN ?? 0,
    devB: rec.devB ?? 0,
    createdAt: rec.createdAt,
    tape: ex.tape,
    smartN: ex.g?.smartN,
    clRatio: ex.g?.clRatio,
    copy: ex.meta?.copy,
    dup: ex.meta?.dup,
    lift: ex.meta?.lift,
    rg: ex.rg ?? null,
    post: rec.wire ? { score: rec.wire.score, f: rec.wire.f ?? 0, link: rec.wire.how === "links the post" || rec.wire.how === "posted the CA" } : null,
    pulseX: rec.pulse?.x ?? 0,
  };
}

export function runOf(rec: Launch, bondedAt: number | null): Run {
  return {
    mint: rec.mint,
    supply: rec.supply,
    symbol: rec.symbol,
    createdAt: rec.createdAt,
    bondedAt,
    hi: -1,
    pk: 0,
    xs: {},
    s: {
      king: rec.call?.score ?? 0,
      nano: rec.call?.nano?.score ?? null,
      smartN: rec.g?.smartN ?? 0,
      clRatio: rec.g?.clRatio ?? 1,
      bundleShare: rec.tape?.bundleShare ?? 0,
      uniq: rec.tape?.uniq ?? 0,
      solPerBuy: rec.tape?.solPerBuy ?? 0,
      buyShare: rec.tape?.buyShare ?? 0,
      copy: !!rec.meta?.copy,
      lift: rec.meta?.lift ?? 1,
      funder: rec.g?.funder ?? null,
      early: rec.tape?.early ?? [],
    },
    cUsd: rec.cp.t5?.mcap && SOL_USD ? Math.round(rec.cp.t5.mcap * SOL_USD) : null,
    verdict: rec.call?.verdict ?? null,
  };
}

function tapeLine(t: Tape) {
  return `${t.n} trades, ${t.uniq} traders, ${t.solPerBuy}◎/buy, buys ${Math.round(t.buyShare * 100)}%, bundle ${Math.round(t.bundleShare * 100)}%${t.sniperN ? `, ${t.sniperN} snipers` : ""}${t.devSold > 0 ? `, dev sold ${t.devSold}◎` : ", dev holding"}`;
}
function graphLine(g: Graph, meta: Meta | null) {
  const cl = g.funder ? `dev funded by ${g.funder.slice(0, 4)}…: ${g.clN} launches, ${g.clB} bonded (${g.clRatio}x)` : "fresh dev, no funder history";
  return `${cl}${g.smartN ? ` · ${g.smartN} smart wallet${g.smartN > 1 ? "s" : ""} early` : ""}${meta?.hot ? ` · meta "${meta.hot}" ${meta.lift}x` : ""}${meta?.copy ? " · copies a recent winner" : ""}`;
}

/** Minute-1 read: its own model, its own scoreboard. The desk may act on it only after the early record earns it. */
function makeEarly(c: Ctx, rec: Launch, curveNow: number, ex: Extra) {
  const x = features(featIn(rec, curveNow, ex));
  const v0 = score({ progress: curveNow, progress0: rec.p0, twitter: !!rec.twitter, telegram: !!rec.telegram, website: !!rec.website, description: rec.description, symbol: rec.symbol, name: rec.name, devBuySol: rec.devBuySol, farm: !!ex.tape?.farm?.farm, wire: !!rec.wire, pulse: !rec.wire && !!rec.pulse });
  const sc = nanoReady(c.model1) ? nanoScore(c.model1, x) : v0.score;
  const verdict = verdictOf(sc);
  rec.early = { at: c.now, score: sc, verdict, curve: curveNow, x };
  c.p.lpush(LAT("early"), Math.round((c.now - rec.createdAt) / 1000));
  c.p.ltrim(LAT("early"), 0, 199);
  c.p.zadd(K.lessons, { score: rec.createdAt + LABEL_MS, member: rec.mint });
  if (ex.tape) {
    rec.tape = ex.tape;
    rec.g = ex.g;
  }
  rec.meta = ex.meta;
  inc(c, `e${verdict.toLowerCase()}_n`);
  if (verdict === "BOND" && ex.tape && !ex.tape.farm?.farm) {
    c.p.zadd(K.deskQ, { score: c.now, member: rec.mint });
    const ev = { agent: "SCOUT", at: c.now, mint: rec.mint, symbol: rec.symbol, text: `$${rec.symbol} early read BOND ${sc} at minute 1, curve ${curveNow}%`, tone: "ok" };
    c.p.lpush(K.deskEv, ev);
    agentLog(c.p, [ev]);
  }
  c.feed.push({ kind: "t1", rat: "RAT KING", mint: rec.mint, symbol: rec.symbol, name: rec.name, at: c.now, text: `early read ${verdict} ${sc} · curve ${curveNow}%${ex.tape ? ` · ${ex.tape.n} trades` : ""}` });
}

function makeCall(c: Ctx, rec: Launch, curveNow: number, ex: Extra) {
  c.p.lpush(LAT("call"), Math.round((c.now - rec.createdAt) / 1000));
  c.p.ltrim(LAT("call"), 0, 199);
  if (ex.tape) {
    rec.tape = ex.tape;
    rec.g = ex.g;
  }
  if (ex.meta) rec.meta = ex.meta;
  const farm = rec.tape?.farm?.farm ? rec.tape.farm : null;
  const sc = score({
    progress: curveNow,
    progress0: rec.p0,
    twitter: !!rec.twitter,
    telegram: !!rec.telegram,
    website: !!rec.website,
    description: rec.description,
    symbol: rec.symbol,
    name: rec.name,
    devBuySol: rec.devBuySol,
    farm: !!farm,
    wire: !!rec.wire,
    pulse: !rec.wire && !!rec.pulse,
  });
  // the model sees only a tape read for this call: when the minute-5 read failed it gets "no tape", the same as the
  // historian does. Before v0.1.28 the minute-1 tape stood in for minute 5, a picture the model never trained on
  const x = features(featIn(rec, curveNow, { ...ex, tape: ex.tape ?? null, g: ex.g ?? rec.g ?? null, meta: rec.meta ?? null }));
  const nano =
    nanoReady(c.model)
      ? (() => {
          const ns = nanoScore(c.model, x);
          return { score: ns, verdict: verdictOf(ns) };
        })()
      : null;
  // Rat King v1: once nano is trained and its lines are calibrated on the last 7 days (lib/kingcal.ts), nano leads.
  // v0's rules stay on the card. A coin born from a big post keeps a v0 BOND: nano is only starting to see posts.
  const v1 = nano && CAL?.ready ? v1Verdict(nano.score, CAL) : null;
  if (nano && v1) nano.verdict = v1;
  const bigPost = !!rec.wire && ((rec.wire.f ?? 0) >= 100_000 || rec.wire.how === "posted the CA");
  const kv = v1
    ? farm || !(bigPost && sc.verdict === "BOND" && v1 !== "BOND")
      ? { score: nano!.score, verdict: (farm ? "DUST" : v1) as Verdict, version: KING_V1 }
      : { score: sc.score, verdict: "BOND" as Verdict, version: KING_V1 }
    : { score: sc.score, verdict: sc.verdict, version: KING_VERSION };
  const counted = c.now - rec.createdAt <= CALL_ON_TIME_MS;
  rec.call = {
    mint: rec.mint,
    symbol: rec.symbol,
    name: rec.name,
    image: rec.image,
    createdAt: rec.createdAt,
    at: c.now,
    score: kv.score,
    verdict: kv.verdict,
    v0: { score: sc.score, verdict: sc.verdict },
    counted,
    progress: curveNow,
    version: kv.version,
    nano,
    x,
    parts: sc.parts,
    nc: c.model.n >= 50 ? contributions(c.model, x) : undefined,
    outcome: null,
    devN: rec.devN ?? 0,
    devB: rec.devB ?? 0,
    soc: [rec.twitter, rec.telegram, rec.website].filter(Boolean).length,
    px: ex.px || undefined,
    farm: farm?.why || undefined,
    why: whyOf({ ...rec, progress: curveNow, progress0: rec.p0, twitter: !!rec.twitter, telegram: !!rec.telegram, website: !!rec.website, tape: rec.tape ?? null, g: rec.g ?? null, meta: rec.meta ?? null }),
    tp: rec.tape
      ? { n: rec.tape.n, uniq: rec.tape.uniq, spb: rec.tape.solPerBuy, bs: rec.tape.bundleShare, sn: rec.tape.sniperN, sm: rec.g?.smartN ?? 0, cl: rec.g?.clRatio ?? 1, ds: rec.tape.devSold }
      : null,
  };
  c.p.set(K.call(rec.mint), rec.call, { ex: CALL_TTL });
  c.p.zadd(K.lessons, { score: rec.createdAt + LABEL_MS, member: rec.mint });
  if (rec.tape) enroll(c.p, runOf(rec, null));
  indexCall(c, rec.call);
  c.p.zadd(K.calls, { score: rec.createdAt, member: rec.mint });
  inc(c, "calls");
  // LENS takes a hands-on look at BOND calls and at launches named after a rising narrative
  if (counted && !farm && (kv.verdict === "BOND" || nano?.verdict === "BOND")) {
    enqueueLens(c.p, rec.mint, "bond");
    enqueueMind(c.p, rec.mint, "bond");
  } else if (counted && !farm && rec.pulse && curveNow >= 10) {
    enqueueLens(c.p, rec.mint, "pulse");
    enqueueMind(c.p, rec.mint, "pulse");
  }
  if (counted && kv.verdict === "BOND" && !farm) queueCall(c.p, { mint: rec.mint, symbol: rec.symbol, name: rec.name, score: kv.score, nano, progress: curveNow, mc: CURVE_USD[rec.mint] ? Math.round(CURVE_USD[rec.mint]) : null, plus: rec.call.why?.plus || [], minus: rec.call.why?.minus || [] });
  if (counted && (kv.verdict === "BOND" || nano?.verdict === "BOND")) {
    // every counted BOND call (King or nano) is listed on the homepage, farms included so nothing is hidden
    c.p.lpush(BOND_CALLS, rec.mint);
    c.p.ltrim(BOND_CALLS, 0, 99);
  }
  if (counted && !farm && !rec.tape && (kv.verdict === "BOND" || nano?.verdict === "BOND")) {
    // the rats had no time to read its trades: the desk reads them itself (on its own fast lane) before VET
    c.p.zadd(K.deskQ, { score: c.now, member: rec.mint });
    const ev = { agent: "KING", at: c.now, mint: rec.mint, symbol: rec.symbol, text: `$${rec.symbol} ${kv.verdict} ${kv.score}, sent to the desk (TAPE reads it there)`, tone: "ok", stance: kv.verdict === "BOND" ? 0.8 : 0.5 };
    c.p.lpush(K.deskEv, ev);
    agentLog(c.p, [ev]);
  }
  if (counted && !farm && rec.tape && (kv.verdict === "BOND" || nano?.verdict === "BOND")) {
    // hand the coin to the desk; the desk loop picks it up within 2 seconds
    c.p.zadd(K.deskQ, { score: c.now, member: rec.mint });
    const ev = { agent: "KING", at: c.now, mint: rec.mint, symbol: rec.symbol, text: `$${rec.symbol} ${kv.verdict} ${kv.score}${nano ? ` · nano ${nano.verdict} ${nano.score}` : ""}, sent to the desk`, tone: "ok", stance: kv.verdict === "BOND" ? 0.8 : 0.5 };
    const evs: any[] = [ev];
    if (rec.tape) evs.push({ agent: "TAPE", at: c.now, mint: rec.mint, symbol: rec.symbol, text: `$${rec.symbol}: ${tapeLine(rec.tape)}`, tone: rec.tape.devSold > 0 || rec.tape.bundleShare > 0.5 ? "bad" : "info" });
    if (rec.g) evs.push({ agent: "GRAPH", at: c.now, mint: rec.mint, symbol: rec.symbol, text: `$${rec.symbol}: ${graphLine(rec.g, rec.meta ?? null)}`, tone: rec.g.clRatio < 0.5 ? "bad" : rec.g.smartN || rec.g.clRatio > 2 ? "ok" : "info" });
    c.p.lpush(K.deskEv, ...evs);
    agentLog(c.p, evs);
  }
  if (counted) {
    noteCall(c.p, rec.call); // hashed into the hourly on-chain receipt (see lib/receipts.ts)
    c.p.hincrby(K.calib, `v${bucket(sc.score)}n`, 1);
    if (nano) c.p.hincrby(K.calib, `n${bucket(nano.score)}n`, 1);
    if (kv.verdict === "BOND") hrInc(c, rec.createdAt, "bn");
    if (nano?.verdict === "BOND") hrInc(c, rec.createdAt, "nbn");
    inc(c, `${kv.verdict.toLowerCase()}_n`);
    if (nano) inc(c, `n${nano.verdict.toLowerCase()}_n`);
    c.p.hincrby(K.day(dayKey()), "calls", 1);
    c.p.expire(K.day(dayKey()), 120 * 86400);
  } else inc(c, "calls_late");
  c.feed.push({
    kind: "call",
    rat: "RAT KING",
    mint: rec.mint,
    symbol: rec.symbol,
    name: rec.name,
    at: c.now,
    text: `${kv.verdict} ${kv.score}/100${nano ? ` · nano ${nano.verdict} ${nano.score}` : ""} · curve ${curveNow}%${farm ? ` · FARM (${farm.why})` : ""}${counted ? "" : " · late, not counted"}`,
  });
}

// ---------------------------------------------------------------- WIRE picks

const WIRE_MIN_CURVE = 2; // % before a tweet coin counts as a real candidate
const WIRE_WAIT_MS = 10 * 60_000; // give up on a post after this long without a real candidate

/** 30s after the first launch on a post: score every copy with the learned picker (volume, holders, who was first),
 *  read the tapes of the strongest, hand the leader to the desk. Then watch the post 30 minutes for a vamp. */
async function wirePicks() {
  const r = redis();
  const due = await dueTweets();
  let picked = 0;
  const s = await getSettings();
  const W = await loadW();
  for (const d of due) {
    const mints = d.mints.map((x) => x.mint);
    // v0.1.40: copies are re-read every second for up to 10 minutes per post; 10s old is fresh enough to rank them
    const recs = mints.length ? await launchesCached(mints, 10_000) : [];
    const curves = mints.length ? await getCurves(mints) : {};
    const all = d.mints.map((x, i) => ({ ...x, rec: recs[i], cv: curves[x.mint] })).filter((x) => x.rec);
    const live = all.filter((x) => !x.rec!.outcome && x.cv && !x.cv.complete && x.cv.progress >= WIRE_MIN_CURVE);
    const wm = recs.find((x) => x?.wire)?.wire;
    if (!live.length) {
      if (d.age > WIRE_WAIT_MS) await closeTweet(d.tid, null, wm?.h || "?");
      continue;
    }
    const firstAt = Math.min(...all.map((x) => x.rec!.createdAt));
    // traction: how many coins the post spawned and how much SOL went into all of them together
    const trac = { copies: all.length, sol: Math.round(all.reduce((a, x) => a + (x.cv?.realSol ?? 0), 0) * 10) / 10 };
    // tapes for the 3 copies with the most SOL in: holders, bundles, farms
    const bySol = [...live].sort((a, b) => (b.cv!.realSol ?? 0) - (a.cv!.realSol ?? 0)).slice(0, 3);
    const tapes: Record<string, Tape | null> = {};
    for (const x of bySol) tapes[x.mint] = await readTape(x.mint, x.rec!.creator, x.rec!.createdAt).catch(() => null);
    const now = Date.now();
    const cands = live.map((x) => {
      const t = tapes[x.mint];
      const c: Cand = { mint: x.mint, symbol: x.rec!.symbol, createdAt: x.rec!.createdAt, score: x.score, how: x.rec!.wire?.how || "", progress: x.cv!.progress, realSol: x.cv!.realSol, uniq: t ? t.organic ?? t.uniq : null, top5: t ? t.top5 : null, bundle: t ? t.bundleShare : null };
      const f = featOf(c, firstAt, now);
      return { ...x, c, f, s: scoreOf(W.w, f), tape: t };
    });
    // the leader: best learned score among the copies whose trades were read and that are not farms
    const eligible = cands.filter((x) => x.tape && !x.tape.farm?.farm).sort((a, b) => b.s - a.s);
    const lead = eligible[0];
    const rec = lead?.rec;
    if (!rec || !rec.wire) {
      if (d.age > WIRE_WAIT_MS) await closeTweet(d.tid, null, wm?.h || "?");
      continue;
    }
    rec.tape = lead.tape!;
    rec.wire = { ...rec.wire, pick: true, trac };
    await r.set(K.launch(rec.mint), rec, { keepTtl: true });
    await closeTweet(d.tid, rec.mint, rec.wire.h);
    await notePickSet(d.tid, rec.wire.h, rec.mint, cands.map((x) => ({ mint: x.mint, symbol: x.c.symbol, x: x.f })));
    picked++;
    const { w } = await accountOf(rec.wire.h);
    const p = r.pipeline();
    const send = w >= (s.desk.wireMinW ?? 0.2);
    if (send) p.zadd(K.deskQ, { score: Date.now(), member: `w:${rec.mint}` });
    enqueueLens(p, rec.mint, "wire");
    enqueueMind(p, rec.mint, "wire");
    const why = [lead.f[0] ? "first out" : null, `${lead.c.realSol.toFixed(1)} SOL in`, lead.c.uniq != null ? `${lead.c.uniq} traders` : null, lead.c.top5 != null ? `top 5 hold ${Math.round(lead.c.top5 * 100)}%` : null].filter(Boolean).join(", ");
    agentLog(p, [{ agent: "WIRE", at: Date.now(), mint: rec.mint, symbol: rec.symbol, text: `picked $${rec.symbol} of ${trac.copies} coin${trac.copies > 1 ? "s" : ""} on @${rec.wire.h}'s post (${why}; all copies ${trac.sol} SOL). trust in @${rec.wire.h} ${w}${send ? ", sent to the desk" : ", below the trust line: learning only"}. watching 30 minutes for a vamp`, tone: send ? "ok" : "info" }]);
    if (send) p.lpush(K.deskEv, { agent: "WIRE", at: Date.now(), mint: rec.mint, symbol: rec.symbol, text: `$${rec.symbol} from @${rec.wire.h}'s post, sent to the desk`, tone: "ok" });
    await p.exec();
  }
  const vamps = await vampPicks(s).catch(() => 0);
  return { wirePicked: picked, vamps, ...(await pickLessons().catch(() => ({}))) };
}

/** A copy that clearly out-pulls the pick (more SOL in, faster) on a post with proven traction: pick it too. */
async function vampPicks(s: Awaited<ReturnType<typeof getSettings>>) {
  const r = redis();
  let n = 0;
  for (const tid of await vampWatch()) {
    const already = await pickedOn(tid);
    if (already.length >= 1 + VAMP_MAX) continue;
    const cs = await candidatesOf(tid);
    if (cs.length < 2) continue;
    const recs = await launchesCached(cs.map((x) => x.mint), 10_000);
    const curves = await getCurves(cs.map((x) => x.mint));
    const rows = cs.map((x, i) => ({ ...x, rec: recs[i], cv: curves[x.mint] })).filter((x) => x.rec && x.cv);
    const trac = { copies: rows.length, sol: Math.round(rows.reduce((a, x) => a + (x.cv?.realSol ?? 0), 0) * 10) / 10 };
    // proven hype: many copies and real money across them (a hint COACH can overrule through the traction prior)
    if (trac.copies < 4 || trac.sol < 40) continue;
    const pace = (x: (typeof rows)[number]) => (x.cv!.realSol ?? 0) / Math.max(0.5, (Date.now() - x.rec!.createdAt) / 60_000);
    const mine = rows.filter((x) => already.includes(x.mint));
    const base = Math.max(0, ...mine.map((x) => x.cv!.realSol ?? 0));
    const basePace = Math.max(0, ...mine.map(pace));
    const v = rows
      .filter((x) => !already.includes(x.mint) && !x.rec!.outcome && !x.cv!.complete && x.cv!.progress <= 85 && (x.cv!.realSol ?? 0) >= Math.max(base * 1.25, 15) && pace(x) > basePace)
      .sort((a, b) => pace(b) - pace(a))[0];
    if (!v) continue;
    const tape = await readTape(v.mint, v.rec!.creator, v.rec!.createdAt).catch(() => null);
    if (!tape || tape.farm?.farm) continue;
    const rec = v.rec!;
    rec.tape = tape;
    rec.wire = { ...(rec.wire || { tid, h: "?", score: v.score, how: "named after the post", lagSec: 0, text: "" }), pick: true, vamp: true, trac };
    await r.set(K.launch(rec.mint), rec, { keepTtl: true });
    await addVamp(tid, rec.mint);
    n++;
    const { w } = await accountOf(rec.wire.h);
    const send = w >= (s.desk.wireMinW ?? 0.2);
    const p = r.pipeline();
    if (send) p.zadd(K.deskQ, { score: Date.now(), member: `w:${rec.mint}` });
    enqueueMind(p, rec.mint, "wire");
    agentLog(p, [{ agent: "WIRE", at: Date.now(), mint: rec.mint, symbol: rec.symbol, text: `vamp on @${rec.wire.h}'s post: $${rec.symbol} pulls ${(v.cv!.realSol ?? 0).toFixed(1)} SOL vs ${base.toFixed(1)} on our pick, faster (${trac.copies} copies, ${trac.sol} SOL across them)${send ? ", sent to the desk as a vamp" : ": learning only"}`, tone: send ? "ok" : "info" }]);
    await p.exec();
  }
  return n;
}

// ---------------------------------------------------------------- graduation proof

// A complete curve is not a graduation until the coin sits in its canonical PumpSwap pool (see lib/pool.ts).
// pump.fun migrates within seconds; after MIGRATE_GRACE with no pool the coin is resolved as not bonded.
export const MIGRATE_GRACE = 30 * 60_000;

/**
 * The stream saw the coin migrate. Marks the curve complete right away (the migration check then proves the pool), so
 * a coin that bonded in minutes is labelled as bonded even when no rat re-read its curve in between. Before v0.1.24
 * only a curve re-read set it, and fast bonders the rats never re-read were learned as misses (FLASH, King lessons).
 */
export async function streamComplete(mint: string, at = Date.now()) {
  const r = redis();
  const rec = await r.get<Launch>(K.launch(mint));
  if (!rec || rec.completeAt || rec.outcome) return false;
  rec.completeAt = at;
  rec.pNow = 100;
  rec.peak = Math.max(rec.peak ?? 0, 100);
  const p = r.pipeline();
  p.set(K.launch(mint), rec, { keepTtl: true });
  p.zadd(K.migr, { score: at, member: mint });
  await p.exec();
  return true;
}

function completed(c: Ctx, rec: Launch, ttl?: number) {
  if (!rec.completeAt) {
    rec.completeAt = c.now;
    rec.pNow = 100;
    rec.peak = 100;
    c.p.zadd(K.migr, { score: c.now, member: rec.mint });
    c.feed.push({ kind: "resolve", rat: "LEDGER", mint: rec.mint, symbol: rec.symbol, name: rec.name, at: c.now, text: "curve full · checking the migration pool" });
  }
  c.p.set(K.launch(rec.mint), rec, ttl ? { ex: ttl } : { keepTtl: true });
}

async function migrations(model: NanoModel) {
  const r = redis();
  const mints = ((await r.zrange<string[]>(K.migr, 0, 199)) || []) as string[];
  if (!mints.length) return { migrating: 0 };
  const [recs, pools] = await Promise.all([r.mget<(Launch | null)[]>(...mints.map((m) => K.launch(m))), readPools(mints)]);
  const c = newCtx(model);
  let ok = 0;
  let stuck = 0;
  mints.forEach((m, i) => {
    const rec = recs[i];
    if (!rec || rec.outcome) {
      c.p.zrem(K.migr, m);
      return;
    }
    const at = rec.completeAt || c.now;
    if (migrated(pools[m])) {
      resolve(c, rec, "BONDED", at);
      c.p.zadd("rn:ct:mig", { score: c.now, member: m }); // CATCH looks at fresh migrations right away
      if (SOL_USD) CURVE_USD[m] = poolUsd(pools[m], SOL_USD, rec.supply);
      c.p.zrem(K.migr, m);
      ok++;
    } else if (c.now - at > MIGRATE_GRACE) {
      rec.stuck = true;
      RUN_EV.stuck.push(m);
      inc(c, "stuck");
      c.feed.push({ kind: "resolve", rat: "LEDGER", mint: rec.mint, symbol: rec.symbol, name: rec.name, at: c.now, text: "curve full but never migrated · not counted as a graduation" });
      resolve(c, rec, "DIED");
      c.p.zrem(K.migr, m);
      stuck++;
    }
  });
  await flush(c);
  return { migrating: mints.length - ok - stuck, migrated: ok, stuck };
}

// ---------------------------------------------------------------- lessons (label window reached)

async function lessons(model: NanoModel) {
  const r = redis();
  const now = Date.now();
  const due = (await r.zrange<string[]>(K.lessons, 0, now, { byScore: true, offset: 0, count: 300 })) || [];
  if (!due.length) return { lessons: 0 };
  const recs = await r.mget<(Launch | null)[]>(...due.map((m) => K.launch(m)));
  const c = newCtx(model);
  let n = 0;
  const fresh: Lesson[] = [];
  const wait: string[] = [];
  due.forEach((m, i) => {
    const rec = recs[i];
    if (!rec || rec.learned) return;
    if (rec.completeAt && !rec.outcome) {
      // curve full, migration not proven yet: learn it once we know
      wait.push(m);
      return;
    }
    // label: bonded within the window (a bond after 2h is rare; it still counts on the scoreboard, not in training)
    const bonded = rec.outcome === "BONDED" && (rec.bondSecs ?? Infinity) * 1000 <= LABEL_MS;
    // a late call (made after minute 7) saw a later coin than the model is asked about: no lesson from it
    const x = rec.call?.x?.length && rec.call.counted ? rec.call.x : null;
    if (x?.length) {
      // King v1 calibration: nano's score on this lesson BEFORE it learns from it
      noteCal(c.p, nanoScore(c.model, x), bonded);
      c.ops.push({ k: 0, x, y: bonded, pw: posWeight(c.model.n, c.model.pos) });
      n++;
    }
    const x1 = rec.early?.x?.length ? rec.early.x : null;
    if (x1?.length) c.ops.push({ k: 1, x: x1, y: bonded, pw: posWeight(c.model1.n, c.model1.pos) });
    // same moment for winners and losers: wallet and cluster records, and the early-vs-King record that gates early entries
    if (rec.tape) {
      inc(c, "tape_n");
      if (bonded) inc(c, "tape_b");
      creditResolve(c.p, rec.g?.funder, rec.tape.early, bonded);
    }
    if (rec.early?.verdict === "BOND") {
      inc(c, "lebond_n");
      if (bonded) inc(c, "lebond_hit");
    }
    if (rec.call?.counted && rec.call.verdict === "BOND") {
      inc(c, "lbond_n");
      if (bonded) inc(c, "lbond_hit");
      // honest scoreboard per King version, resolved at the 2-hour label only
      inc(c, `lb:${rec.call.version}:n`);
      if (bonded) inc(c, `lb:${rec.call.version}:hit`);
    }
    // recall: every bond in the window, called or not
    if (bonded) inc(c, "lbonded");
    rec.learned = true;
    c.p.set(K.launch(m), rec, { keepTtl: true });
    if (x?.length || x1?.length) fresh.push({ x: x?.length ? x : null, x1: x1?.length ? x1 : null, y: bonded ? 1 : 0 });
  });
  c.p.zrem(K.lessons, ...due);
  for (const m of wait) c.p.zadd(K.lessons, { score: now + 60_000, member: m });
  if (fresh.length) {
    c.p.lpush(REPLAY_KEY, ...fresh);
    c.p.ltrim(REPLAY_KEY, 0, REPLAY_MAX - 1);
  }
  const shifted = c.model.shiftAt && c.model.shiftAt >= c.now - 15_000;
  if (shifted) {
    const ev = { agent: "COACH", at: c.now, text: `market shift: nano's recent loss ${(c.model.lossFast ?? 0).toFixed(3)} vs ${(c.model.lossW ?? c.model.loss).toFixed(3)} long-run. learning 2x faster for the next 200 lessons`, tone: "info" };
    c.p.lpush(K.deskEv, ev);
    c.feed.push({ kind: "resolve", rat: "COACH", mint: "", symbol: "", name: "", at: c.now, text: ev.text });
  }
  await flush(c);
  return { lessons: n, ...(await replay(model).catch(() => ({}))) };
}

type Lesson = { x: number[] | null; x1: number[] | null; y: number };

/** Experience replay: a random slice of recent lessons, learned again at half weight. Sharpens the weights without counting as new lessons. */
let replayAt = 0;
async function replay(model: NanoModel) {
  // v0.1.40: once a minute (was every slow pass, ~4s): each replay read 64 stored lessons
  if (Date.now() - replayAt < 60_000 * bwMul()) return { replayed: 0 };
  replayAt = Date.now();
  const r = redis();
  const len = (await r.llen(REPLAY_KEY)) || 0;
  if (len < 200) return { replayed: 0 };
  const off = Math.floor(Math.random() * Math.max(1, len - REPLAY_PER_RUN));
  const batch = ((await r.lrange<Lesson>(REPLAY_KEY, off, off + REPLAY_PER_RUN - 1)) || []) as Lesson[];
  void model;
  const ops: NanoOp[] = [];
  for (const l of batch) {
    if (l.x) ops.push({ k: 0, x: l.x, y: l.y === 1, sw: 0.5, rp: true });
    if (l.x1) ops.push({ k: 1, x: l.x1, y: l.y === 1, sw: 0.5, rp: true });
  }
  await applyNano(ops);
  await r.hincrby(K.stat, "replayed", batch.length);
  return { replayed: batch.length };
}

// ---------------------------------------------------------------- hot watch (bonds in near real time)
// Reads only curve accounts plus two sorted sets, so it stays cheap even with thousands of live coins.

const HOTW = new Map<string, number>();
const PEAKW = new Map<string, number>();
let HOTW_AT = 0;
export async function hotWatch(model: NanoModel) {
  const r = redis();
  const total = await r.zcard(K.hot);
  if (!total) return { hot: 0 };
  const off = (await r.incrby(K.hotCur, HOT_ROT)) % total;
  const [top, rot] = await Promise.all([
    r.zrange<string[]>(K.radar, 0, HOT_TOP - 1, { rev: true }),
    r.zrange<(string | number)[]>(K.hot, off, off + HOT_ROT - 1, { withScores: true }),
  ]);
  const born: Record<string, number> = {};
  for (let i = 0; i < (rot || []).length; i += 2) born[String(rot[i])] = Number(rot[i + 1]);
  const mints = Array.from(new Set([...(top || []), ...Object.keys(born)]));
  const curves = await getCurves(mints);
  const now = Date.now();
  if (SOL_USD) for (const m of mints) if (curves[m] && !curves[m]!.complete) CURVE_USD[m] = curves[m]!.mcapSol * SOL_USD;

  const radarAdds: { score: number; member: string }[] = [];
  const gone: string[] = [];
  const bondedMints: string[] = [];
  const nearMints: string[] = [];
  for (const m of mints) {
    const cv = curves[m];
    if (!cv) continue;
    if (cv.complete) {
      bondedMints.push(m);
      continue;
    }
    const age = born[m] ? now - born[m] : null;
    if (age != null && (age > 24 * 3600_000 || (age > 30 * 60_000 && cv.progress < HOT_MIN))) {
      gone.push(m);
      continue;
    }
    radarAdds.push({ score: cv.progress, member: m });
    if (cv.progress >= 85) nearMints.push(m);
  }

  const c = newCtx(model);
  const p = c.p;
  // v0.1.40: only scores that moved are written (up to 200 coins were re-written every ~4s, most of them unchanged).
  // Everything is re-written once every 10 minutes in case another process changed the sets.
  if (now - HOTW_AT > 600_000) {
    HOTW.clear();
    PEAKW.clear();
    HOTW_AT = now;
  }
  const radarCh = radarAdds.filter((x) => HOTW.get(x.member) !== x.score);
  const peakCh = radarAdds.filter((x) => !(PEAKW.get(x.member)! >= x.score));
  if (radarCh.length) p.zadd(K.radar, radarCh[0], ...radarCh.slice(1));
  if (peakCh.length) p.zadd(K.peak, { gt: true }, peakCh[0], ...peakCh.slice(1));
  for (const x of radarCh) HOTW.set(x.member, x.score);
  for (const x of peakCh) PEAKW.set(x.member, x.score);
  for (const m of gone) (HOTW.delete(m), PEAKW.delete(m));
  if (HOTW.size > 5000) HOTW.clear();
  if (PEAKW.size > 5000) PEAKW.clear();
  if (gone.length) {
    p.zrem(K.hot, ...gone);
    p.zrem(K.radar, ...gone);
    p.zrem(K.peak, ...gone);
  }

  // Only coins that just bonded or are about to need their full record.
  const newNear: string[] = [];
  for (const m of nearMints) if (await r.sadd(K.near, m)) newNear.push(m);
  if (newNear.length) await r.expire(K.near, 60 * 60 * 48);
  const need = [...bondedMints, ...newNear];
  if (need.length) {
    const recs = await r.mget<(Launch | null)[]>(...need.map((m) => K.launch(m)));
    need.forEach((m, i) => {
      const rec = recs[i];
      if (!rec) {
        p.zrem(K.hot, m);
        p.zrem(K.radar, m);
        return;
      }
      if (rec.outcome) return;
      if (bondedMints.includes(m)) {
        completed(c, rec);
      } else {
        const prog = curves[m]?.progress ?? 0;
        c.feed.push({
          kind: "near",
          rat: "RAT KING",
          mint: rec.mint,
          symbol: rec.symbol,
          name: rec.name,
          at: c.now,
          text: `about to graduate · curve ${prog}%${rec.call ? ` · called ${rec.call.verdict} ${rec.call.score}` : ""}`,
        });
      }
    });
  }
  await flush(c);
  return { hot: mints.length, bondedNow: bondedMints.length };
}
