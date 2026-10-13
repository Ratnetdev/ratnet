// v0.1.72: AFTER. The senders (the coins that do $1M to $5M in volume within hours) do it after they migrate, in their
// canonical PumpSwap pool. The archive only had their curve, so GRID sold every trade at the migration and could never
// test holding through it. AFTER follows every migrated coin's pool price for 6 hours: the worker sees the migration on
// the live curve stream, looks up the pool's two vault accounts once (one chain read for up to 50 coins), and a Helius
// websocket feed streams the vaults. Every price goes to the archive (archivePoolTick) and to the GRID LIVE books.
import { redis } from "./redis";

export const AFTER_MS = 6 * 3600_000;
const LOOKUP_MS = 15 * 60_000; // keep looking for the pool this long after the migration
const MIG_KEY = "rn:after:mig";
const MIG = new Map<string, number>(); // mint -> migrated at
const READY = new Set<string>(); // pool vaults known (cached in rn:pools)
const TRIED = new Map<string, number>(); // mint -> last lookup
export const afterStats = { migrations: 0, pools: 0, lookups: 0, quotes: 0, lastError: "" };

export async function afterLoad(now = Date.now()) {
  const h = (await redis().hgetall<Record<string, number>>(MIG_KEY).catch(() => null)) || {};
  for (const [m, at] of Object.entries(h)) if (now - Number(at) < AFTER_MS) MIG.set(m, Number(at));
}

/** A curve completed (the live curve stream). */
export function afterNoteMigration(mint: string, now = Date.now()) {
  if (MIG.has(mint)) return false;
  MIG.set(mint, now);
  afterStats.migrations++;
  redis().hset(MIG_KEY, { [mint]: now }).catch(() => null);
  return true;
}
export const migratedAt = (mint: string) => MIG.get(mint) ?? null;

/** The coins whose pools the feed should stream (migrated within 6 hours, pool known). */
export function afterWant(now = Date.now()) {
  const out = new Set<string>();
  for (const [m, at] of MIG) {
    if (now - at > AFTER_MS) {
      MIG.delete(m);
      READY.delete(m);
      TRIED.delete(m);
      redis().hdel(MIG_KEY, m).catch(() => null);
      continue;
    }
    if (READY.has(m)) out.add(m);
  }
  return out;
}

/** Look up the pool vaults of new migrations (every 20 seconds; a pool can take a few seconds to appear). */
export async function afterResolve(read: (mints: string[]) => Promise<Record<string, { px: number; sol: number } | null>>, now = Date.now()) {
  const todo = [...MIG.entries()].filter(([m, at]) => !READY.has(m) && now - at < LOOKUP_MS && now - (TRIED.get(m) || 0) >= 20_000).map(([m]) => m).slice(0, 50);
  if (!todo.length) return [];
  for (const m of todo) TRIED.set(m, now);
  afterStats.lookups++;
  try {
    const got = await read(todo);
    const found: string[] = [];
    for (const m of todo) if (got[m]) (READY.add(m), found.push(m));
    afterStats.pools += found.length;
    return found;
  } catch (e: any) {
    afterStats.lastError = String(e?.message || e).slice(0, 120);
    return [];
  }
}

/** Tests: reset the memory. */
export function afterReset() {
  MIG.clear();
  READY.clear();
  TRIED.clear();
}
