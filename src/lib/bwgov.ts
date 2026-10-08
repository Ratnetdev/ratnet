// v0.1.40: the bandwidth governor. A safety net under the fixes: whatever a future change does, Redis traffic cannot
// run through the month's plan again.
//  - every process (the Railway worker and each Vercel function) counts its own wire bytes (lib/rediswire.ts) and adds
//    them to one shared daily counter, rn:bw:d:<date>, once a minute. INCRBY answers with the new day total, so every
//    process knows where the day stands without an extra read.
//  - the day's allowance (BW_GB_PER_DAY, default 2.8GB: 84GB a month against the plan's 100GB) is paced through the
//    day: by noon UTC the day may have used half, plus a small head start.
//  - level 1 (over pace): pages cache 3x longer, the worker slows its background work (historian, CATCH bursts, the
//    agents, the slow lane). level 2 (over the whole day's allowance, or 1.5x pace): 6x caches, background work waits.
//    The desk's own positions and exits are never slowed.
const GB = 1e9;
const ALLOW = Number(process.env.BW_GB_PER_DAY || 2.8) * GB;
const HEAD = 0.06; // head start: 6% of the day, so the morning is not throttled by a busy first hour
const FLUSH_MS = 60_000;

type S = { pending: number; flushAt: number; day: string; total: number; totalAt: number; expireDay: string; level: number; changedAt: number; busy: boolean };
const g = globalThis as any;
const S: S = (g.__rnBwGov ||= { pending: 0, flushAt: Date.now(), day: "", total: 0, totalAt: 0, expireDay: "", level: 0, changedAt: 0, busy: false });

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const bwDayKey = (ms = Date.now()) => `rn:bw:d:${dayOf(ms)}`;

/** Bytes allowed so far today at an even pace (plus the head start). */
export function paceNow(ms = Date.now()) {
  const d = new Date(ms);
  const frac = (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) / 86400;
  return ALLOW * Math.min(1, frac + HEAD);
}

function levelFor(total: number, ms = Date.now()) {
  const pace = paceNow(ms);
  if (total > ALLOW || total > pace * 1.5) return 2;
  if (total > pace) return 1;
  return 0;
}

/** Called by the wire layer for every Redis answer. Flushes the bytes once a minute. */
export function bwCount(bytes: number) {
  S.pending += bytes;
  const now = Date.now();
  if (now - S.flushAt < FLUSH_MS || S.busy) return;
  S.flushAt = now;
  void bwFlush();
}

export async function bwFlush() {
  if (S.busy || S.pending <= 0) return S.total;
  S.busy = true;
  const add = Math.round(S.pending);
  S.pending = 0;
  const now = Date.now();
  try {
    const { redis } = await import("./redis");
    const key = bwDayKey(now);
    const total = Number(await redis().incrby(key, add));
    if (S.expireDay !== key) {
      S.expireDay = key;
      await redis().expire(key, 3 * 86400).catch(() => 0);
    }
    if (dayOf(now) !== S.day) S.day = dayOf(now);
    S.total = total;
    S.totalAt = now;
    const lv = levelFor(total, now);
    if (lv !== S.level) {
      S.level = lv;
      S.changedAt = now;
    }
  } catch {
    S.pending += add; // Redis unreachable: keep the bytes for the next flush
  } finally {
    S.busy = false;
  }
  return S.total;
}

/** 0 normal, 1 over pace, 2 over the day. A stale reading (no flush for 5 minutes, or yesterday's) counts as 0. */
export function bwLevel(ms = Date.now()) {
  if (process.env.BW_GOVERNOR === "off") return 0;
  if (!S.totalAt || ms - S.totalAt > 5 * 60_000 || dayOf(S.totalAt) !== dayOf(ms)) return 0;
  return S.level;
}

/** Cache times stretch with the level: x1, x3, x6. */
export const bwMul = () => [1, 3, 6][bwLevel()] || 1;

export function bwView(ms = Date.now()) {
  return { level: bwLevel(ms), dayMB: Math.round(S.total / 1e6), paceMB: Math.round(paceNow(ms) / 1e6), allowMB: Math.round(ALLOW / 1e6), at: S.totalAt };
}

/** Test hook. */
export function _bwSet(total: number, at = Date.now()) {
  S.total = total;
  S.totalAt = at;
  S.level = levelFor(total, at);
}
