// v0.1.40: a short-lived, size-capped in-process cache for per-coin reads that hot loops repeat many times a minute
// (Launch records, BOARD posts). CATCH alone read up to 240 full Launch records every pass; with a 30s cache most of
// those reads are served from memory. Only for readers that can live with data up to `ttlMs` old.
import { K, redis } from "./redis";
import type { Launch } from "./digger";
import { bwMul } from "./bwgov";

type Hit<T> = { at: number; v: T };
const MAX = 5000;

function makeCache<T>() {
  const m = new Map<string, Hit<T>>();
  const put = (k: string, v: T) => {
    if (m.size >= MAX) {
      // drop the oldest quarter (Map keeps insertion order)
      let n = Math.floor(MAX / 4);
      for (const key of m.keys()) {
        m.delete(key);
        if (--n <= 0) break;
      }
    }
    m.delete(k);
    m.set(k, { at: Date.now(), v });
  };
  return { m, put };
}

const L = makeCache<Launch | null>();

/** Launch records for many mints, from memory when read in the last `ttlMs`. Same order as `mints`. */
export async function launchesCached(mints: string[], ttlMs = 30_000): Promise<(Launch | null)[]> {
  // v0.1.42: in the worker every launch record lives in one write-through cache (lib/launches.ts)
  if (process.env.RATNET_WORKER === "1") return (await import("./launches")).getLaunches(mints, Math.max(ttlMs, 60_000));
  const now = Date.now();
  ttlMs *= bwMul();
  const miss = Array.from(new Set(mints.filter((x) => {
    const h = L.m.get(x);
    return !h || now - h.at >= ttlMs;
  })));
  if (miss.length) {
    const got = ((await redis().mget<(Launch | null)[]>(...miss.map((x) => K.launch(x)))) || []) as (Launch | null)[];
    miss.forEach((x, i) => L.put(x, got[i] || null));
  }
  return mints.map((x) => L.m.get(x)?.v ?? null);
}

const B = makeCache<unknown>();

/** Any per-key read, cached in memory for `ttlMs` (key must be unique across callers). */
export async function cachedRead<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const h = B.m.get(key);
  if (h && Date.now() - h.at < ttlMs * bwMul()) return h.v as T;
  const v = await load();
  B.put(key, v);
  return v;
}

// v0.1.40: big Redis lists that only ever grow at the head (the desk's 2,000 trades, its 1,000 round trips with their
// charts), kept in memory per process. A writer bumps the list's change counter (seqKey) whenever it pushes; a reader
// reads that tiny counter and, only when it moved, the few newest rows, merged by id. Before, every exam (every 30s),
// every track-record build and every desk page read the whole lists: megabytes per read, the biggest part of the
// bandwidth that suspended the database on 8 Oct.
type LC = { seq: string | null; at: number; rows: unknown[] };
const LISTS = new Map<string, LC>();
const FULL_EVERY = 30 * 60_000;

export async function listCached<T>(key: string, seqKey: string, max: number, idOf: (x: T) => string): Promise<T[]> {
  const r = redis();
  const raw = await r.get<number | string>(seqKey).catch(() => undefined);
  if (raw === undefined) return ((await r.lrange<T>(key, 0, max - 1)) || []) as T[]; // counter unreadable: read plainly
  const seq = raw == null ? null : String(raw);
  const c = LISTS.get(key);
  const now = Date.now();
  if (c && c.seq === seq && now - c.at < (seq == null ? 60_000 : FULL_EVERY)) return c.rows as T[];
  // a jump of more than 500 is a reset (v0.1.41: resets bump the counter by a million): read the list whole
  if (c && seq != null && c.seq != null && Number(seq) > Number(c.seq) && Number(seq) - Number(c.seq) <= 500 && now - c.at < FULL_EVERY) {
    // only the newest rows: grow the window until it reaches the newest row already held
    const top = c.rows.length ? idOf(c.rows[0] as T) : null;
    for (const n of [Math.min(max, Number(seq) - Number(c.seq) + 4), 100]) {
      const head = ((await r.lrange<T>(key, 0, n - 1)) || []) as T[];
      const i = top == null ? -1 : head.findIndex((x) => idOf(x) === top);
      if (i >= 0) {
        c.rows = [...head.slice(0, i), ...c.rows].slice(0, max);
        c.seq = seq;
        return c.rows as T[];
      }
    }
  }
  const rows = ((await r.lrange<T>(key, 0, max - 1)) || []) as T[];
  LISTS.set(key, { seq, at: now, rows });
  return rows;
}

/** Forget a cached list (after a reset in this process). */
export const listDrop = (key: string) => LISTS.delete(key);

const G = makeCache<unknown>();
/** Many keys by MGET, each served from memory when read in the last `ttlMs`. Same order as `keys`. */
export async function mgetCached<T>(keys: string[], ttlMs: number): Promise<(T | null)[]> {
  const now = Date.now();
  ttlMs *= bwMul();
  const miss = Array.from(new Set(keys.filter((k) => {
    const h = G.m.get(k);
    return !h || now - h.at >= ttlMs;
  })));
  if (miss.length) {
    const got = ((await redis().mget<(T | null)[]>(...miss)) || []) as (T | null)[];
    miss.forEach((k, i) => G.put(k, got[i] ?? null));
  }
  return keys.map((k) => (G.m.get(k)?.v ?? null) as T | null);
}

// v0.1.42: the top of the hot-curve ranking (rn:radar), shared by the slow lane, CATCH and the trade stream's
// subscription list in the worker: one read every 8s instead of three or four.
export async function radarTop(n: number): Promise<string[]> {
  const { memo } = await import("./memo");
  const top = await memo("radar:top200", 8_000, async () => ((await redis().zrange<string[]>(K.radar, 0, 199, { rev: true })) || []) as string[]);
  if (n <= 200) return top.slice(0, n);
  return ((await redis().zrange<string[]>(K.radar, 0, n - 1, { rev: true })) || []) as string[];
}
