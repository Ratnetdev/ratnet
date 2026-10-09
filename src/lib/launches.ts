// v0.1.42: launch records through one write-through cache in the worker.
// Before, the fast lane, the slow lane, CATCH, FLASH, WIRE, the desk and HOUND each read the same records again with
// MGET (41MB an hour, the worker's largest read on 8 Oct) and each wrote its own copy back whole, so a lane could
// write back a record read before another lane added the outcome (a fast bonder then learned as a loss). In the
// worker every lane now gets the same object for a mint and every write updates it, so changes from different lanes
// end up in the one record that is written. Other processes (the site, the Vercel fallback) read Redis as before.
import { K, redis } from "./redis";
import type { Launch } from "./digger";
import { archiveLaunch } from "./archive";

const IN_WORKER = () => process.env.RATNET_WORKER === "1";
const LC = new Map<string, { rec: Launch | null; at: number }>();
const MAX = 25_000;
const AGE = 10 * 60_000; // re-read after 10 minutes (only another process could have written it)

function put(mint: string, rec: Launch | null) {
  if (!IN_WORKER()) return;
  if (LC.size >= MAX) {
    let n = Math.floor(MAX / 5);
    for (const k of LC.keys()) {
      LC.delete(k);
      if (--n <= 0) break;
    }
  }
  LC.delete(mint);
  LC.set(mint, { rec, at: Date.now() });
}

/** Launch records for many mints, same order. In the worker: from memory when known, the rest in one MGET. */
export async function getLaunches(mints: string[], maxAgeMs = AGE): Promise<(Launch | null)[]> {
  if (!mints.length) return [];
  if (!IN_WORKER()) return (((await redis().mget<(Launch | null)[]>(...mints.map((m) => K.launch(m)))) || []) as (Launch | null)[]).map((x) => x ?? null);
  const now = Date.now();
  const miss = Array.from(new Set(mints.filter((m) => {
    const h = LC.get(m);
    return !h || now - h.at > maxAgeMs;
  })));
  if (miss.length) {
    const got = ((await redis().mget<(Launch | null)[]>(...miss.map((m) => K.launch(m)))) || []) as (Launch | null)[];
    miss.forEach((m, i) => {
      const h = LC.get(m);
      // a record this process holds is never replaced by an older copy without its fields
      put(m, got[i] ?? h?.rec ?? null);
    });
  }
  return mints.map((m) => LC.get(m)?.rec ?? null);
}

export async function getLaunch(mint: string, maxAgeMs = AGE) {
  return (await getLaunches([mint], maxAgeMs))[0] ?? null;
}

type SetOpts = { ex: number } | { keepTtl: true };
/** Write a launch record (on a pipeline or the client) and keep the worker's copy in step. */
export function putLaunch<T>(p: { set: (k: string, v: unknown, o?: any) => T }, rec: Launch, opts: SetOpts = { keepTtl: true }): T {
  put(rec.mint, rec);
  archiveLaunch(rec); // v0.1.55: the archive keeps every launch for good (only when something that matters changed)
  return p.set(K.launch(rec.mint), rec, opts);
}

/** Forget a record (tests, resets). */
export const dropLaunch = (mint: string) => LC.delete(mint);
