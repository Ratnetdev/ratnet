// Live prices for the site, from the worker (v0.1.38). Before, every page with coins on it called /api/px every 2s,
// and each call read the chain from Vercel on the same Helius key: credits the worker's daily budget never saw.
// Now /api/px only reads this cache and notes which coins viewers want; the worker prices those coins on its own
// budgeted lane, at most every 8s per coin, and writes the cache. A coin not in the cache yet gets DexScreener's price
// (free) until the worker's read lands.
import { redis } from "./redis";

export const PXC = "rn:pxc"; // mint -> { px, grad, at }
export const PXWANT = "rn:pxwant"; // zset mint -> last time a viewer asked
export type PxEntry = { px: number; grad: boolean; at: number };

/** Worker: price what viewers asked for in the last 30s (max 150 coins), on the agents' lane. */
export async function refreshPxCache(price: (mints: string[]) => Promise<Record<string, { px: number; grad: boolean; src?: string }>>, now = Date.now()) {
  const r = redis();
  const want = ((await r.zrange<string[]>(PXWANT, now - 30_000, now, { byScore: true, offset: 0, count: 150 }).catch(() => [])) || []) as string[];
  if (Math.random() < 0.1) await r.zremrangebyscore(PXWANT, 0, now - 120_000).catch(() => 0);
  if (!want.length) return { want: 0, priced: 0 };
  const px = await price(want);
  const out: Record<string, PxEntry> = {};
  for (const m of want) if (px[m]?.px > 0 && px[m].src !== "dex") out[m] = { px: px[m].px, grad: !!px[m].grad, at: Date.now() };
  if (Object.keys(out).length) {
    await r.hset(PXC, out);
    await r.expire(PXC, 600);
  }
  return { want: want.length, priced: Object.keys(out).length };
}

/** Site: cached prices for these coins (fresh within 20s), and note that viewers want them. */
export async function readPxCache(mints: string[], now = Date.now()) {
  const r = redis();
  const [got] = await Promise.all([
    mints.length ? r.hmget<Record<string, PxEntry | null>>(PXC, ...mints).catch(() => null) : Promise.resolve(null),
    mints.length ? r.zadd(PXWANT, ...(mints.map((m) => ({ score: now, member: m })) as [{ score: number; member: string }])).catch(() => 0) : Promise.resolve(0),
  ]);
  const fresh: Record<string, PxEntry> = {};
  for (const m of mints) {
    const e = (got || ({} as Record<string, PxEntry | null>))[m];
    if (e && now - e.at < 20_000) fresh[m] = e;
  }
  return fresh;
}
