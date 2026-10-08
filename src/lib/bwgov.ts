// The bandwidth governor (v0.1.40, rebuilt in v0.1.41). A safety net under the fixes: whatever a future change does,
// Redis traffic cannot run through the month's plan again.
//  - every process (the Railway worker and each Vercel function) counts its own wire bytes (lib/rediswire.ts) and adds
//    them to shared counters: the day (rn:bw:d:<date>), the hour (rn:bw:h:<hour>) and who used it (rn:bw:src:<date>,
//    worker or site). A process flushes once a minute or as soon as 256KB are waiting.
//  - two tests, the stricter one wins:
//      the day: the allowance (BW_GB_PER_DAY, default 2.8GB: 84GB a month against the plan's 100GB) paced through the
//      UTC day, with a small head start;
//      the hour: this hour's rate against a 24th of the allowance (v0.1.41: on 8 Oct the new database ran at ~3x the
//      allowance for hours while the day test still said "fine", because the day had started at noon).
//  - level 1 (over pace or 1.2x the hourly rate): caches 3x longer, the worker slows its background work (historian,
//    CATCH bursts, the agents, the slow lane). level 2 (1.5x): 6x caches, the historian waits. level 3 (the day's
//    allowance used up, or 2.5x the hourly rate): 10x caches, the boards and explorer summaries stop, CATCH and the
//    agents wait. The desk's own positions and exits are never slowed.
import { waitUntil } from "@vercel/functions";

const GB = 1e9;
const ALLOW = Number(process.env.BW_GB_PER_DAY || 2.8) * GB;
const HOURLY = ALLOW / 24;
const HEAD = 0.06; // head start: 6% of the day, so the morning is not throttled by a busy first hour
const FLUSH_MS = 60_000;
const FLUSH_BYTES = 256_000;

type S = { pending: number; flushAt: number; total: number; hour: number; hourKey: string; totalAt: number; expired: Set<string>; level: number; busy: boolean };
const g = globalThis as any;
const S: S = (g.__rnBwGov2 ||= { pending: 0, flushAt: Date.now(), total: 0, hour: 0, hourKey: "", totalAt: 0, expired: new Set<string>(), level: 0, busy: false });

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const hourOf = (ms: number) => new Date(ms).toISOString().slice(0, 13);
export const bwDayKey = (ms = Date.now()) => `rn:bw:d:${dayOf(ms)}`;
export const bwHourKey = (ms = Date.now()) => `rn:bw:h:${hourOf(ms)}`;
export const bwSrcKey = (ms = Date.now()) => `rn:bw:src:${dayOf(ms)}`;
const SRC = () => (process.env.RATNET_WORKER === "1" ? "worker" : "site");

/** Bytes allowed so far today at an even pace (plus the head start). */
export function paceNow(ms = Date.now()) {
  const d = new Date(ms);
  const frac = (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) / 86400;
  return ALLOW * Math.min(1, frac + HEAD);
}

/** This hour's bytes as a multiple of the hourly allowance, projected over the hour (at least 10 minutes in). */
export function hourRate(hourBytes: number, ms = Date.now()) {
  const d = new Date(ms);
  const mins = Math.max(10, d.getUTCMinutes() + d.getUTCSeconds() / 60);
  return (hourBytes * (60 / mins)) / HOURLY;
}

export function levelFor(total: number, hourBytes: number, ms = Date.now()) {
  const pace = paceNow(ms);
  const rate = hourRate(hourBytes, ms);
  let day = 0;
  if (total > ALLOW) day = 3;
  else if (total > pace * 1.5) day = 2;
  else if (total > pace) day = 1;
  const hour = rate > 2.5 ? 3 : rate > 1.5 ? 2 : rate > 1.2 ? 1 : 0;
  return Math.max(day, hour);
}

/** Called by the wire layer for every Redis answer. */
export function bwCount(bytes: number) {
  S.pending += bytes;
  const now = Date.now();
  if (S.busy || (now - S.flushAt < FLUSH_MS && S.pending < FLUSH_BYTES)) return;
  S.flushAt = now;
  const p = bwFlush();
  try {
    waitUntil(p); // on Vercel: finish the flush even after the answer went out
  } catch {}
}

export async function bwFlush() {
  if (S.busy || S.pending <= 0) return S.total;
  S.busy = true;
  const add = Math.round(S.pending);
  S.pending = 0;
  const now = Date.now();
  try {
    const { redis } = await import("./redis");
    const dk = bwDayKey(now);
    const hk = bwHourKey(now);
    const sk = bwSrcKey(now);
    const p = redis().pipeline();
    p.incrby(dk, add);
    p.incrby(hk, add);
    p.hincrby(sk, SRC(), add);
    for (const [k, ttl] of [[dk, 3 * 86400], [hk, 2 * 86400], [sk, 8 * 86400]] as const) if (!S.expired.has(k)) p.expire(k, ttl);
    const res = (await p.exec()) as unknown[];
    for (const k of [dk, hk, sk]) S.expired.add(k);
    if (S.expired.size > 50) S.expired.clear();
    S.total = Number(res[0]);
    S.hour = Number(res[1]);
    S.hourKey = hk;
    S.totalAt = now;
    S.level = levelFor(S.total, S.hour, now);
  } catch {
    S.pending += add; // Redis unreachable: keep the bytes for the next flush
  } finally {
    S.busy = false;
  }
  return S.total;
}

/** 0 normal ... 3 hard. A stale reading (no flush for 5 minutes, or yesterday's) counts as 0. */
export function bwLevel(ms = Date.now()) {
  if (process.env.BW_GOVERNOR === "off") return 0;
  if (!S.totalAt || ms - S.totalAt > 5 * 60_000 || dayOf(S.totalAt) !== dayOf(ms)) return 0;
  // a new hour starts from the day test alone until this process flushes in it
  if (hourOf(S.totalAt) !== hourOf(ms)) return levelFor(S.total, 0, ms);
  return S.level;
}

/** Cache times stretch with the level: x1, x3, x6, x10. */
export const bwMul = () => [1, 3, 6, 10][bwLevel()] || 1;

export function bwView(ms = Date.now()) {
  return {
    level: bwLevel(ms),
    dayMB: Math.round(S.total / 1e6),
    paceMB: Math.round(paceNow(ms) / 1e6),
    allowMB: Math.round(ALLOW / 1e6),
    hourMB: Math.round(S.hour / 1e6),
    hourAllowMB: Math.round(HOURLY / 1e6),
    hourRate: Math.round(hourRate(S.hour, ms) * 100) / 100,
    at: S.totalAt,
  };
}

/** Test hook. */
export function _bwSet(total: number, at = Date.now(), hour = 0) {
  S.total = total;
  S.hour = hour;
  S.totalAt = at;
  S.level = levelFor(total, hour, at);
}
