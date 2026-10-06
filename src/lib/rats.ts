import { ROUND_MS, SCOUTS, Settings } from "@/config/site";
import { K, redis } from "./redis";

export type Rat = {
  id: number;
  name: string;
  owner: string;
  litter: number;
  sig: string;
  spawnedAt: number;
  costSol: number | null;
  earnedSol: number;
};

export const ratName = (id: number) => `RAT-${String(id).padStart(3, "0")}`;
export const roundOf = (ms = Date.now()) => Math.floor(ms / ROUND_MS);
export const roundStart = (r: number) => r * ROUND_MS;

export async function allRats(): Promise<Rat[]> {
  const h = (await redis().hgetall<Record<string, Rat>>(K.rats)) || {};
  return Object.values(h).sort((a, b) => a.id - b.id);
}

export function isActive(r: Rat, s: Settings) {
  return r.litter <= s.litter.n;
}

/**
 * Hand out `n` work units round-robin over active rats (scouts if none).
 * Returns the worker name for each unit plus per-rat counts to persist.
 */
export async function assignWork(n: number, s: Settings) {
  if (n <= 0) return { names: [] as string[], counts: {} as Record<string, number>, real: false };
  const rats = (await allRats()).filter((r) => isActive(r, s));
  const pool = rats.length ? rats.map((r) => r.name) : SCOUTS;
  const end = await redis().incrby(K.rr, n);
  const start = end - n;
  const names: string[] = [];
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const name = pool[(start + i) % pool.length];
    names.push(name);
    counts[name] = (counts[name] || 0) + 1;
  }
  return { names, counts, real: rats.length > 0 };
}

export async function recordWork(counts: Record<string, number>, last: Record<string, unknown>, real: boolean) {
  if (!Object.keys(last).length && (!real || !Object.keys(counts).length)) return;
  const p = redis().pipeline();
  const key = K.work(roundOf());
  if (real) {
    for (const [name, c] of Object.entries(counts)) {
      p.hincrby(key, name, c);
      p.hincrby(K.workAll, name, c);
    }
    p.expire(key, 60 * 60 * 24 * 14);
  }
  if (Object.keys(last).length) p.hset(K.ratLast, last as Record<string, unknown>);
  await p.exec();
}
