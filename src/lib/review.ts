// v0.1.97: the DAILY REVIEW. Every morning (06:50 UTC, 08:50 Amsterdam) the worker sends one Telegram message: what live
// money did in the last 24 hours, each strategy family's live record and bench, live vs paper, GRID LIVE's exam race
// and the runners, and the desk's health. The same numbers are public at /api/review (no secrets, no wallet keys).
// It reads and reports only: it changes nothing (the LIVE BENCH and the exams do that on their own).
import { chooseVariants, flowxStats, learnTable, variantText } from "./flowx";
import { redis, K } from "./redis";
import { pmView } from "./pm";

const DAY = 24 * 3600_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export async function reviewView(now = Date.now()) {
  const r = redis();
  // v0.1.138 FILL LEDGER
  const fillsum = await (async () => {
    const { FILLS_LOG } = await import("./desk");
    const { fillSummary } = await import("./proof");
    return fillSummary(((await r.lrange<any>(FILLS_LOG, 0, 499).catch(() => [])) || []) as any);
  })().catch(() => null);
  const [trades, live, rpc, seer, seerHits, flowx, xposts, gv, ge, ge60, ge180, ge300, tv, tk, rug, lad, sm] = await Promise.all([
    r.lrange<any>(K.deskTrades, 0, 499).catch(() => [] as any[]),
    r.get<any>("rn:gridlive:view").catch(() => null),
    r.get<any>("rn:rpc").catch(() => null),
    r.get<any>("rn:seer:view").catch(() => null),
    r.lrange<any>("rn:seer:matches", 0, 49).catch(() => [] as any[]),
    r.lrange<any>("rn:gridlive:flowx", 0, 1999).catch(() => [] as any[]),
    r.lrange<any>("rn:x:tw", 0, 199).catch(() => [] as any[]),
    r.get<any>("rn:grid:view").catch(() => null),
    r.get<any>("rn:grid:early").catch(() => null),
    r.get<any>("rn:grid:early:60").catch(() => null),
    r.get<any>("rn:grid:early:180").catch(() => null),
    r.get<any>("rn:grid:early:300").catch(() => null),
    r.get<any>("rn:trend:view").catch(() => null),
    r.get<any>("rn:tick:view").catch(() => null),
    r.get<any>("rn:rug:view").catch(() => null),
    r.get<any>("rn:ladder:view").catch(() => null),
    r.get<any>("rn:smart:view").catch(() => null),
  ]);
  // v0.1.107: the media read on WIRE's latest posts (posts from before this build carry none)
  const xs = ((xposts || []) as any[]).filter((t) => t && t.md !== undefined);
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
    // v0.1.123: per trade, how far live landed from paper (+ = live better). Sells: SOL out; buys: tokens in
    liveGaps: day.filter((t) => t.par && (typeof t.par.out === "number" || typeof t.par.tok === "number")).slice(0, 12).map((t) => `${t.side} ${String(t.symbol || "").slice(0, 12)} ${t.par.out ?? t.par.tok}%`),
    live: { trades: day.length, roundTrips: sells.length, won, pnlSol: r4(pnl), sellGapPct: avg(gaps), buyTokGapPct: avg(toks), feeSol: rpc?.exec?.liveFee?.prioritySol ?? null, feeN: rpc?.exec?.liveFee?.n ?? 0, sender: { ok: 0, err: 0, http: 0, last: "", ...(rpc?.exec?.sender || {}) } },
    families: fams.map((f) => ({ family: f.sleeve, live: f.live, bench: f.bench?.why ?? null, ghostSinceBench: f.benchGhost, weight: f.w, pausedUntil: f.paused })),
    grid: { books: books.length, passed: books.filter((b) => b.passed).map((b) => b.label), leader: live?.follow?.label ?? null, closest: close, runners: { books: runners.length, inProfit: runners.filter((b) => b.pnl > 0).length, best: runners.sort((a, z) => z.pnl - a.pnl)[0] ?? null } },
    // v0.1.102: what SEER is watching for, and which launches matched it in the last day
    seer: {
      at: seer?.at ?? null,
      armed: seer?.stats?.armed ?? (seer?.armed?.length || 0),
      runs: seer?.stats?.runs ?? 0,
      error: seer?.stats?.lastErr || null,
      top: ((seer?.armed || []) as any[]).filter((a) => a.tier === 1).slice(0, 5).map((a) => ({ title: String(a.title).slice(0, 90), names: a.names, tickers: a.tickers, at: a.at })),
      matches: ((seerHits || []) as any[]).filter((m) => m && now - (m.at0 || 0) < DAY).slice(0, 10).map((m) => ({ mint: m.mint, sym: m.sym, title: String(m.title).slice(0, 90), tier: m.tier, rank: m.rank, by: m.by, on: m.on ?? null })),
    },
    // v0.1.105: GRID LIVE trips where the flow turned (early buyers or a KOL selling): actual result vs selling then
    xMedia: { posts: xs.length, photo: xs.filter((t) => t.md === "photo").length, video: xs.filter((t) => t.md === "video").length },
    flowExit: flowxStats(((flowx || []) as any[]).filter(Boolean)),
    // v0.1.108: the FLOW EXIT learner (every variant on the same trips) and what the twin books run now
    flowLearn: (() => {
      const table = learnTable(((flowx || []) as any[]).filter(Boolean));
      const ch = chooseVariants(table);
      return { learned: ch.learned, picks: ch.picks.map((v) => ({ v, text: variantText(v) })), top: table.slice(0, 5) };
    })(),
    // v0.1.112: GRID SCORE (judged on the newer calls), the NULL RUN's luck bar, and passes on the old bar vs every check
    gridChecks: {
      passed: gv?.passed ?? null,
      passedBasic: gv?.passedBasic ?? null,
      score: gv?.score ? { used: gv.score.used, effN: gv.score.effN, auc: gv.score.test?.auc ?? null, base: gv.score.test?.base ?? null, top10: gv.score.test?.top10 ?? null, top20: gv.score.test?.top20 ?? null, why: gv.score.why || "" } : null,
      nullRun: gv?.nullRun ?? null,
      wscore: gv?.wscore ? { avgPct: gv.wscore.test?.avgPct ?? null, edge: gv.wscore.test?.edge ?? null, top10: gv.wscore.test?.top10 ?? null, top20: gv.wscore.test?.top20 ?? null, why: gv.wscore.why || "" } : null,
      // v0.1.115: the EARLY search (every launch read at 2 minutes)
      early: ge ? { coins: ge.coins ?? 0, why: ge.why || ge.error || "", passed: ge.passed ?? null, passedBasic: ge.passedBasic ?? null, bar: ge.nullRun?.bar ?? null, lucky: ge.nullRun ? `${ge.nullRun.lucky}/${ge.nullRun.kept}` : null, avgPct: ge.wscore?.test?.avgPct ?? null, winEdge: ge.wscore?.test?.edge ?? null, winTop20: ge.wscore?.test?.top20?.avgPct ?? null, best: (ge.rows || [])[0] ? { key: ge.rows[0].key, testN: ge.rows[0].test.n, testAvg: ge.rows[0].test.avgPct } : null } : null,
      // v0.1.117: the other reading ages
      earlyAges: ([[60, ge60], [180, ge180], [300, ge300]] as [number, any][]).map(([sec, x]) => ({ sec, coins: x?.coins ?? 0, why: x?.why || x?.error || (x ? "" : "no search yet"), passed: x?.passed ?? null, avgPct: x?.wscore?.test?.avgPct ?? null, best: (x?.rows || [])[0] ? { key: x.rows[0].key, testN: x.rows[0].test.n, testAvg: x.rows[0].test.avgPct } : null })),
      pscore: gv?.pscore ? { auc: gv.pscore.test?.auc ?? null, base: gv.pscore.test?.base ?? null, avgPct: gv.pscore.test?.avgPct ?? null, top10: gv.pscore.test?.top10 ?? null, top20: gv.pscore.test?.top20 ?? null, why: gv.pscore.why || "" } : null,
    },
    // v0.1.126 RUG GUARD: the entry rules the desk applies live, and each rule's record on the paper trips
    rug: rug ? { trips: rug.trips, rugs: rug.rugs, live: rug.live, rows: (rug.rows || []).map((x: any) => ({ id: x.id, verdict: x.verdict, skipN: x.test?.n ?? 0, skipPnl: x.test?.pnl ?? 0, skipRug: x.skipRug, keptRug: x.keptRug })) } : null,
    // v0.1.127 TP LADDER: each take-profit ladder run as a shadow on every paper trip (gross % a trip, before costs)
    bags: live?.bags ?? null, // v0.1.137
    fills: fillsum, // v0.1.138
    ladder: lad ? { at: lad.at, desk: lad.desk, lead: lad.lead, all: lad.all, low: lad.low, rest: lad.rest, leader: lad.leader } : null,
    // v0.1.128 FOMO TAP, EARNERS, CREWS
    smart: sm ? { at: sm.at, fomo: { known: sm.fomo?.known ?? 0, wallets: sm.fomo?.wallets ?? 0, print: sm.fomo?.print ?? [], printBy: sm.fomo?.printBy ?? null, knownTx: sm.fomo?.knownTx ?? 0, fomoTrades: sm.fomo?.fomoTrades ?? 0, learned: sm.fomo?.learned ?? 0, candidates: (sm.fomo?.candidates || []).slice(0, 3) }, hot: (sm.hot || []).slice(0, 5), earners: { wallets: sm.earners?.wallets ?? 0, recorded: sm.earners?.recorded ?? 0, earners: sm.earners?.earners ?? 0, trips: sm.earners?.trips ?? 0, top: (sm.earners?.top || []).slice(0, 3) }, crews: sm.crews ?? null, buys: sm.buys ?? null, gate: sm.gate ?? null, bots: sm.earners?.bots ?? 0, front: sm.front ?? null, stories: sm.stories ?? null, fomoRegime: sm.fomoRegime ?? null, smartLive: sm.smartLive ?? null, realGap: sm.realGap ?? null } : null,
    // v0.1.120 TICK MODEL
    tick: tk ? { models: (tk.models || []).map((m: any) => ({ h: m.h, n: m.n, ready: m.ready, ic: m.ic, act: m.act, top: (m.top || []).slice(0, 4) })), warm: tk.warm, coins: tk.stats?.coins ?? 0 } : null,
    // v0.1.119 TREND: TikTok and Instagram
    trend: tv ? { at: tv.at, items: tv.stats?.items ?? 0, terms: tv.stats?.terms ?? 0, rising: (tv.terms || []).filter((t: any) => t.rising).slice(0, 8).map((t: any) => `${t.t} (${t.src.join("+")}, ${Math.round(t.views / 1000)}K views)`), err: tv.stats?.lastErr || "", src: tv.stats?.src || {} } : null,
    attention: rpc?.dx ?? null,
    theme: rpc?.theme ?? null, // v0.1.109: Claude's labels (asked, made, capped, queue) // v0.1.104: DexScreener reads (live polls, order histories fetched, live read vs truth)
    origin: rpc?.origin ?? null, // v0.1.103: the 7-day name/ticker/image index (rows read at boot, live size)
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
    `Live vs paper: sells ${L.sellGapPct == null ? "n/a" : sign(L.sellGapPct) + "%"}, buys ${L.buyTokGapPct == null ? "n/a" : sign(L.buyTokGapPct) + "%"} tokens. Fee per tx ${L.feeSol != null ? `${L.feeSol} SOL (median of ${L.feeN} live txs)` : `the setting (${L.feeN} of 10 live txs recorded)`}. Sender ${L.sender.ok} ok / ${L.sender.err + L.sender.http} refused${L.sender.last ? ` (${esc(L.sender.last).slice(0, 60)})` : ""} (every live tx also goes through the normal RPC, so a refused Sender call does not stop a trade)${v.liveGaps?.length ? `\nPer trade (+ = live better than paper): ${v.liveGaps.map(esc).join(", ")}` : ""}`,
    "",
    `<b>Strategy families on live money</b>`,
    fam || "• no live trips on record yet",
    "",
    `<b>GRID LIVE</b>: ${g.books} books, ${g.passed.length} passed${g.leader ? `, desk follows "${esc(g.leader)}"` : ", nothing to follow yet"}`,
    ...g.closest.map((b) => `• close: ${esc(b.label)} (${b.trips} trips, ${sign(r4(b.pnl))} SOL, ${b.won}% won)`),
    `Runners: ${g.runners.books} books, ${g.runners.inProfit} in profit${g.runners.best ? `; best ${esc(g.runners.best.label)} ${sign(r4(g.runners.best.pnl))} SOL over ${g.runners.best.trips}` : ""}`,
    "",
    `<b>GRID checks</b>: ${v.gridChecks.passed ?? 0} passed every check (${v.gridChecks.passedBasic ?? 0} on the test alone). Luck bar t ${v.gridChecks.nullRun?.bar ?? 0}; ${v.gridChecks.nullRun ? `${v.gridChecks.nullRun.lucky}/${v.gridChecks.nullRun.kept} shuffled runs found a "pass"` : "no null runs yet"}`,
    v.gridChecks.score ? `GRID SCORE: ${v.gridChecks.score.used} rules, ${v.gridChecks.score.effN} independent. On newer calls: AUC ${v.gridChecks.score.auc ?? "-"}, top 10% migrate ${v.gridChecks.score.top10?.rate ?? 0}% (${v.gridChecks.score.top10?.lift ?? 0}x the ${v.gridChecks.score.base}% average), top 20% ${v.gridChecks.score.top20?.lift ?? 0}x${v.gridChecks.score.why ? ` (${esc(v.gridChecks.score.why)})` : ""}` : "GRID SCORE: not fitted yet",
    v.gridChecks.pscore ? `PROFIT SCORE (buy at the call, runner exit): on newer calls AUC ${v.gridChecks.pscore.auc ?? "-"}; every call ${v.gridChecks.pscore.avgPct ?? "-"}% a trade, top 10% ${v.gridChecks.pscore.top10?.avgPct ?? "-"}% (${v.gridChecks.pscore.top10?.n ?? 0} trades, ${v.gridChecks.pscore.top10?.rate ?? 0}% paid), top 20% ${v.gridChecks.pscore.top20?.avgPct ?? "-"}%${v.gridChecks.pscore.why ? ` (${esc(v.gridChecks.pscore.why)})` : ""}` : "PROFIT SCORE: not fitted yet",
    v.gridChecks.wscore ? `WIN SCORE (size of the win): top 20% ${v.gridChecks.wscore.top20?.avgPct ?? "-"}% a trade vs ${v.gridChecks.wscore.avgPct ?? "-"}% for every call (${v.gridChecks.wscore.edge ?? "-"} pts)${v.gridChecks.wscore.why ? ` (${esc(v.gridChecks.wscore.why)})` : ""}` : "WIN SCORE: not fitted yet",
    v.gridChecks.early ? (v.gridChecks.early.why ? `<b>EARLY</b> (every launch at 2 minutes): ${esc(v.gridChecks.early.why)}` : `<b>EARLY</b> (every launch at 2 minutes): ${v.gridChecks.early.coins} reads, ${v.gridChecks.early.passed} passed every check (${v.gridChecks.early.passedBasic} the test alone), luck ${v.gridChecks.early.lucky}; every read ${v.gridChecks.early.avgPct ?? "-"}% a trade, win score top 20% ${v.gridChecks.early.winTop20 ?? "-"}%${v.gridChecks.early.best ? `; best: ${esc(v.gridChecks.early.best.key)} ${v.gridChecks.early.best.testAvg}% on ${v.gridChecks.early.best.testN} newer reads` : ""}`) : "EARLY: no search yet",
    ...v.gridChecks.earlyAges.map((e) => `• EARLY at ${e.sec}s: ${e.why ? esc(e.why) : `${e.coins} reads, ${e.passed} passed, every read ${e.avgPct ?? "-"}% a trade${e.best ? `; best ${esc(e.best.key)} ${e.best.testAvg}% on ${e.best.testN}` : ""}`}`),
    "",
    `<b>Exit flows</b> (paper, measured only): ${v.flowExit.n ? `on ${v.flowExit.n} trips the flow turned; actual ${sign(v.flowExit.actAvg ?? 0)}% a trip, selling then ${sign(v.flowExit.flagAvg ?? 0)}% (better on ${v.flowExit.flagBetter})` : "no trip has seen the flow turn yet"}`,
    "",
    `<b>Flow exit learner</b>: ${v.flowLearn.learned ? "learned" : "starting suggestion"}: ${v.flowLearn.picks.map((p) => p.text).join("; ")}${v.flowLearn.top[0]?.n ? `\n• best on record: ${variantText(v.flowLearn.top[0].v)}, ${v.flowLearn.top[0].uplift >= 0 ? "+" : ""}${v.flowLearn.top[0].uplift} pts a trip over ${v.flowLearn.top[0].n} trips (fired ${v.flowLearn.top[0].fired})` : ""}`,
    "",
    v.rug ? `<b>RUG GUARD</b> (${v.rug.trips} paper trips with an entry state, ${v.rug.rugs} rugged within 90s); live: ${v.rug.live.join(", ") || "none"}\n${v.rug.rows.map((x: any) => `• ${x.id}: ${x.verdict}, newest ${x.skipN} it would skip ${x.skipPnl >= 0 ? "+" : ""}${x.skipPnl} SOL, rugged ${x.skipRug}% vs ${x.keptRug}% of the rest`).join("\n")}` : "<b>RUG GUARD</b>: no study yet",
    "",
    v.smart ? `<b>WHO IS BUYING</b> (FOMO tap, earners, crews)\n• FOMO: ${v.smart.fomo.wallets} wallets (${v.smart.fomo.known} from FOMO's leaderboard, ${v.smart.fomo.learned} learned); ${v.smart.fomo.print.length ? `fingerprint ${v.smart.fomo.print.map((a: string) => a.slice(0, 6)).join(", ")} (${v.smart.fomo.printBy}), ${v.smart.fomo.fomoTrades} FOMO trades read` : `fingerprint not found yet (${v.smart.fomo.knownTx} trades by known FOMO wallets seen${v.smart.fomo.candidates.length ? `; best: ${v.smart.fomo.candidates.map((c: any) => `${String(c.account).slice(0, 6)} ${c.share}% of them, ${c.wallets} wallets, ${c.base}% of all`).join("; ")}` : ""})`}\n• EARNERS: ${v.smart.earners.recorded} wallets with 3+ round trips, ${v.smart.earners.earners} earners${v.smart.earners.top.length ? `; best: ${v.smart.earners.top.map((t: any) => `${t.w} +${t.pnl} SOL on ${t.trips} (${t.winRate}% won)`).join(", ")}` : ""}\n• CREWS: ${v.smart.crews ? `${v.smart.crews.crews} crews (${v.smart.crews.wallets} wallets, max 20), each counts as one buyer` : "none yet"}; bots (30+ round trips a day): ${v.smart.bots}` : "<b>WHO IS BUYING</b>: not started yet",
    v.fills?.n ? `<b>FILL LEDGER</b>: ${v.fills.n} GRID buys, signal to fill ${v.fills.ms ?? "-"} ms median (90% under ${v.fills.p90 ?? "-"} ms), fill vs the signal price ${v.fills.slip ?? "-"}%; on arrival ${v.fills.fast.n} (${v.fills.fast.ms ?? "-"} ms), next beat ${v.fills.beat.n} (${v.fills.beat.ms ?? "-"} ms); ordered at the signal ${v.fills.early}` : "<b>FILL LEDGER</b>: no GRID buy since v0.1.138",
    v.smart?.realGap ? `<b>REAL GAP</b>: ${v.smart.realGap.trades} live GRID follows paired with paper (${v.smart.realGap.exact} exact): real money made ${v.smart.realGap.gap >= 0 ? "+" : ""}${v.smart.realGap.gap} points a trade vs paper at the desk's ladder. Books are followed only while paper plus that gap makes 5%+ a trade` : "",
    v.smart?.front ? `<b>SMART</b> (after CRAWLNET): ${v.smart.front.callouts} callouts read, ${v.smart.front.matched} with buys in the 90s before; ${v.smart.front.frontRunners} front-runners (3+ callouts front-run)${v.smart.front.top?.length ? `, top: ${v.smart.front.top.map((t: any) => `${t.w} ${t.callouts} (${(t.callers || []).map((h: string) => "@" + esc(h)).join(", ")})`).join("; ")}` : ""}\n• running stories (a name or ticker that migrated a coin in 24h): ${v.smart.stories ?? 0}; FOMO retail money now vs its 6h average: ${v.smart.fomoRegime ?? "warming up"}\n• SMART books: ${v.smart.smartLive?.signals ?? 0} signals, ${v.smart.smartLive?.fired ?? 0} paper entries` : "<b>SMART</b>: not started yet",
    v.smart?.gate ? `<b>CLASS GATE</b> (live buys by market cap at the buy; ${v.smart.gate.skips} skipped since boot)\n${(v.smart.gate.classes || []).map((c: any) => `• ${c.label}: ${c.on ? "ON" : "OFF"}, ${esc(c.why)}`).join("\n")}` : "<b>CLASS GATE</b>: not started yet",
    "",
    v.bags ? `<b>BAG STUDY</b> (desk ladder with a bag riding a 50% trail up to 24h, on the followed strategies' paper trips; ${v.bags.n} settled, ${v.bags.riding} riding): desk ladder ${v.bags.desk.all ?? "-"}% a trip (${v.bags.desk.old ?? "-"}/${v.bags.desk.new ?? "-"})${v.bags.rows.map((r: any) => `, ${r.id} ${r.all ?? "-"}% (${r.old ?? "-"}/${r.new ?? "-"}, ran past the ladder on ${r.ran})`).join("")}. Live: ${v.bags.live ? `${Math.round(v.bags.live * 100)}% bag` : "no bag"}${v.bags.best ? ` (${v.bags.best} beats the ladder on both halves)` : v.bags.n < 60 ? " (needs 60 trips)" : " (no bag beats the ladder on both halves)"}` : "",
    v.ladder ? `<b>TP LADDER</b> (live: ${esc(v.ladder.desk)}; each ladder run on every paper trip, gross % a trip, older 70% / newest 30%)\n${([["all", v.ladder.all], ["under 5 SOL at the buy", v.ladder.low], ["5 SOL+", v.ladder.rest], ["the strategy the desk follows", v.ladder.leader]] as [string, any][]).filter(([, g]) => g?.n).map(([l, g]) => `• ${l} (${g.n} trips): ${g.rows.map((r: any) => `${r.id} ${r.all ?? "-"}% (${r.old ?? "-"}/${r.new ?? "-"})`).join(", ")}${g.best ? `; beats the strategy's own exit on both halves: ${g.best}` : ""}`).join("\n") || "• no paper trip has closed with the ladders yet"}` : "<b>TP LADDER</b>: no study yet",
    "",
    v.tick ? `<b>TICK MODEL</b> (every live coin, every 20s; ${v.tick.coins} coins last pass):\n${v.tick.models.map((m: any) => `• ${m.h} min: ${m.n} graded${m.ready ? "" : ` (warming up to ${v.tick?.warm})`}, out-of-sample correlation ${m.ic ?? "-"}${m.act?.n ? `; acting on it after costs: ${m.act.avgPct}% a trade over ${m.act.n} (${m.act.winRate}% won)` : ""}; top: ${m.top.map((t: any) => `${t.f} ${t.w > 0 ? "+" : ""}${t.w}`).join(", ")}`).join("\n")}` : "<b>TICK MODEL</b>: not started yet",
    "",
    v.trend ? `<b>TREND</b> (TikTok, Instagram): ${v.trend.items} videos and posts last run, ${v.trend.terms} terms; rising: ${v.trend.rising.map(esc).join(", ") || "none"}${v.trend.err ? ` (last error: ${esc(v.trend.err)})` : ""}${Object.keys(v.trend.src || {}).length ? `\n• per source: ${Object.entries(v.trend.src).map(([k, x]: [string, any]) => `${k} ${x.err ? `failed (${esc(String(x.err)).slice(0, 40)})` : x.n}`).join(", ")}` : ""}` : "<b>TREND</b>: off (set APIFY_TOKEN in Railway)",
    "",
    `<b>SEER</b>: watching for ${v.seer.armed} coins${v.seer.error ? ` (last error: ${esc(v.seer.error).slice(0, 60)})` : ""}; ${v.seer.matches.length} launches matched in 24h`,
    ...v.seer.matches.slice(0, 5).map((m) => `• ${esc(m.sym || "?")} for "${esc(m.title)}" (tier ${m.tier}, #${m.rank}, by ${m.by})`),
    "",
    `<b>Health</b>: chain ${v.health.chainUsed != null ? `${Math.round(v.health.chainUsed / 1000)}K of ${Math.round((v.health.chainBudget || 0) / 1000)}K (pace ${Math.round((v.health.chainPace || 0) / 1000)}K)` : "n/a"}, event loop p99 ${v.health.loopP99 != null ? `${v.health.loopP99}ms` : "n/a"}`,
  ].join("\n");
}

/** Once a day at 06:50 UTC (worker, checked every 10 minutes). */
/**
 * v0.1.123: the live fills against paper over the last LIVE_GAP_N live trades of each side. Worse than the fill limit
 * that blocks a strategy on paper (GAP_LIMIT, -10%): one Telegram alert, and one when it is back inside.
 */
export const LIVE_GAP_N = 20;
export function liveGap(trades: any[]) {
  const live = trades.filter((t) => t && t.live && t.par);
  const sells = live.filter((t) => t.side === "sell" && typeof t.par.out === "number").slice(0, LIVE_GAP_N).map((t) => t.par.out as number);
  const buys = live.filter((t) => t.side === "buy" && typeof t.par.tok === "number").slice(0, LIVE_GAP_N).map((t) => t.par.tok as number);
  const avg = (a: number[]) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
  return { sellN: sells.length, sell: avg(sells), buyN: buys.length, buy: avg(buys) };
}
export async function liveGapAlert(send: (t: string) => Promise<unknown>, limitPct = -10) {
  const r = redis();
  const g = liveGap((await r.lrange<any>(K.deskTrades, 0, 499).catch(() => [])) || []);
  const bad = (g.sellN >= 10 && (g.sell ?? 0) < limitPct) || (g.buyN >= 10 && (g.buy ?? 0) < limitPct);
  const open = await r.get<number>("rn:alert:livegap").catch(() => null);
  if (bad && !open) {
    await r.set("rn:alert:livegap", Date.now());
    await send(`⚠️ <b>Live fills are worse than paper</b>\nLast ${g.sellN} live sells: ${g.sell}% vs paper. Last ${g.buyN} live buys: ${g.buy}% tokens vs paper. The limit is ${limitPct}%.`).catch(() => null);
  } else if (!bad && open) {
    await r.del("rn:alert:livegap");
    await send(`✅ Live fills are back within ${limitPct}% of paper (sells ${g.sell}%, buys ${g.buy}%)`).catch(() => null);
  }
  return { ...g, bad };
}

export async function dailyReview(send: (t: string) => Promise<unknown>, now = Date.now()) {
  const d = new Date(now);
  if (d.getUTCHours() * 60 + d.getUTCMinutes() < 6 * 60 + 50) return { wait: true };
  const day = d.toISOString().slice(0, 10);
  // v0.1.100: marked sent only once it went out (a failed read or send used to lose the day's review)
  if (await redis().get(`rn:review:${day}`)) return { sent: "already today" };
  const v = await reviewView(now);
  await redis().set("rn:review:last", v, { ex: 3 * 86400 }).catch(() => null);
  await send(reviewText(v));
  await redis().set(`rn:review:${day}`, now, { ex: 3 * 86400 });
  return { sent: day };
}
