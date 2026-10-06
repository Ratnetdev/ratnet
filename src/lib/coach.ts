// COACH follow-ups. Every closed trade is checked again 5 minutes, 15 minutes, 1 hour, 2 hours, 6 hours, 1 day and
// 7 days after the exit: where is the coin now vs our exit, and if it ran, what was behind it (migration, a big buy,
// a volume wave, paid DexScreener promotion, X posts). The tallies tell the desk how often it sells too early and why,
// and every check is written to the trade so anyone can see it.
import { redis } from "./redis";
import { getCurves } from "./solana";
import { readPools } from "./pool";
import { getMarket } from "./market";
import { readTape } from "./tape";
import { xMentions } from "./buzz";

export const HORIZONS = [
  { k: "5m", ms: 5 * 60_000 },
  { k: "15m", ms: 15 * 60_000 },
  { k: "1h", ms: 3600_000 },
  { k: "2h", ms: 2 * 3600_000 },
  { k: "6h", ms: 6 * 3600_000 },
  { k: "1d", ms: 86400_000 },
  { k: "7d", ms: 7 * 86400_000 },
] as const;

const DUE = "rn:coach:due"; // zset: "<tripId>|<horizon>" scored by when it is due
const TRIP = (id: string) => `rn:coach:t:${id}`; // the trade and its follow-ups (9 days)
const STAT = "rn:coach:stat"; // per horizon: n, sum of log return vs exit, 2x+, -50% ; per reason: count
const TTL = 9 * 86400;

export type Check = { k: string; at: number; px: number; vsExit: number; vsEntry: number; mc: number | null; why: string[] };
export type Follow = { id: string; mint: string; symbol: string; creator?: string; createdAt?: number; closedAt: number; entryPx: number; exitPx: number; exitGrad: boolean; reason: string; checks: Check[] };

export const tripId = (mint: string, openedAt: number) => `${mint}:${openedAt}`;

/** Start following a trade the moment it closes. */
export async function follow(f: Omit<Follow, "checks">) {
  const r = redis();
  const p = r.pipeline();
  p.set(TRIP(f.id), { ...f, checks: [] }, { ex: TTL });
  for (const h of HORIZONS) p.zadd(DUE, { score: f.closedAt + h.ms, member: `${f.id}|${h.k}` });
  await p.exec();
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b - 1) * 1000) / 10 : 0);

/** Run due follow-ups (up to `max` per call). Returns log lines for the desk feed. */
export async function coachStep(solUsd: number | null, max = 8) {
  const r = redis();
  const now = Date.now();
  const due = ((await r.zrange<string[]>(DUE, 0, now, { byScore: true, offset: 0, count: max })) || []).map(String);
  if (!due.length) return [] as { text: string; tone: string; mint: string; symbol: string }[];
  await r.zrem(DUE, ...due);
  const ids = Array.from(new Set(due.map((d) => d.split("|")[0])));
  const recs = ((await r.mget<(Follow | null)[]>(...ids.map(TRIP))) || []) as (Follow | null)[];
  const byId: Record<string, Follow> = {};
  ids.forEach((id, i) => recs[i] && (byId[id] = recs[i]!));
  const mints = Array.from(new Set(Object.values(byId).map((f) => f.mint)));
  const [curves, pools, mkt] = await Promise.all([
    getCurves(mints).catch(() => ({} as Awaited<ReturnType<typeof getCurves>>)),
    readPools(mints).catch(() => ({} as Awaited<ReturnType<typeof readPools>>)),
    getMarket(mints).catch(() => ({} as Awaited<ReturnType<typeof getMarket>>)),
  ]);
  const out: { text: string; tone: string; mint: string; symbol: string }[] = [];
  const p = r.pipeline();
  let tapes = 0;
  for (const d of due) {
    const [id, k] = d.split("|");
    const f = byId[id];
    if (!f) continue;
    const cv = curves[f.mint];
    const pool = pools[f.mint];
    const onCurve = !!cv && !cv.complete && cv.priceSol > 0;
    const px = onCurve ? cv!.priceSol : pool?.px || 0;
    // no price at all: curve full but never migrated, or nothing left to read. counts as gone (-100%)
    const vsExit = px ? pct(px, f.exitPx) : -100;
    const vsEntry = px ? pct(px, f.entryPx) : -100;
    const m = mkt[f.mint];
    // what is behind a move: only looked for when the coin ran 50%+ past our exit
    const why: string[] = [];
    if (vsExit >= 50) {
      if (!onCurve && pool && !f.exitGrad) why.push("migrated after we sold");
      if (m) {
        const tot = m.b1 + m.s1;
        if (tot >= 20 && m.b1 / tot >= 0.6) why.push(`buyers in control: ${m.b1} buys vs ${m.s1} sells in the last hour`);
        if (m.v1 >= 50_000) why.push(`volume wave: $${Math.round(m.v1 / 1000)}K in the last hour`);
        if (m.bo) why.push(`${m.bo} paid DexScreener boost${m.bo > 1 ? "s" : ""}`);
        if (m.pf) why.push("paid DexScreener profile");
      }
      const xm = await xMentions(f.mint).catch(() => null);
      if (xm != null && xm >= 3) why.push(`${xm} X posts in 15 minutes`);
      if (onCurve && tapes < 2 && f.creator && f.createdAt) {
        tapes++;
        const t = await readTape(f.mint, f.creator, f.createdAt, { early: 4, recent: 20 }).catch(() => null);
        if (t?.maxBuy && t.maxBuy >= 3 && (t.maxBuyAt ?? 0) > f.closedAt) why.push(`a ${t.maxBuy} SOL buy in one go`);
        if (t && t.buyShare >= 0.7) why.push(`${Math.round(t.buyShare * 100)}% of recent curve trades are buys`);
      }
      if (!why.length) why.push("no clear trigger found");
    }
    const mc = solUsd && px ? Math.round(px * 1e9 * solUsd) : null;
    f.checks = [...(f.checks || []).filter((c) => c.k !== k), { k, at: now, px, vsExit, vsEntry, mc, why }];
    p.set(TRIP(id), f, { keepTtl: true });
    p.hincrby(STAT, `${k}:n`, 1);
    p.hincrbyfloat(STAT, `${k}:sum`, Math.log(Math.max(0.01, px / f.exitPx)));
    if (vsExit >= 100) p.hincrby(STAT, `${k}:up2`, 1);
    if (vsExit <= -50) p.hincrby(STAT, `${k}:dn50`, 1);
    if (!px) p.hincrby(STAT, `${k}:dead`, 1);
    for (const w of why) if (w !== "no clear trigger found") p.hincrby(STAT, `why:${w.replace(/[0-9$.,]+/g, "#").replace(/\s+/g, " ").trim()}`, 1);
    const big = vsExit >= 100 || vsExit <= -50 || k === "1h" || k === "1d";
    if (big || vsExit >= 50)
      out.push({
        mint: f.mint,
        symbol: f.symbol,
        tone: vsExit >= 50 ? "bad" : "ok",
        text: `$${f.symbol} ${k} after the exit: ${vsExit >= 0 ? "+" : ""}${vsExit}% vs our sell (${vsEntry >= 0 ? "+" : ""}${vsEntry}% vs entry)${why.length ? `. ${why.join(", ")}` : ""}`,
      });
  }
  await p.exec();
  return out;
}

/** Follow-ups for a set of trades, for the track record. */
export async function followsFor(ids: string[]): Promise<Record<string, Check[]>> {
  if (!ids.length) return {};
  const recs = ((await redis().mget<(Follow | null)[]>(...ids.map(TRIP))) || []) as (Follow | null)[];
  const out: Record<string, Check[]> = {};
  ids.forEach((id, i) => recs[i] && (out[id] = recs[i]!.checks || []));
  return out;
}

/** What happens after the desk sells, per horizon, and the most common reasons behind late runs. */
export async function coachStats() {
  const s = ((await redis().hgetall<Record<string, number>>(STAT)) || {}) as Record<string, number>;
  const n = (k: string) => Number(s[k] || 0);
  const pending = (await redis().zcard(DUE)) || 0;
  return {
    pending,
    horizons: HORIZONS.map((h) => {
      const c = n(`${h.k}:n`);
      return { k: h.k, n: c, avg: c ? Math.round((Math.exp(n(`${h.k}:sum`) / c) - 1) * 1000) / 10 : null, up2: n(`${h.k}:up2`), dn50: n(`${h.k}:dn50`) };
    }),
    reasons: Object.entries(s)
      .filter(([k]) => k.startsWith("why:"))
      .map(([k, v]) => ({ why: k.slice(4), n: Number(v) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 6),
  };
}
