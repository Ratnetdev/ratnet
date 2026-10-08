// RUNNER: how far can this coin go? A milestone ladder learned from scratch.
// No published work predicts outlier size on pump.fun, so we use the standard approach for rare events:
// a chain of conditional steps P(next milestone | reached this one), learned online as a discrete-time hazard model.
// Every step has enough examples to learn from, whereas "will it hit $10M" alone would have almost none.
// Coins are followed for 7 days after they bond (DexScreener), so the model sees the full run, not just the curve.

import { redis } from "./redis";
import { getMarket } from "./market";
import { poolUsd, readPools } from "./pool";
import { emptyModel, learn, NanoModel, predict } from "./nano";
import { acquire, holds, release, type Lock } from "./lock";
import { creditMillion } from "./graph";
import { cachedRead, mgetCached } from "./lcache";

export const MILESTONES = [25e3, 50e3, 1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7];
export const MILLION = MILESTONES.indexOf(1e6);
export const RUNNER_MIN = 150; // samples before the model replaces the per-milestone base rates
const FOLLOW_MS = 7 * 24 * 3600_000;
// A milestone snapshot is learned once its horizon has passed: positive if the next milestone came within it, else negative.
// Winners and losers are learned at the same delay, so the ladder is not flattered by fast winners.
const HORIZON_MS = 6 * 3600_000;
const POST_PER_RUN = 30;

export const RUNNER_FEATURES = [
  "bias",
  "milestone level",
  "minutes to get here (log)",
  "bonded",
  "king score",
  "nano score",
  "smart wallets early (log)",
  "dev cluster edge (log)",
  "bundle share",
  "unique traders (log)",
  "SOL per buy",
  "buy share",
  "copy of a recent winner",
  "hot meta lift (log)",
  "dex profile or boost paid",
  "x mentions 15m (log)",
] as const;

export const RK = {
  model: "rn:runner",
  run: (m: string) => `rn:run:${m}`,
  pre: "rn:run:pre", // zset of coins on the curve we follow (score = createdAt)
  post: "rn:run:post", // zset of bonded coins we follow (score = bondedAt)
  postCur: "rn:run:postcur",
  emp: "rn:run:emp", // per milestone: u{i} reached next / n{i} resolved
  log: "rn:run:log",
  best: "rn:run:best", // zset: peak market cap / market cap at the King's call
  fin: "rn:run:fin", // hash: final record of coins we stopped following
};

/** Static facts about a coin, frozen at the call. */
export type RunStatic = {
  king: number;
  nano: number | null;
  smartN: number;
  clRatio: number;
  bundleShare: number;
  uniq: number;
  solPerBuy: number;
  buyShare: number;
  copy: boolean;
  lift: number;
  funder: string | null;
  early: string[];
};

export type Run = {
  mint: string;
  symbol: string;
  createdAt: number;
  bondedAt: number | null;
  hi: number; // highest milestone index reached, -1 = none
  pk: number; // peak USD market cap seen
  xs: Record<number, number[]>; // feature snapshot at each milestone
  xsAt?: Record<number, number>; // when each snapshot was taken
  done?: Record<number, boolean>; // snapshot already learned
  upAt?: Record<number, number>; // when each milestone was first reached
  s: RunStatic;
  paid?: boolean;
  xm?: number; // latest X mentions in 15m
  cUsd?: number | null; // market cap at the King's call (where the King would have bought)
  verdict?: string | null; // the King's call
  now?: number; // latest market cap seen
  pkAt?: number; // when the peak was seen
  supply?: number; // token supply (1B on standard pump.fun)
};

export type RunView = { mint: string; symbol: string; pk: number; pkAt?: number; now?: number; cUsd?: number | null; x: number | null; verdict?: string | null; bondedAt: number | null; createdAt: number };
export const viewOf = (r: Run): RunView => ({
  mint: r.mint,
  symbol: r.symbol,
  pk: Math.round(r.pk || 0),
  pkAt: r.pkAt,
  now: r.now != null ? Math.round(r.now) : undefined,
  cUsd: r.cUsd ? Math.round(r.cUsd) : null,
  x: r.cUsd && r.pk ? Math.round((r.pk / r.cUsd) * 10) / 10 : null,
  verdict: r.verdict ?? null,
  bondedAt: r.bondedAt,
  createdAt: r.createdAt,
});

export function features(run: Run, i: number, at: number): number[] {
  const s = run.s;
  const mins = Math.max(0, (at - run.createdAt) / 60_000);
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return [
    1,
    i / MILESTONES.length,
    Math.log10(1 + mins) / 4,
    run.bondedAt ? 1 : 0,
    s.king / 100,
    s.nano == null ? 0.5 : s.nano / 100,
    Math.log1p(s.smartN) / 2,
    Math.max(-1, Math.min(1, Math.log(Math.max(0.05, s.clRatio)) / 3)),
    Math.min(1, s.bundleShare),
    Math.log1p(s.uniq) / 5,
    Math.min(5, s.solPerBuy) / 5,
    s.buyShare,
    s.copy ? 1 : 0,
    Math.min(1, Math.log(Math.max(1, s.lift)) / 3),
    run.paid ? 1 : 0,
    Math.log1p(run.xm || 0) / 5,
  ].map(r);
}

export function levelOf(usd: number) {
  let i = -1;
  for (let k = 0; k < MILESTONES.length; k++) if (usd >= MILESTONES[k]) i = k;
  return i;
}

export type RunnerOp = { x: number[]; y: boolean; sw?: number };
const RUN_PENDING = "rn:runner:pending";
/**
 * The only way the runner model is trained (v0.1.29): under its lock, on the latest saved copy. Before, the slow lane
 * and the historian each loaded it, trained their own copy and saved it over the other's lessons.
 */
export async function applyRunnerOps(ops0: RunnerOp[]) {
  if (!ops0.length) return;
  const r = redis();
  let l: Lock | null = null;
  for (let i = 0; i < 20 && !l; i++) {
    l = await acquire("rn:lock:runner", 15_000);
    if (!l) await new Promise((res) => setTimeout(res, 100));
  }
  if (!l) {
    await r.rpush(RUN_PENDING, ...ops0).catch(() => {});
    await r.ltrim(RUN_PENDING, -5000, -1).catch(() => {});
    return;
  }
  try {
    const parked = ((await r.lpop<RunnerOp[]>(RUN_PENDING, 1000).catch(() => null)) || []) as RunnerOp[];
    const ops = [...(Array.isArray(parked) ? parked : []), ...ops0];
    const m = await loadRunner();
    for (const o of ops) learn(m, o.x, o.y, undefined, o.sw ?? 1);
    if (!(await holds(l))) {
      await r.rpush(RUN_PENDING, ...ops).catch(() => {});
      return;
    }
    await r.set(RK.model, m);
  } finally {
    await release(l);
  }
}

export async function loadRunner(): Promise<NanoModel> {
  const m = await redis().get<NanoModel>(RK.model);
  return m && Array.isArray(m.w) ? m : emptyModel();
}

/** P(reach the next milestone | at milestone i). Base rates until the model has enough lessons. */
export function pNext(model: NanoModel, emp: Record<string, number>, run: Run, i: number, at = Date.now()) {
  if (i < 0) i = 0;
  if (i >= MILESTONES.length - 1) return 0.5;
  const n = Number(emp[`n${i}`] || 0);
  const u = Number(emp[`u${i}`] || 0);
  const base = (u + 0.35 * 5) / (n + 5);
  if (model.n < RUNNER_MIN) return round3(base);
  return round3(predict(model, features(run, i, at)));
}

/** Start following a coin (called at the King's call for taped coins, and at bond for every coin). */
export async function enroll(p: { set: Function; zadd: Function }, run: Run) {
  RUNC.delete(run.mint);
  if (!run.bondedAt) PRE?.add(run.mint);
  else PRE?.delete(run.mint);
  p.set(RK.run(run.mint), run, { ex: Math.ceil((FOLLOW_MS + 2 * 86400_000) / 1000) });
  if (run.bondedAt) p.zadd(RK.post, { score: run.bondedAt, member: run.mint });
  else p.zadd(RK.pre, { score: run.createdAt, member: run.mint });
}

type Ctx = { model: NanoModel; dirty: boolean; emp: Record<string, number>; log: string[]; ops: RunnerOp[] };

function step(c: Ctx, p: any, run: Run, usd: number, at: number) {
  if (!(usd > 0)) return;
  run.now = usd;
  if (usd > (run.pk || 0)) {
    run.pk = usd;
    run.pkAt = at;
    if (run.cUsd) p.zadd(RK.best, { score: Math.round((usd / run.cUsd) * 100) / 100, member: run.mint });
  }
  const lv = levelOf(usd);
  if (lv <= run.hi) return;
  run.xsAt ||= {};
  run.done ||= {};
  for (let i = run.hi + 1; i <= lv; i++) {
    (run.upAt ||= {})[i] = at;
    // jumped past several milestones in one read: the ones in between were crossed at an unknown moment, so they get
    // no snapshot (it would be an instant "yes"). Same rule as the historian's hourly candles.
    if (i < lv) {
      run.done[i] = true;
    } else {
      run.xs[i] = features(run, i, at);
      run.xsAt[i] = at;
    }
    // HOUND digs into every coin that breaks out past $500K: who bought big before it ran?
    if (MILESTONES[i] === 5e5) p.zadd("rn:hd:bq", { score: at, member: `${run.mint}|${run.createdAt}|${run.bondedAt || 0}|${run.symbol}` });
    if (i === MILLION) {
      creditMillion(p, run.s.funder, run.s.early);
      c.log.push(`$${run.symbol} crossed $1M. its early wallets and dev cluster get credit`);
    }
  }
  run.hi = lv;
}

/** The coin stopped (died on the curve or we stopped following it): its last milestone did not reach the next one. */
function settle(c: Ctx, p: any, run: Run, i: number) {
  const t0 = run.xsAt?.[i] ?? 0;
  const t1 = run.upAt?.[i + 1];
  const up = t1 != null && t1 - t0 <= HORIZON_MS;
  (run.done ||= {})[i] = true;
  c.ops.push({ x: run.xs[i], y: up });
  c.dirty = true;
  p.hincrby(RK.emp, `n${i}`, 1);
  if (up) p.hincrby(RK.emp, `u${i}`, 1);
}

/** Learn every snapshot whose horizon has passed (or that is already settled by reaching the next milestone). */
function expire(c: Ctx, p: any, run: Run, at: number) {
  for (const k of Object.keys(run.xs)) {
    const i = Number(k);
    if (i >= MILESTONES.length - 1 || run.done?.[i]) continue;
    if (at - (run.xsAt?.[i] ?? at) >= HORIZON_MS) settle(c, p, run, i);
  }
}

function close(c: Ctx, p: any, run: Run) {
  // the coin is done (died, or followed for 7 days): settle every snapshot still open
  for (const k of Object.keys(run.xs)) {
    const i = Number(k);
    if (i < MILESTONES.length - 1 && !run.done?.[i]) settle(c, p, run, i);
  }
  p.hset(RK.fin, { [run.mint]: viewOf(run) });
  p.del(RK.run(run.mint));
  p.zrem(RK.pre, run.mint);
  PRE?.delete(run.mint);
  p.zrem(RK.post, run.mint);
}

// v0.1.40: followed runs are kept in memory by the process that follows them (the worker's slow lane) and written
// back only when something changed. Before, every slow pass (every ~4s) read and rewrote every followed run (~1.8KB
// each, often 100+ of them): several GB a day of Redis traffic for numbers that mostly stood still. A run held in
// memory is re-read from Redis every 5 minutes, so another process's write is picked up.
const RUNC = new Map<string, { at: number; json: string; run: Run; wroteAt?: number; hi?: number; b?: number | null }>();
const RUNC_MS = 5 * 60_000;
// v0.1.42: which curve coins are followed (rn:run:pre), in memory, re-read every 5 minutes. Each slow pass sent the
// whole hot list (~340 mints) to ZMSCORE just to learn this: 13MB an hour.
let PRE: Set<string> | null = null;
let PRE_AT = 0;
async function preSet() {
  if (!PRE || Date.now() - PRE_AT > 5 * 60_000) {
    PRE = new Set((((await redis().zrange<string[]>(RK.pre, 0, -1)) || []) as string[]).map(String));
    PRE_AT = Date.now();
  }
  return PRE;
}

/**
 * One runner pass, run from the dig loop.
 * `curveUsd` holds USD market caps the rats just read off the curves (free), bonds/deaths are reported by the digger.
 */
export async function runnerPass(curveUsd: Record<string, number>, events: { bonded: string[]; died: string[]; stuck?: string[] } = { bonded: [], died: [] }, solUsd = 0) {
  const r = redis();
  const now = Date.now();
  const preMints = Object.keys(curveUsd);
  const pre = preMints.length ? await preSet() : new Set<string>();
  const followPre = preMints.filter((m) => pre.has(m));

  // post-bond: rotate through followed coins, 30 per DexScreener call
  const total = await r.zcard(RK.post);
  let postMints: string[] = [];
  if (total) {
    const off = (await r.incrby(RK.postCur, POST_PER_RUN)) % total;
    postMints = ((await r.zrange<string[]>(RK.post, off, off + POST_PER_RUN - 1)) || []) as string[];
  }
  const all = Array.from(new Set([...followPre, ...postMints, ...events.bonded, ...events.died]));
  if (!all.length) return { followed: 0 };
  // post-bond market caps come straight from each coin's canonical pool: one RPC call, no API lag.
  // DexScreener is asked only for the paid boost/profile flag, and never allowed to hold the pass up.
  const postSet = Array.from(new Set([...postMints, ...events.bonded]));
  const quick = <T,>(p: Promise<T>, ms: number, d: T) => Promise.race([p.catch(() => d), new Promise<T>((res) => setTimeout(() => res(d), ms))]);
  const miss = all.filter((m) => {
    const h = RUNC.get(m);
    // a run with a peak still waiting to be written is never replaced by the older stored copy
    return !h || (now - h.at > RUNC_MS && JSON.stringify(h.run) === h.json);
  });
  const [got, model, emp, pools, mkt] = await Promise.all([
    miss.length ? r.mget<(Run | null)[]>(...miss.map(RK.run)) : Promise.resolve([] as (Run | null)[]),
    loadRunner(),
    r.hgetall<Record<string, number>>(RK.emp),
    postSet.length && solUsd ? readPools(postSet).catch(() => ({} as Record<string, any>)) : Promise.resolve({} as Record<string, any>),
    postMints.length ? quick(getMarket(postMints), 1500, {} as Record<string, any>) : Promise.resolve({} as Record<string, any>),
  ]);
  miss.forEach((m, i) => {
    const run = got[i] as Run | null;
    // v0.1.44: a copy just read from Redis counts as written (it is what Redis holds). Without wroteAt every reload, and
    // every worker restart, wrote each followed run again on its next small move, past the one-a-minute throttle
    if (run) RUNC.set(m, { at: now, json: JSON.stringify(run), run, wroteAt: now, hi: run.hi, b: run.bondedAt ?? null });
    else RUNC.delete(m);
  });
  const runs = all.map((m) => RUNC.get(m)?.run ?? null);
  const c: Ctx = { model, dirty: false, emp: emp || {}, log: [], ops: [] };
  const p = r.pipeline();
  p.zremrangebyscore(RK.pre, 0, now - 2 * 86400_000); // curve coins we never heard back from
  all.forEach((m, i) => {
    const run = runs[i];
    if (!run) {
      p.zrem(RK.pre, m);
      PRE?.delete(m);
      p.zrem(RK.post, m);
      return;
    }
    if (events.stuck?.includes(m) || events.died.includes(m)) RUNC.delete(m);
    if (events.stuck?.includes(m)) {
      // curve full but never migrated: its numbers say nothing about real runners, drop it unlearned
      p.del(RK.run(m));
      p.zrem(RK.pre, m);
      PRE?.delete(m);
      p.zrem(RK.post, m);
      p.zrem(RK.best, m);
      return;
    }
    if (events.died.includes(m)) return close(c, p, run);
    if (events.bonded.includes(m) && !run.bondedAt) {
      run.bondedAt = now;
      p.zrem(RK.pre, m);
      PRE?.delete(m);
      p.zadd(RK.post, { score: now, member: m });
    }
    const usd = curveUsd[m] ?? (pools[m] ? poolUsd(pools[m], solUsd, run.supply) : 0);
    if (mkt[m]) run.paid = !!(mkt[m].bo || mkt[m].pf);
    step(c, p, run, usd, now);
    expire(c, p, run, now);
    if (run.bondedAt && now - run.bondedAt > FOLLOW_MS) return RUNC.delete(m), close(c, p, run);
    const json = JSON.stringify(run);
    const h = RUNC.get(m);
    if (h && h.json === json) return; // nothing changed: no write
    // v0.1.42: a new milestone, a bond or a learned snapshot is written at once; a peak that only moved waits up to a
    // minute (the record was rewritten on every small move: 19MB an hour)
    const big = !h || h.hi !== run.hi || (h.b ?? null) !== (run.bondedAt ?? null) || !h.wroteAt;
    if (!big && now - (h!.wroteAt || 0) < 60_000) {
      RUNC.set(m, { ...h!, run });
      return;
    }
    p.set(RK.run(m), run, { keepTtl: true });
    RUNC.set(m, { at: h?.at ?? now, json, run, wroteAt: now, hi: run.hi, b: run.bondedAt ?? null });
  });
  for (const l of c.log) p.lpush(RK.log, { at: now, text: l });
  if (c.log.length) p.ltrim(RK.log, 0, 99);
  await p.exec();
  if (c.ops.length) await applyRunnerOps(c.ops);
  return { followed: all.length };
}

/** Peak, current and call market caps for many coins (followed now or finished). */
export async function runViews(mints: string[]): Promise<Record<string, RunView>> {
  const out: Record<string, RunView> = {};
  if (!mints.length) return out;
  const r = redis();
  // v0.1.40: pages read runs at most once a minute per server instance (the worker's own pass keeps RUNC)
  const [runs, fin] = await Promise.all([mgetCached<Run>(mints.map(RK.run), 60_000), cachedRead(`runfin:${mints.join(",").slice(0, 400)}:${mints.length}`, 60_000, () => r.hmget<Record<string, RunView>>(RK.fin, ...mints))]);
  mints.forEach((m, i) => {
    const run = runs[i];
    if (run) out[m] = viewOf(run);
    else if (fin?.[m]) out[m] = fin[m] as RunView;
  });
  return out;
}

/** Best runs since the King's call, last 7 days. */
export async function topRunners(limit = 25): Promise<RunView[]> {
  const r = redis();
  const mints = ((await r.zrange<string[]>(RK.best, 0, limit * 2, { rev: true })) || []) as string[];
  const views = await runViews(mints);
  const cutoff = Date.now() - 9 * 86400_000;
  const stale = mints.filter((m) => !views[m] || views[m].createdAt < cutoff);
  if (stale.length) await r.zrem(RK.best, ...stale);
  return mints.map((m) => views[m]).filter((v) => v && v.createdAt >= cutoff).slice(0, limit);
}

export async function getRunner() {
  const r = redis();
  const [model, emp, log, pre, post] = await Promise.all([loadRunner(), r.hgetall<Record<string, number>>(RK.emp), r.lrange(RK.log, 0, 19), r.zcard(RK.pre), r.zcard(RK.post)]);
  const ladder = MILESTONES.slice(0, -1).map((m, i) => {
    const n = Number(emp?.[`n${i}`] || 0);
    const u = Number(emp?.[`u${i}`] || 0);
    return { from: m, to: MILESTONES[i + 1], n, up: u, rate: n ? Math.round((u / n) * 1000) / 10 : null };
  });
  return {
    n: model.n,
    pos: model.pos,
    loss: model.loss,
    ready: model.n >= RUNNER_MIN,
    weights: RUNNER_FEATURES.map((f, i) => ({ f, w: Math.round((model.w[i] || 0) * 1000) / 1000 })),
    ladder,
    following: { curve: pre, bonded: post },
    log: log || [],
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
