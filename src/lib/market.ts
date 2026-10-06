import { redis } from "./redis";

// Market cap, volume and flow from DexScreener (free, covers pump.fun curves and PumpSwap pools).
// Cached per coin for 30s in Redis so every viewer shares one lookup.

export type Mkt = {
  mc: number | null; // market cap USD
  v5: number; // volume USD last 5m
  v1: number; // last 1h
  v24: number; // last 24h
  c5: number | null; // price change % 5m
  c1: number | null; // 1h
  liq: number | null; // liquidity USD
  b1: number; // buys last 1h
  s1: number; // sells last 1h
  dex: string;
  url: string;
  pn: number | null; // price in SOL per token (SOL-quoted pairs)
  bo: number; // active DexScreener boosts (paid)
  pf: boolean; // DexScreener profile set (paid)
};

const KEY = (m: string) => `rn:mkt:${m}`;
const TTL = 30;

function pick(pairs: any[]): Mkt | null {
  if (!pairs?.length) return null;
  const best = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) + (b.volume?.h24 ?? 0) - ((a.liquidity?.usd ?? 0) + (a.volume?.h24 ?? 0)))[0];
  const vol = (k: string) => pairs.reduce((s, p) => s + Number(p.volume?.[k] ?? 0), 0);
  const tx = (k: string, side: "buys" | "sells") => pairs.reduce((s, p) => s + Number(p.txns?.[k]?.[side] ?? 0), 0);
  const num = (v: any) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    mc: num(best.marketCap ?? best.fdv),
    v5: Math.round(vol("m5")),
    v1: Math.round(vol("h1")),
    v24: Math.round(vol("h24")),
    c5: num(best.priceChange?.m5),
    c1: num(best.priceChange?.h1),
    liq: num(best.liquidity?.usd),
    b1: tx("h1", "buys"),
    s1: tx("h1", "sells"),
    dex: String(best.dexId || ""),
    url: String(best.url || ""),
    bo: Number(best.boosts?.active ?? 0),
    pf: !!(best.info && (best.info.imageUrl || (best.info.socials || []).length || (best.info.websites || []).length)),
    pn: best.quoteToken?.symbol === "SOL" || best.quoteToken?.address === "So11111111111111111111111111111111111111112" ? num(best.priceNative) : null,
  };
}

export async function getMarket(mints: string[]): Promise<Record<string, Mkt | null>> {
  const uniq = Array.from(new Set(mints.filter(Boolean))).slice(0, 120);
  const out: Record<string, Mkt | null> = {};
  if (!uniq.length) return out;
  const r = redis();
  const cached = await r.mget<(Mkt | { none: true } | null)[]>(...uniq.map(KEY));
  const missing: string[] = [];
  uniq.forEach((m, i) => {
    const c = cached[i];
    if (c == null) missing.push(m);
    else out[m] = "none" in c ? null : (c as Mkt);
  });
  for (let i = 0; i < missing.length; i += 30) {
    const chunk = missing.slice(i, i + 30);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3500);
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
      const arr: any[] = res.ok ? await res.json() : [];
      const by: Record<string, any[]> = {};
      for (const p of Array.isArray(arr) ? arr : []) {
        const m = p?.baseToken?.address;
        if (m) (by[m] ||= []).push(p);
      }
      const p = r.pipeline();
      for (const m of chunk) {
        const v = pick(by[m] || []);
        out[m] = v;
        p.set(KEY(m), v ?? { none: true }, { ex: v ? TTL : 60 });
      }
      await p.exec();
    } catch {
      for (const m of chunk) out[m] = null;
    }
  }
  return out;
}

export function usd(n: number | null | undefined) {
  if (n == null) return "–";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}
