// v0.1.97: the DAILY REVIEW. Every morning (06:50 UTC, 08:50 Amsterdam) the worker sends one Telegram message: what live
// money did in the last 24 hours, each strategy family's live record and bench, live vs paper, GRID LIVE's exam race
// and the runners, and the desk's health. The same numbers are public at /api/review (no secrets, no wallet keys).
// It reads and reports only: it changes nothing (the LIVE BENCH and the exams do that on their own).
import { redis, K } from "./redis";
import { pmView } from "./pm";

const DAY = 24 * 3600_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export async function reviewView(now = Date.now()) {
  const r = redis();
  const [trades, live, rpc] = await Promise.all([
    r.lrange<any>(K.deskTrades, 0, 499).catch(() => [] as any[]),
    r.get<any>("rn:gridlive:view").catch(() => null),
    r.get<any>("rn:rpc").catch(() => null),
  ]);
  const day = ((trades || []) as any[]).filter((t) => t && t.live && now - t.at < DAY);
  const sells = day.filter((t) => t.side === "sell");
  const buys = day.filter((t) => t.side === "buy");
  const pnl = sells.reduce((a, t) => a + (Number(t.pnlSol) || 0), 0);
  const won = sells.filter((t) => (Number(t.pnlSol) || 0) > 0).length;
  const gaps = sells.map((t) => t.par?.out).filter((x: any) => typeof x === "number") as number[];
  const toks = buys.map((t) => t.par?.tok).filter((x: any) => typeof x === "number") as number[];
  const avg = (a: number[]) => (a.length ? r1(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const fams = (await pmView().catch(() => [] as any[])) as any[];
  const books = ((live?.books || []) as any[]).map((b) => ({ label: String(b.label || b.key).slice(0, 90), key: b.key, trips: b.total ?? b.live?.n ?? 0, pnl: b.live?.totalPnl ?? b.live?.pnl ?? 0, won: b.live?.winRate ?? 0, passed: !!b.live?.passed, runner: !!b.live?.runner, lessTop2: b.live?.lessTop2 ?? null }));
  const close = books
    .filter((b) => !b.passed && b.trips >= 10 && b.pnl > 0)
    .sort((a, z) => z.pnl - a.pnl)
    .slice(0, 3);
  const runners = books.filter((b) => b.runner);
  return {
    at: now,
    // the worker's own counters, from its status record (the site never holds them in memory)
    live: { trades: day.length, roundTrips: sells.length, won, pnlSol: r4(pnl), sellGapPct: avg(gaps), buyTokGapPct: avg(toks), feeSol: rpc?.exec?.liveFee?.prioritySol ?? null, feeN: rpc?.exec?.liveFee?.n ?? 0, sender: { ok: 0, err: 0, http: 0, last: "", ...(rpc?.exec?.sender || {}) } },
    families: fams.map((f) => ({ family: f.sleeve, live: f.live, bench: f.bench?.why ?? null, ghostSinceBench: f.benchGhost, weight: f.w, pausedUntil: f.paused })),
    grid: { books: books.length, passed: books.filter((b) => b.passed).map((b) => b.label), leader: live?.follow?.label ?? null, closest: close, runners: { books: runners.length, inProfit: runners.filter((b) => b.pnl > 0).length, best: runners.sort((a, z) => z.pnl - a.pnl)[0] ?? null } },
    health: { chainUsed: rpc?.day?.used ?? null, chainPace: rpc?.day?.pace ?? null, chainBudget: rpc?.day?.budget ?? null, loopP99: rpc?.loop?.p99 ?? null },
  };
}

const esc = (s: string) => String(s).replace(/[<>&]/g, " ");
export function reviewText(v: Awaited<ReturnType<typeof reviewView>>) {
  const L = v.live;
  const sign = (n: number) => (n >= 0 ? "+" : "") + n;
  const fam = v.families
    .filter((f) => f.live?.trips || f.bench)
    .map((f) => `• ${f.family}: ${f.live.trips} live trips, ${f.live.winRate}% won, ${sign(f.live.avg)}% a trip${f.live.sellGap != null ? `, sells ${sign(f.live.sellGap)}% vs paper` : ""}${f.bench ? `\n  BENCHED: ${esc(f.bench)} (${f.ghostSinceBench ?? 0}/20 ghost trips to come back)` : ""}`)
    .join("\n");
  const g = v.grid;
  return [
    `📋 <b>RATNET daily review</b> (${new Date(v.at).toISOString().slice(0, 10)})`,
    "",
    `<b>Live money, last 24h</b>: ${L.roundTrips} sells, ${L.won} won, ${sign(L.pnlSol)} SOL`,
    `Live vs paper: sells ${L.sellGapPct == null ? "n/a" : sign(L.sellGapPct) + "%"}, buys ${L.buyTokGapPct == null ? "n/a" : sign(L.buyTokGapPct) + "%"} tokens. Fee per tx ${L.feeSol != null ? `${L.feeSol} SOL (median of ${L.feeN} live txs)` : `the setting (${L.feeN} of 10 live txs recorded)`}. Sender ${L.sender.ok} ok / ${L.sender.err + L.sender.http} refused${L.sender.last ? ` (${esc(L.sender.last).slice(0, 60)})` : ""}`,
    "",
    `<b>Strategy families on live money</b>`,
    fam || "• no live trips on record yet",
    "",
    `<b>GRID LIVE</b>: ${g.books} books, ${g.passed.length} passed${g.leader ? `, desk follows "${esc(g.leader)}"` : ", nothing to follow yet"}`,
    ...g.closest.map((b) => `• close: ${esc(b.label)} (${b.trips} trips, ${sign(r4(b.pnl))} SOL, ${b.won}% won)`),
    `Runners: ${g.runners.books} books, ${g.runners.inProfit} in profit${g.runners.best ? `; best ${esc(g.runners.best.label)} ${sign(r4(g.runners.best.pnl))} SOL over ${g.runners.best.trips}` : ""}`,
    "",
    `<b>Health</b>: chain ${v.health.chainUsed != null ? `${Math.round(v.health.chainUsed / 1000)}K of ${Math.round((v.health.chainBudget || 0) / 1000)}K (pace ${Math.round((v.health.chainPace || 0) / 1000)}K)` : "n/a"}, event loop p99 ${v.health.loopP99 != null ? `${v.health.loopP99}ms` : "n/a"}`,
  ].join("\n");
}

/** Once a day at 06:50 UTC (worker, checked every 10 minutes). */
export async function dailyReview(send: (t: string) => Promise<unknown>, now = Date.now()) {
  const d = new Date(now);
  if (d.getUTCHours() * 60 + d.getUTCMinutes() < 6 * 60 + 50) return { wait: true };
  const day = d.toISOString().slice(0, 10);
  if (!(await redis().set(`rn:review:${day}`, now, { nx: true, ex: 3 * 86400 }))) return { sent: "already today" };
  const v = await reviewView(now);
  await redis().set("rn:review:last", v, { ex: 3 * 86400 }).catch(() => null);
  await send(reviewText(v));
  return { sent: day };
}
