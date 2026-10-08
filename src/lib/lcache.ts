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
  if (c && seq != null && c.seq != null && Number(seq) > Number(c.seq) && now - c.at < FULL_EVERY) {
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
