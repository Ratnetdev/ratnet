// twitterapi.io credit meter. Every paid read is counted where it happens (twitterapi.io bills 15 credits per post
// returned, 18 per profile, 15 minimum per call; filter rules are billed per check), so the hourly burn shows on
// /status instead of only on the twitterapi.io dashboard, and the agents can stay under a budget.
import { redis } from "./redis";

const KEY = (h: string) => `rn:xc:${h}`;
const hourKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 13);
export const X_BUDGET = Math.max(5_000, Number(process.env.X_CREDITS_PER_HOUR || 25_000)); // all of RATNET, per hour

/** Credits for one call that returned `posts` posts and `users` profiles. */
export const xCost = (posts: number, users = 0) => Math.max(15, posts * 15 + users * 18);

export async function xSpend(what: string, credits: number) {
  if (!(credits > 0)) return;
  const r = redis();
  const k = KEY(hourKey());
  await r.hincrby(k, what, Math.round(credits)).catch(() => {});
  await r.expire(k, 3 * 86400).catch(() => {});
}

/** This hour so far (by part) and the rules' fixed checking cost per hour. */
export async function xSpendView() {
  const r = redis();
  const [now, prev, synced] = await Promise.all([r.hgetall<Record<string, number>>(KEY(hourKey())), r.hgetall<Record<string, number>>(KEY(hourKey(Date.now() - 3600_000))), r.get<any>("rn:x:synced")]);
  const sum = (o: Record<string, number> | null) => Object.values(o || {}).reduce((a, x) => a + Number(x || 0), 0);
  const rulesPerHour = synced?.n ? Math.round(synced.n * (3600 / (synced.interval || 60)) * 15) : 0;
  const mins = new Date().getUTCMinutes() + 1;
  return { budget: X_BUDGET, thisHour: sum(now) + Math.round((rulesPerHour * mins) / 60), lastHour: sum(prev) + rulesPerHour, rulesPerHour, rules: synced?.n ?? 0, paidAccounts: synced?.accounts ?? 0, by: { ...(now || {}), rules: Math.round((rulesPerHour * mins) / 60) } };
}

/** Whether a part may still spend this hour (LENS and the extras stop first; WIRE's rules are sized in advance). */
export async function xAllowed(share = 1) {
  const r = redis();
  const now = await r.hgetall<Record<string, number>>(KEY(hourKey())).catch(() => null);
  const used = Object.values(now || {}).reduce((a, x) => a + Number(x || 0), 0);
  const synced = await r.get<any>("rn:x:synced").catch(() => null);
  const rules = synced?.n ? synced.n * (3600 / (synced.interval || 60)) * 15 * ((new Date().getUTCMinutes() + 1) / 60) : 0;
  return used + rules < X_BUDGET * share;
}
