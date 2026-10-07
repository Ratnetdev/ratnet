// POOL WATCH: every coin that migrated in the last 2 hours, read once a minute in its PumpSwap pool.
//
// Why: CATCH only saw the pool stage of the ~25 coins MOMO lists (GeckoTerminal's trending pools). The slow grinders
// that migrate after 30-60 minutes and then walk to $200K-$500K were mostly not on that list when they started to
// move. Now every migration gets the same pool picture: liquidity, 5-minute volume, buys and sells, price change,
// market cap. DexScreener answers 30 coins per call, so 150 migrations cost 5 calls a minute.
import { redis } from "./redis";
import type { Hot } from "./momo";

const MIG = "rn:ct:mig";
const PL = "rn:pl"; // mint -> PoolSnap
const AT = "rn:pl:at";

export type PoolSnap = { at: number; mc: number; liq: number; v5: number; v1h: number; b5: number; s5: number; ch5: number; ch1h: number; ch6h: number; dex: string; pair: string; sym: string; created: number };

/** Read every pool that migrated in the last 2 hours (at most once a minute). */
export async function poolWatch(force = false) {
  const r = redis();
  const now = Date.now();
  if (!force && now - Number((await r.get(AT)) || 0) < 55_000) return { pools: "not due" };
  await r.set(AT, now);
  const mints = ((await r.zrange<string[]>(MIG, now - 2 * 3600_000, now, { byScore: true })) || []).map(String).slice(-240);
  if (!mints.length) return { pools: 0 };
  const out: Record<string, PoolSnap> = {};
  const batches: string[][] = [];
  for (let i = 0; i < mints.length; i += 30) batches.push(mints.slice(i, i + 30));
  await Promise.all(
    batches.map(async (b) => {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${b.join(",")}`, { cache: "no-store", signal: AbortSignal.timeout(6000) }).catch(() => null);
      const pairs: any[] = res?.ok ? ((await res.json().catch(() => [])) as any[]) : [];
      for (const pr of Array.isArray(pairs) ? pairs : []) {
        const m = pr?.baseToken?.address;
        if (!m || !b.includes(m) || !/^(SOL|WSOL)$/i.test(pr?.quoteToken?.symbol || "")) continue;
        const liq = Number(pr?.liquidity?.usd || 0);
        if (out[m] && out[m].liq >= liq) continue; // the deepest SOL pool is the coin's real one
        out[m] = {
          at: now,
          mc: Number(pr?.marketCap || pr?.fdv || 0),
          liq,
          v5: Number(pr?.volume?.m5 || 0),
          v1h: Number(pr?.volume?.h1 || 0),
          b5: Number(pr?.txns?.m5?.buys || 0),
          s5: Number(pr?.txns?.m5?.sells || 0),
          ch5: Number(pr?.priceChange?.m5 || 0),
          ch1h: Number(pr?.priceChange?.h1 || 0),
          ch6h: Number(pr?.priceChange?.h6 || 0),
          dex: String(pr?.dexId || ""),
          pair: String(pr?.pairAddress || ""),
          sym: String(pr?.baseToken?.symbol || ""),
          created: Number(pr?.pairCreatedAt || 0),
        };
      }
    }),
  );
  if (Object.keys(out).length) {
    await r.hset(PL, out);
    await r.expire(PL, 3 * 3600);
  }
  // keep the hash small: drop coins that left the 2-hour window
  const keys = ((await r.hkeys(PL).catch(() => [])) || []) as string[];
  const keep = new Set(mints);
  const old = keys.filter((k) => !keep.has(k));
  if (old.length) await r.hdel(PL, ...old).catch(() => {});
  return { pools: Object.keys(out).length, migrations: mints.length };
}

export async function poolSnaps(mints: string[]): Promise<Record<string, PoolSnap | null>> {
  if (!mints.length) return {};
  return (((await redis().hmget<Record<string, PoolSnap>>(PL, ...mints)) || {}) as Record<string, PoolSnap | null>);
}

/** A pool snapshot in MOMO's shape, so CATCH reads every migration the same way it reads MOMO's list. DexScreener
 *  gives transactions, not distinct wallets: buys and sells stand in for buyers and sellers (the model sees both). */
export function asHot(m: string, p: PoolSnap, createdAt?: number): Hot {
  return {
    mint: m,
    symbol: p.sym,
    name: p.sym,
    pool: p.pair,
    dex: p.dex || "pumpswap",
    ageMin: createdAt ? (Date.now() - createdAt) / 60_000 : p.created ? (Date.now() - p.created) / 60_000 : 0,
    mc: p.mc,
    liq: p.liq,
    v5: p.v5,
    v1h: p.v1h,
    b5: p.b5,
    s5: p.s5,
    buyers5: p.b5,
    sellers5: p.s5,
    ch5: p.ch5,
    ch1h: p.ch1h,
    ch6h: p.ch6h,
    score: 0,
    at: p.at,
  };
}
