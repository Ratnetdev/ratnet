// A small in-process cache for big Redis reads that change slowly. The WIRE account list (5,000+ accounts), its
// counters and HOUND's wallet book used to be read whole on every post ingested and every page poll: tens of GB a day
// of Upstash bandwidth (the plan limit that took the whole site down on 7 Oct). One read per TTL per process now.
import { bwMul } from "./bwgov";
const store = new Map<string, { at: number; v: unknown; p?: Promise<unknown> }>();

export async function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  // v0.1.40: when the day's Redis bandwidth runs ahead of pace, every cache holds 3x (or 6x) longer
  if (hit && now - hit.at < ttlMs * bwMul()) return hit.v as T;
  if (hit?.p) return hit.p as Promise<T>; // one load at a time
  const p = load()
    .then((v) => {
      store.set(key, { at: Date.now(), v });
      return v;
    })
    .catch((e) => {
      if (hit) store.set(key, { at: hit.at, v: hit.v });
      else store.delete(key);
      throw e;
    });
  store.set(key, { at: hit?.at ?? 0, v: hit?.v, p });
  return p;
}

/** Update a cached object in place after a write, so the cache never lags behind this process's own writes. */
export function memoPatch<T extends Record<string, unknown>>(key: string, patch: Partial<T>) {
  const hit = store.get(key);
  if (hit && hit.v && typeof hit.v === "object") Object.assign(hit.v as T, patch);
}

export function memoDrop(key: string) {
  store.delete(key);
}
