// Live prices for the site, from the worker (v0.1.38). Before, every page with coins on it called /api/px every 2s,
// and each call read the chain from Vercel on the same Helius key: credits the worker's daily budget never saw.
// Now /api/px only reads this cache and notes which coins viewers want; the worker prices those coins on its own
// budgeted lane, at most every 8s per coin, and writes the cache. A coin not in the cache yet gets DexScreener's price
// (free) until the worker's read lands.
import { redis } from "./redis";

export const PXC = "rn:pxc"; // mint -> { px, grad, at }
export const PXWANT = "rn:pxwant"; // zset mint -> last time a viewer asked
export type PxEntry = { px: number; grad: boolean; at: number };

// v0.1.41: the whole cache is one value (rn:pxall) the worker rewrites, read by each server instance at most every
// 4s; viewers' wishes are noted at most once per 25s per coin and instance. Before, every /api/px call read up to 60
// hash fields and wrote 60 sorted-set members.
export const PXALL = "rn:pxall";
type PxAll = { at: number; px: Record<string, PxEntry> };
let ALL: Record<string, PxEntry> = {};
// v0.1.84: coins the firehose priced in the last 3s: the slower chain refresh never writes an older price over them
const FAST_AT = new Map<string, number>();
let WANT: { at: number; list: string[] } = { at: 0, list: [] };
const FAST_WRITE = { at: 0 };
/** Tests. */
export function _pxReset() {
  ALL = {};
  FAST_AT.clear();
  WANT = { at: 0, list: [] };
  FAST_WRITE.at = 0;
}

/** Worker: price what viewers asked for in the last 30s (max 150 coins), on the agents' lane. */
export async function refreshPxCache(price: (mints: string[]) => Promise<Record<string, { px: number; grad: boolean; src?: string }>>, now = Date.now()) {
  const r = redis();
  const want = ((await r.zrange<string[]>(PXWANT, now - 30_000, now, { byScore: true, offset: 0, count: 150 }).catch(() => [])) || []) as string[];
  if (Math.random() < 0.1) await r.zremrangebyscore(PXWANT, 0, now - 120_000).catch(() => 0);
  for (const [m, e] of Object.entries(ALL)) if (now - e.at > 60_000) delete ALL[m];
  if (!want.length) return { want: 0, priced: 0 };
  WANT = { at: now, list: want };
  // v0.1.84: only coins the firehose is not pricing go to the chain refresh
  const slow = want.filter((m) => !(now - (FAST_AT.get(m) || 0) < 3_000));
  if (!slow.length) return { want: want.length, priced: 0 };
  const px = await price(slow);
  let n = 0;
  for (const m of slow) if (px[m]?.px > 0 && px[m].src !== "dex" && !(Date.now() - (FAST_AT.get(m) || 0) < 3_000)) (ALL[m] = { px: px[m].px, grad: !!px[m].grad, at: Date.now() }), n++;
  if (n) await r.set(PXALL, { at: Date.now(), px: ALL } satisfies PxAll, { ex: 120 });
  return { want: want.length, priced: n };
}

/**
 * v0.1.84: every second (worker, firehose up): the coins viewers want (and the desk's open positions), priced from the
 * firehose's own state (every trade, no chain read). Written only when a price moved. Before, a price on the site
 * went through a 4-8s chain refresh, 4s caches on both sides and a 4s poll: up to ~20s behind the chain.
 */
export async function refreshPxFast(fast: (mint: string) => { px: number; grad: boolean } | null, extra: string[] = [], now = Date.now()) {
  // the want list is refreshed with the slow pass (every 4s); here it is only read from memory
  const list = Array.from(new Set([...(now - WANT.at < 30_000 ? WANT.list : []), ...extra]));
  let moved = 0;
  for (const m of list) {
    const q = fast(m);
    if (!q || !(q.px > 0)) continue;
    FAST_AT.set(m, now);
    const cur = ALL[m];
    if (!cur || cur.px !== q.px || cur.grad !== q.grad) moved++;
    ALL[m] = { px: q.px, grad: q.grad, at: now };
  }
  if (FAST_AT.size > 2000) for (const [m, t] of FAST_AT) if (now - t > 60_000) FAST_AT.delete(m);
  // a quiet coin's price still counts as current on the site (fresh = written within 20s): at least every 10s
  if (moved || (list.length && now - FAST_WRITE.at > 10_000)) {
    FAST_WRITE.at = now;
    await redis().set(PXALL, { at: now, px: ALL } satisfies PxAll, { ex: 120 }).catch(() => null);
  }
  return { list: list.length, moved };
}

const NOTED = new Map<string, number>();

/** Site: cached prices for these coins (fresh within 20s), and note that viewers want them. */
export async function readPxCache(mints: string[], now = Date.now()) {
  const r = redis();
  const { memo } = await import("./memo");
  const toNote = mints.filter((m) => now - (NOTED.get(m) || 0) > 25_000);
  for (const m of toNote) NOTED.set(m, now);
  if (NOTED.size > 5000) NOTED.clear();
  const [all] = await Promise.all([
    memo("pxall", 1_000, async () => ((await r.get<PxAll>(PXALL).catch(() => null))?.px || {}) as Record<string, PxEntry>),
    toNote.length ? r.zadd(PXWANT, ...(toNote.map((m) => ({ score: now, member: m })) as [{ score: number; member: string }])).catch(() => 0) : Promise.resolve(0),
  ]);
  const fresh: Record<string, PxEntry> = {};
  for (const m of mints) {
    const e = all[m];
    if (e && now - e.at < 20_000) fresh[m] = e;
  }
  return fresh;
}
