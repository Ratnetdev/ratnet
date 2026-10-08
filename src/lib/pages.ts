// v0.1.41: the three heaviest public answers, built by the worker and stored as one compressed key each
// (lib/site.ts). Every server instance used to build them itself from the raw data, every few seconds:
//  - /api/live   (stats, feed, calls, radar, graduations: polled by every open page)
//  - /api/coins  (the explorer: a whole day of calls)
//  - /api/desk   (the desk page and /status)
// A page builds its own answer only when the worker's copy is missing or old (the worker is down).
import { venueTemplates } from "./venues";
import { getBondCalls, getCalls, getFeed, getGrads, getRadar, getStats } from "./stats";
import { getSettings } from "./settings";
import { K, redis } from "./redis";
import { solUsd } from "./solana";
import type { IdxRow } from "./digger";

export async function buildLive() {
  const [stats, feed, calls, s, burns, radar, grads, desk, exam, bondCalls, ev] = await Promise.all([
    getStats(),
    getFeed(40),
    getCalls(12),
    getSettings(),
    redis().lrange(K.burns, 0, 9),
    getRadar(10),
    getGrads(8),
    redis().get<{ equity: number; start: number; live: boolean; liveStart: number | null; dayStart: number }>(K.deskState),
    redis().get(K.deskExam),
    getBondCalls(8).catch(() => []),
    redis().lrange<any>(K.deskEv, 0, 19).catch(() => []),
  ]);
  const sol = await solUsd().catch(() => null);
  // the agents' headline moments for the live toasts on every page: trades, sends, MOMO and MIND calls
  const HEAD = new Set(["EXEC", "RISK", "KING", "MOMO", "MIND", "WIRE", "LEDGER", "HOUND", "PM", "CATCH", "SHIELD", "FLASH"]);
  const agents = ((ev || []) as any[]).filter((e) => e && HEAD.has(e.agent) && (e.tone === "ok" || e.tone === "win" || e.tone === "loss")).slice(0, 12).map((e) => ({ agent: e.agent, at: e.at, mint: e.mint || "", symbol: e.symbol || "", text: String(e.text || "").slice(0, 160), tone: e.tone }));
  return { stats, feed, agents, calls, bondCalls, burns, radar, grads, desk: desk ? { eq: desk.equity, base: desk.live ? desk.liveStart ?? desk.start : desk.start, live: desk.live, day: desk.dayStart, exam: exam || null } : null, live: { mint: s.mint, links: s.links, litter: s.litter, venues: venueTemplates(s) }, sol, now: Date.now() };
}

type Row = IdxRow & { cur: number | null; pk: number | null };
const PK = new Map<string, [number | null, number | null]>();

/**
 * The explorer: every coin the King or nano liked in the last 24h, plus every bonded coin. In the worker the index
 * comes from memory (lib/digger idxRows); the curve numbers from the hot set (a few hundred coins), and coins that
 * left it keep their last numbers.
 */
export async function buildCoins() {
  const r = redis();
  const { idxRows } = await import("./digger");
  const rows = (await idxRows()).sort((a, b) => b.t - a.t);
  const flat = ((await r.zrange<(string | number)[]>(K.radar, 0, -1, { withScores: true })) || []) as (string | number)[];
  const cur = new Map<string, number>();
  for (let i = 0; i < flat.length; i += 2) cur.set(String(flat[i]), Number(flat[i + 1]));
  const pendingHot = rows.filter((x) => !x.o && cur.has(x.m)).map((x) => x.m);
  const pks = pendingHot.length ? ((await r.zmscore(K.peak, pendingHot)) || []) : [];
  pendingHot.forEach((m, i) => PK.set(m, [cur.get(m) ?? null, pks[i] != null ? Number(pks[i]) : null]));
  const keep = new Set(rows.map((x) => x.m));
  for (const m of Array.from(PK.keys())) if (!keep.has(m)) PK.delete(m);
  const out: Row[] = rows.map((x) => ({ ...x, cur: x.o === "B" ? 100 : PK.get(x.m)?.[0] ?? null, pk: x.o === "B" ? 100 : PK.get(x.m)?.[1] ?? null }));
  return { rows: out, now: Date.now() };
}
