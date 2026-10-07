// MOMO: the runners after migration. The King calls coins at minute 5 on the curve; the biggest money in the trenches
// is often made later, on coins that already migrated and are pulling real volume: $100K, $500K, $1M of volume in
// minutes. MOMO watches exactly that, every minute, from GeckoTerminal (trending Solana pools plus the PumpSwap pools
// with the most volume), and hands the desk the coins with real traction:
//   volume in the last 5 minutes and the last hour, many different buyers, more buyers than sellers,
//   enough liquidity to get in and out, young enough to still be a story, and not already in free fall.
// These lines are starting hints in the desk config (momo*), not laws: every MOMO coin the desk skips is followed by
// FILM, MOMO trades run in their own PM sleeve, and their exits are tuned from their own record.
import { redis } from "./redis";
import { agentLog } from "./agents";
import { K } from "./redis";
import { getSettings } from "./settings";
import { enqueueMind } from "./mind";
import { enqueueLens } from "./lens";

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
const VIEW = "rn:momo:view";
const COOL = (m: string) => `rn:momo:cool:${m}`;
export const MOMO_D = (m: string) => `rn:momo:d:${m}`; // the numbers behind a MOMO signal (desk reads them)
const AT = "rn:momo:at";

export type Hot = {
  mint: string;
  symbol: string;
  name: string;
  pool: string;
  dex: string;
  ageMin: number;
  mc: number;
  liq: number;
  v5: number;
  v1h: number;
  b5: number; // buys in 5m
  s5: number;
  buyers5: number;
  sellers5: number;
  ch5: number;
  ch1h: number;
  ch6h: number;
  score: number;
  at: number;
  why?: string;
  pass?: boolean;
};

async function gt(path: string) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${GT}${path}`, { headers: { accept: "application/json" }, signal: ctl.signal, cache: "no-store" });
    if (!r.ok) return [];
    const j: any = await r.json().catch(() => null);
    return Array.isArray(j?.data) ? j.data : [];
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

const n = (x: any) => Number(x || 0);

function toHot(p: any): Hot | null {
  const a = p?.attributes;
  const base = p?.relationships?.base_token?.data?.id || "";
  const mint = base.replace(/^solana_/, "");
  const dex = p?.relationships?.dex?.data?.id || "";
  if (!a || !mint) return null;
  const tx5 = a.transactions?.m5 || {};
  const age = a.pool_created_at ? (Date.now() - Date.parse(a.pool_created_at)) / 60_000 : 9e9;
  return {
    mint,
    symbol: String(a.name || "").split(" / ")[0].slice(0, 16),
    name: String(a.name || ""),
    pool: a.address,
    dex,
    ageMin: Math.round(age),
    mc: Math.round(n(a.market_cap_usd) || n(a.fdv_usd)),
    liq: Math.round(n(a.reserve_in_usd)),
    v5: Math.round(n(a.volume_usd?.m5)),
    v1h: Math.round(n(a.volume_usd?.h1)),
    b5: n(tx5.buys),
    s5: n(tx5.sells),
    buyers5: n(tx5.buyers),
    sellers5: n(tx5.sellers),
    ch5: n(a.price_change_percentage?.m5),
    ch1h: n(a.price_change_percentage?.h1),
    ch6h: n(a.price_change_percentage?.h6),
    score: 0,
    at: Date.now(),
  };
}

/** Does a hot pool have the traction MOMO looks for? Returns the reason it fails, or null. */
export function momoCheck(h: Hot, c: Record<string, any>) {
  if (!/pump/i.test(h.dex) && !h.mint.endsWith("pump")) return "not a pump.fun coin";
  if (h.ageMin > (c.momoMaxAgeH ?? 24) * 60) return `${Math.round(h.ageMin / 60)}h old`;
  if (h.v5 < (c.momoMinVol5m ?? 25_000)) return `$${Math.round(h.v5 / 1000)}K volume in 5m`;
  if (h.v1h < (c.momoMinVol1h ?? 100_000)) return `$${Math.round(h.v1h / 1000)}K volume in 1h`;
  if (h.liq < (c.momoMinLiq ?? 20_000)) return `$${Math.round(h.liq / 1000)}K liquidity`;
  if (h.buyers5 < (c.momoMinBuyers5m ?? 40)) return `${h.buyers5} buyers in 5m`;
  if (h.buyers5 < h.sellers5 * (c.momoMinBuyRatio ?? 1.05)) return `${h.buyers5} buyers vs ${h.sellers5} sellers`;
  if (h.ch5 > (c.momoMaxCh5 ?? 60)) return `already +${Math.round(h.ch5)}% in 5m (chasing)`;
  if (h.ch5 < -12 || h.ch1h < -25) return `falling (${Math.round(h.ch5)}% 5m, ${Math.round(h.ch1h)}% 1h)`;
  if (h.mc > (c.momoMaxMc ?? 30_000_000)) return `$${Math.round(h.mc / 1e6)}M market cap`;
  return null;
}

/** Scan once a minute: trending pools (5m and 1h) plus PumpSwap's biggest pools. */
export async function momoScan() {
  const r = redis();
  if (Date.now() - Number((await r.get(AT)) || 0) < 55_000) return { momo: "not due" };
  await r.set(AT, Date.now());
  const s = await getSettings();
  const c = s.desk as any;
  if (c.momoMode === "off") return { momo: "off" };
  const lists = await Promise.all([
    gt("/trending_pools?duration=5m&page=1"),
    gt("/trending_pools?duration=1h&page=1"),
    gt("/dexes/pumpswap/pools?sort=h24_volume_usd_desc&page=1"),
    gt("/dexes/pumpswap/pools?sort=h24_tx_count_desc&page=1"),
  ]);
  const by = new Map<string, Hot>();
  for (const p of lists.flat()) {
    const h = toHot(p);
    if (!h || h.mint.startsWith("So1111")) continue;
    const cur = by.get(h.mint);
    if (!cur || h.liq > cur.liq) by.set(h.mint, h);
  }
  const all = [...by.values()];
  for (const h of all) {
    // traction score: volume now, breadth of buyers, buy pressure; a hint for ordering, not a gate
    h.score = Math.round((Math.log10(1 + h.v5) * 2 + Math.log10(1 + h.v1h) + Math.log10(1 + h.buyers5) * 1.5 + Math.min(2, h.buyers5 / Math.max(1, h.sellers5))) * 10) / 10;
    const why = momoCheck(h, c);
    h.pass = !why;
    h.why = why || "traction";
  }
  all.sort((a, b) => Number(b.pass) - Number(a.pass) || b.score - a.score);
  await r.set(VIEW, { at: Date.now(), hot: all.filter((h) => /pump/i.test(h.dex) || h.mint.endsWith("pump")).slice(0, 25) }, { ex: 600 });
  const sent: Hot[] = [];
  for (const h of all.filter((x) => x.pass).slice(0, 4)) {
    if (!(await r.set(COOL(h.mint), 1, { nx: true, ex: (c.momoCooldownMin ?? 45) * 60 }))) continue;
    await r.set(MOMO_D(h.mint), h, { ex: 3600 });
    const p = r.pipeline();
    p.zadd(K.deskQ, { score: Date.now(), member: `r:${h.mint}` });
    enqueueLens(p, h.mint, "wire");
    enqueueMind(p, h.mint, "momo");
    agentLog(p, [{ agent: "MOMO", at: Date.now(), mint: h.mint, symbol: h.symbol, text: `$${h.symbol} has traction: $${Math.round(h.v5 / 1000)}K volume in 5m, $${Math.round(h.v1h / 1000)}K in 1h, ${h.buyers5} buyers vs ${h.sellers5} sellers, ${h.ch5 > 0 ? "+" : ""}${Math.round(h.ch5)}% 5m, mc $${Math.round(h.mc / 1000)}K, ${h.ageMin < 120 ? `${h.ageMin}m` : `${Math.round(h.ageMin / 60)}h`} old. sent to the desk`, tone: "ok", stance: 0.9 }]);
    await p.exec();
    sent.push(h);
  }
  return { momo: `${all.length} pools, ${all.filter((x) => x.pass).length} with traction, ${sent.length} sent` };
}

export async function momoView() {
  return (await redis().get<{ at: number; hot: Hot[] }>(VIEW)) || null;
}

export async function momoSignal(mint: string) {
  return (await redis().get<Hot>(MOMO_D(mint))) || null;
}
