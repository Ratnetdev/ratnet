// Redis growth control (v0.1.28). Some tables grow with every launch and every early wallet and had no limit:
// dev records, wallet and funder records, the funder cache, CATCH's last looks, finished runs and the "near" set.
// Once every 6 hours (worker beat) each is trimmed back below its cap, oldest or least useful entries first:
//  - count tables (wallet/dev/funder -> n): entries seen once go first (one data point teaches nothing), and the
//    same field goes from the matching bonded/$1M tables so the ratios stay consistent
//  - CATCH last looks older than a day, finished runs older than 14 days
//  - caches (funder of a wallet) and the near set: trimmed to the cap
// Each run scans a bounded number of fields, so a trim never costs a big burst of Redis bandwidth.
import { redis, K } from "./redis";
import { GK, HGK } from "./graph";

const SCAN_MAX = 60_000; // fields read per table per run at most
const DAY = 86400_000;

type Field = [string, unknown];

async function scanFields(key: string, keep: (f: Field) => boolean, want: number) {
  const r = redis();
  const drop: string[] = [];
  let cursor: string | number = 0;
  let seen = 0;
  do {
    const [next, flat] = (await r.hscan(key, cursor, { count: 1000 })) as [string | number, unknown[]];
    cursor = next;
    for (let i = 0; i + 1 < flat.length; i += 2) {
      seen++;
      if (!keep([String(flat[i]), flat[i + 1]])) drop.push(String(flat[i]));
    }
  } while (String(cursor) !== "0" && drop.length < want && seen < SCAN_MAX);
  return drop.slice(0, Math.max(0, want));
}

async function hdelMany(keys: string[], fields: string[]) {
  const r = redis();
  for (let i = 0; i < fields.length; i += 500) {
    const part = fields.slice(i, i + 500);
    const p = r.pipeline();
    for (const k of keys) p.hdel(k, ...part);
    await p.exec();
  }
}

/** A count table over its cap: drop entries with a count of 1 (from it and its linked tables). */
async function pruneCounts(main: string, linked: string[], cap: number) {
  const n = Number((await redis().hlen(main)) || 0);
  if (n <= cap) return 0;
  const want = n - Math.floor(cap * 0.8);
  const drop = await scanFields(main, ([, v]) => Number(v) > 1, want);
  if (drop.length) await hdelMany([main, ...linked], drop);
  return drop.length;
}

/** A plain cache over its cap: drop whatever the scan reaches first (the order is effectively random). */
async function pruneCache(key: string, cap: number) {
  const n = Number((await redis().hlen(key)) || 0);
  if (n <= cap) return 0;
  const drop = await scanFields(key, () => false, n - Math.floor(cap * 0.8));
  if (drop.length) await hdelMany([key], drop);
  return drop.length;
}

/** Entries whose stored time is older than maxAge. */
async function pruneByAge(key: string, timeOf: (v: any) => number, maxAge: number, now: number) {
  const drop = await scanFields(key, ([, v]) => now - (timeOf(v) || 0) <= maxAge, 50_000);
  if (drop.length) await hdelMany([key], drop);
  return drop.length;
}

export const PRUNE_CAPS = { dev: 250_000, wallet: 250_000, funder: 100_000, fof: 200_000, near: 5_000 };

export async function pruneRedis(now = Date.now()) {
  const r = redis();
  // one run per 6 hours across every process
  const go = await r.set("rn:prune:at", now, { nx: true, ex: 6 * 3600 }).catch(() => null);
  if (!go) return { prune: "not due" };
  const out: Record<string, number> = {};
  const safe = async (name: string, f: () => Promise<number>) => {
    out[name] = await f().catch(() => -1);
  };
  await safe("devs", () => pruneCounts(K.devN, [K.devB], PRUNE_CAPS.dev));
  await safe("wallets", () => pruneCounts(GK.sN, [GK.sB, GK.sM], PRUNE_CAPS.wallet));
  await safe("funders", () => pruneCounts(GK.cN, [GK.cB, GK.cM], PRUNE_CAPS.funder));
  await safe("hwallets", () => pruneCounts(HGK.sN, [HGK.sB, HGK.sM], PRUNE_CAPS.wallet));
  await safe("hfunders", () => pruneCounts(HGK.cN, [HGK.cB, HGK.cM], PRUNE_CAPS.funder));
  await safe("fof", () => pruneCache(GK.fof, PRUNE_CAPS.fof));
  await safe("ctLast", () => pruneByAge("rn:ct:last", (v) => Number(v?.at), DAY, now));
  await safe("runFin", () => pruneByAge("rn:run:fin", (v) => Number(v?.pkAt || v?.bondedAt || v?.createdAt), 14 * DAY, now));
  await safe("near", async () => {
    const n = Number((await r.scard(K.near)) || 0);
    if (n <= PRUNE_CAPS.near) return 0;
    const k = n - Math.floor(PRUNE_CAPS.near * 0.8);
    await r.spop(K.near, k);
    return k;
  });
  return { prune: out };
}
