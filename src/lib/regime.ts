// REGIME: the season a launch was born in. The trenches of late 2024 are not the trenches of today:
// SOL's trend and how busy pump.fun is change what works. Every lesson carries the regime it happened in,
// live and replayed, so the models learn "what works in this kind of market" instead of averaging all seasons.

import { K, hourKey, redis } from "./redis";

export const RG = {
  solh: "rn:solh", // hash: hour -> SOL price USD
  sold: "rn:sold", // hash: day -> SOL price USD
  lrate: "rn:lrate", // hash: hour -> pump.fun launches per hour
  at: "rn:solh:at",
};
// Raydium SOL/USDC, the deepest SOL pool: its candles are the SOL price history
const SOL_POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

export type Regime = { sol24: number | null; sol7d: number | null; lrate: number | null };

/** Load up to ~40 days of hourly and ~3 years of daily SOL prices once every 12h (GeckoTerminal, free). */
export async function ensureSolHistory() {
  const r = redis();
  const at = await r.get<number>(RG.at);
  if (at && Date.now() - at < 12 * 3600_000) return;
  await r.set(RG.at, Date.now());
  const get = async (u: string) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(u, { signal: ctrl.signal, cache: "no-store", headers: { accept: "application/json" } });
      clearTimeout(t);
      return res.ok ? res.json() : null;
    } catch {
      return null;
    }
  };
  const [h, d]: any[] = await Promise.all([
    get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${SOL_POOL}/ohlcv/hour?limit=1000&currency=usd`),
    get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${SOL_POOL}/ohlcv/day?limit=1000&currency=usd`),
  ]);
  const hours: Record<string, number> = {};
  for (const c of h?.data?.attributes?.ohlcv_list || []) hours[hourKey(c[0] * 1000)] = Number(c[4]);
  const days: Record<string, number> = {};
  for (const c of d?.data?.attributes?.ohlcv_list || []) days[new Date(c[0] * 1000).toISOString().slice(0, 10)] = Number(c[4]);
  // v0.1.42: nothing came back (GeckoTerminal down or rate limited): try again in 10 minutes, not 12 hours. On a fresh
  // database every regime input stayed empty half a day.
  if (!Object.keys(hours).length && !Object.keys(days).length) {
    await r.set(RG.at, Date.now() - 12 * 3600_000 + 10 * 60_000);
    return;
  }
  const p = r.pipeline();
  if (Object.keys(hours).length) p.hset(RG.solh, hours);
  if (Object.keys(days).length) p.hset(RG.sold, days);
  await p.exec();
  cache.clear();
}

/** The live rats write the current SOL price into the history every run. */
export async function recordSol(price: number | null) {
  if (!price) return;
  await redis().hset(RG.solh, { [hourKey()]: price });
}

// v0.1.42: a complete reading is kept for good; one with a missing input only for a minute (at a cold start the SOL
// history and the hour counters are empty, and that null used to be cached for the rest of the hour)
const cache = new Map<string, Regime & { _at?: number }>();

export async function regimeAt(t: number): Promise<Regime> {
  const hk = hourKey(t);
  const c = cache.get(hk);
  if (c && (!c._at || Date.now() - c._at < 60_000)) {
    const { _at, ...g } = c;
    return g;
  }
  const r = redis();
  const h24 = hourKey(t - 24 * 3600_000);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const p = r.pipeline();
  p.hmget(RG.solh, hk, h24);
  p.hmget(RG.sold, day(t), day(t - 86400_000), day(t - 7 * 86400_000));
  p.hget(RG.lrate, hk);
  p.hget(K.hr(hourKey(t - 3600_000)), "d");
  const [hp, dp, lr, dug] = (await p.exec()) as any[];
  const now = Number(hp?.[hk] || dp?.[day(t)] || 0);
  const then24 = Number(hp?.[h24] || dp?.[day(t - 86400_000)] || 0);
  const then7 = Number(dp?.[day(t - 7 * 86400_000)] || 0);
  const g: Regime = {
    sol24: now && then24 ? Math.round((now / then24 - 1) * 1000) / 10 : null,
    sol7d: now && then7 ? Math.round((now / then7 - 1) * 1000) / 10 : null,
    lrate: Number(lr || 0) || Number(dug || 0) || null,
  };
  if (cache.size > 2000) cache.clear();
  // the historian's old hours stay incomplete for good (no launch counts that far back): those are kept too
  const whole = (g.sol24 != null && g.sol7d != null && g.lrate != null) || Date.now() - t > 3 * 3600_000;
  cache.set(hk, whole ? g : { ...g, _at: Date.now() });
  return g;
}

/** Live view for the Lab: the season right now. */
export async function seasonNow() {
  const r = redis();
  const g = await regimeAt(Date.now() - 3600_000);
  const hours = Array.from({ length: 24 }, (_, i) => hourKey(Date.now() - (i + 1) * 3600_000));
  const p = r.pipeline();
  for (const h of hours) p.hmget(K.hr(h), "d", "b");
  const rows = ((await p.exec()) as any[]).map((x) => ({ d: Number(x?.d || 0), b: Number(x?.b || 0) }));
  const d = rows.reduce((a, x) => a + x.d, 0);
  const b = rows.reduce((a, x) => a + x.b, 0);
  return { ...g, launches24: d, bonded24: b, gradRate24: d ? Math.round((b / d) * 10000) / 100 : null };
}
