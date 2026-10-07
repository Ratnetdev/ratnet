// EXIT LAB: the desk learns its exits from every price path it has seen, per strategy and per market-cap tier.
//
// Why: one exit profile per strategy treated a $30K curve coin and a $3M runner the same (an 8-minute time stop on a
// $3M coin that routinely swings 30% and comes back), and it could only see a coin while holding it: a short time
// stop cut trades early, so every peak it saw looked early, so the stop got shorter still.
//
// How: every closed trade (real and ghost) leaves its full path: the price from the buy to the sale, plus what the
// coin did for up to 2 hours after (COACH keeps watching). The lab replays each path under a grid of exit settings
// (stop, time stop, initials, trail scale) and keeps, per sleeve x tier, the setting with the best average result
// over the last 40 paths. Nobody picks the numbers: the paths do. It needs 12 paths in a bucket before it speaks,
// moves at most halfway toward a new optimum per update, and shows its work (admin Strategy tab).
import { redis } from "./redis";

export type Tier = "micro" | "small" | "large";
/** Market cap tiers: under $100K (curve and fresh), $100K-$1M, $1M+. */
export const tierOf = (usd: number | null | undefined): Tier => (!usd || usd < 100_000 ? "micro" : usd < 1_000_000 ? "small" : "large");

export type LabPath = { at: number; tier: Tier; sl: string; pts: [number, number][]; cost?: number }; // [minutes since entry, price / entry]; cost = round-trip cost fraction
export type ExitSet = { stop: number; time: number; initials: number; trailK: number };
export type LabBest = ExitSet & { n: number; avg: number; base: number; at: number };

const PATHS = (k: string) => `rn:lab:p:${k}`;
const BEST = "rn:lab:best";
const MIN_N = 12;
const KEEP = 40;

const STOPS = [-12, -18, -25, -35, -50];
const TIMES = [10, 20, 40, 80, 160];
const INITS = [30, 60, 100, 150];
const TRAILS = [0.6, 0.8, 1, 1.3, 1.7];
export const DEFAULT_SET: ExitSet = { stop: -35, time: 45, initials: 100, trailK: 1 };

/** Trail width at a multiple (same shape as the desk's trail ladder: wider as it runs). */
const trailAt = (m: number, k: number) => (m < 3 ? 30 : m < 10 ? 40 : m < 30 ? 45 : 50) * k;

/** Replay one path under one exit setting. Returns the log of what 1 SOL came back as, after the trade's costs. */
export function replay(pts: [number, number][], s: ExitSet, cost = 0) {
  return Math.log(Math.max(1e-6, Math.exp(replayGross(pts, s)) * (1 - Math.max(0, Math.min(0.5, cost)))));
}
function replayGross(pts: [number, number][], s: ExitSet) {
  let held = 1; // share of the bag still held
  let cash = 0;
  let tp1 = false;
  let peak = 1;
  for (const [t, r] of pts) {
    if (!tp1) {
      if (r <= 1 + s.stop / 100) return Math.log(cash + held * r);
      if (r >= 1 + s.initials / 100) {
        cash += 0.5 * r;
        held = 0.5;
        tp1 = true;
        peak = r;
        continue;
      }
      if (t >= s.time) return Math.log(cash + held * r);
    } else {
      peak = Math.max(peak, r);
      if (r <= peak * (1 - Math.min(80, trailAt(peak, s.trailK)) / 100)) return Math.log(cash + held * r);
    }
  }
  const last = pts.length ? pts[pts.length - 1][1] : 1;
  return Math.log(cash + held * last);
}

/** Keep one path (thinned to ~30s steps, max 2.5h). */
export async function notePath(p: LabPath) {
  if (p.pts.length < 4) return;
  const thin: [number, number][] = [];
  let lastT = -1;
  for (const [t, r] of p.pts) {
    if (t > 150) break;
    if (t - lastT >= 0.5 || thin.length === 0) {
      thin.push([Math.round(t * 100) / 100, Math.round(r * 10000) / 10000]);
      lastT = t;
    }
  }
  const r = redis();
  const k = `${p.sl}:${p.tier}`;
  await r.lpush(PATHS(k), { ...p, pts: thin });
  await r.ltrim(PATHS(k), 0, KEEP - 1);
}

/**
 * Re-learn one bucket: grid search over its paths, move halfway toward the winner. v0.1.31:
 *  - only when new paths arrived since the last time (re-learning the same 40 paths every 10 minutes kept nudging
 *    the setting toward one fixed sample)
 *  - the winner is picked on the older two thirds and must also beat the current setting on the newest third
 *    (held out): a setting that only fits the past does not move the desk
 *  - every replay pays the trade's real round-trip costs
 */
export async function relearn(key: string, current: ExitSet) {
  const r = redis();
  const paths = ((await r.lrange<LabPath>(PATHS(key), 0, KEEP - 1)) || []) as LabPath[];
  if (paths.length < MIN_N) return null;
  const newest = paths[0]?.at || 0;
  const prev = (await r.hget<LabBest>(BEST, key)) as (LabBest & { lastPath?: number }) | null;
  if (prev?.lastPath && prev.lastPath >= newest) return null;
  const hold = Math.max(4, Math.floor(paths.length / 3));
  const test = paths.slice(0, hold); // newest first
  const train = paths.slice(hold);
  const score = (ps: LabPath[], s: ExitSet) => ps.reduce((a, p) => a + replay(p.pts, s, p.cost ?? 0), 0) / Math.max(1, ps.length);
  let best: ExitSet = current;
  let bestV = score(train, current);
  for (const stop of STOPS) for (const time of TIMES) for (const initials of INITS) for (const trailK of TRAILS) {
    const v = score(train, { stop, time, initials, trailK });
    if (v > bestV + 1e-9) {
      bestV = v;
      best = { stop, time, initials, trailK };
    }
  }
  const base = score(paths, current);
  if (score(test, best) <= score(test, current)) {
    // the winner did not hold up on the newest paths: keep the current setting, remember these paths were seen
    await r.hset(BEST, { [key]: { ...(prev || { ...current, n: paths.length, avg: Math.round((Math.exp(base) - 1) * 1000) / 10, base: Math.round((Math.exp(base) - 1) * 1000) / 10, at: Date.now() }), lastPath: newest } });
    return null;
  }
  bestV = score(paths, best);
  // halfway, so one lucky batch can't swing the desk
  const mid = (a: number, b: number) => Math.round(((a + b) / 2) * 100) / 100;
  const next: LabBest & { lastPath: number } = { stop: mid(current.stop, best.stop), time: mid(current.time, best.time), initials: mid(current.initials, best.initials), trailK: mid(current.trailK, best.trailK), n: paths.length, avg: Math.round((Math.exp(bestV) - 1) * 1000) / 10, base: Math.round((Math.exp(base) - 1) * 1000) / 10, at: Date.now(), lastPath: newest };
  await r.hset(BEST, { [key]: next });
  return next;
}

/** Drop paths that match `bad` from every bucket (one-time data fixes). Returns how many were dropped. */
export async function dropPaths(bad: (p: LabPath) => boolean) {
  const r = redis();
  let n = 0;
  for (const sl of ["king", "early", "wire", "vamp", "momo", "mind", "catch", "flash"])
    for (const tier of ["micro", "small", "large"]) {
      const k = PATHS(`${sl}:${tier}`);
      const ps = ((await r.lrange<LabPath>(k, 0, -1)) || []) as LabPath[];
      const keep = ps.filter((p) => !bad(p));
      if (keep.length === ps.length) continue;
      n += ps.length - keep.length;
      await r.del(k);
      if (keep.length) await r.rpush(k, ...keep);
    }
  return n;
}

export async function labBest(): Promise<Record<string, LabBest>> {
  return ((await redis().hgetall<Record<string, LabBest>>(BEST)) || {}) as Record<string, LabBest>;
}

/** Every bucket with paths gets re-learned (called by COACH every ~10 minutes). */
export async function labStep(defaults: (sl: string, tier: Tier) => ExitSet) {
  const r = redis();
  const at = Number((await r.get("rn:lab:at")) || 0);
  if (Date.now() - at < 10 * 60_000) return [];
  await r.set("rn:lab:at", Date.now());
  const cur = await labBest();
  const out: { key: string; best: LabBest }[] = [];
  for (const sl of ["king", "early", "wire", "vamp", "momo", "mind", "catch", "flash"]) {
    for (const tier of ["micro", "small", "large"] as Tier[]) {
      const key = `${sl}:${tier}`;
      const c = cur[key] || defaults(sl, tier);
      const b = await relearn(key, { stop: c.stop, time: c.time, initials: c.initials, trailK: c.trailK }).catch(() => null);
      if (b) out.push({ key, best: b });
    }
  }
  return out;
}

export async function labView() {
  const best = await labBest();
  const r = redis();
  const counts: Record<string, number> = {};
  for (const sl of ["king", "early", "wire", "vamp", "momo", "mind", "catch", "flash"]) for (const t of ["micro", "small", "large"]) counts[`${sl}:${t}`] = Number(await r.llen(PATHS(`${sl}:${t}`)).catch(() => 0));
  return { best, counts, minN: MIN_N };
}
