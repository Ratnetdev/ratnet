// Chain reads per day, per lane (the worker flushes its counters every 20s). Helius bills per call: this is the number
// to hold against the plan's monthly credits. The historian has its own daily cap so it can never eat the month.
import { redis } from "./redis";
import { rpcStats, rpcView, seedDayUsed, DAY_BUDGET } from "./solana";

const KEY = (d: string) => `rn:rpcd:${d}`;
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const LANES = ["desk", "rats", "agents", "historian"];
export const HIST_PER_DAY = Math.max(10_000, Number(process.env.HISTORIAN_CALLS_PER_DAY || 60_000));

let last = [0, 0, 0, 0];
export async function flushRpcDay() {
  const cur = [...rpcStats.byLane];
  const d = cur.map((x, i) => x - last[i]);
  last = cur;
  if (!d.some((x) => x > 0)) return;
  const r = redis();
  const k = KEY(day());
  const p = r.pipeline();
  d.forEach((x, i) => x > 0 && p.hincrby(k, LANES[i], x));
  p.expire(k, 40 * 86400);
  await p.exec().catch(() => null);
}

const sum = (o: Record<string, number> | null) => Object.values(o || {}).reduce((a, x) => a + Number(x || 0), 0);

/** At worker boot: carry on from the day's recorded count, so a restart can't hand out a fresh budget. */
export async function seedRpcDay() {
  const d = day();
  const v = await redis().hgetall<Record<string, number>>(KEY(d)).catch(() => null);
  seedDayUsed(d, sum(v));
}

/**
 * perSecLive comes from the worker's last minute (written to rn:rpc each beat). The monthly pace is that live rate
 * times a month: before v0.1.28 it was today's count divided by the fraction of the day gone, which read far too low
 * when the counter started mid-day.
 */
export async function rpcDayView(perSecLive?: number) {
  const r = redis();
  const [today, yday] = await Promise.all([r.hgetall<Record<string, number>>(KEY(day())), r.hgetall<Record<string, number>>(KEY(day(Date.now() - 86400_000)))]);
  const t = sum(today);
  const live = Number(perSecLive ?? rpcView().perSec) || 0;
  const now = new Date();
  const frac = (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()) / 86400;
  return {
    today: t,
    byLane: today || {},
    yesterday: sum(yday),
    perSecLive: live,
    perMonth: Math.round(live * 86400 * 30),
    budget: DAY_BUDGET,
    pace: DAY_BUDGET ? Math.round(DAY_BUDGET * Math.min(1, frac + 0.05)) : 0,
    histCap: HIST_PER_DAY,
  };
}

/** The historian stops for the day once it used its share. */
export async function historianCapped() {
  const v = await redis().hget<number>(KEY(day()), "historian").catch(() => 0);
  return Number(v || 0) >= HIST_PER_DAY;
}
