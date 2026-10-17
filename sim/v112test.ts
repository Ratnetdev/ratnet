// v0.1.112 ONE SCORE, NO LUCK: GRID SCORE (every rule combined, fitted on the older calls), NULL RUN (the search on
// shuffled outcomes sets a luck bar), PLATEAU (neighbouring exits must hold up), NEWEST SLICE, the SCORE family on live
// calls, and the FAST LANE (a GRID-proven book on probation after 15 good trips). Run: npx tsx sim/v112test.ts
import type { GCoin } from "../src/lib/grid";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function coin(i: number, steps: number[], f: Partial<GCoin> = {}): GCoin {
  const n = steps.length + 1;
  const t = new Int32Array(n), mc = new Float32Array(n), real = new Float32Array(n), prog = new Float32Array(n), done = new Uint8Array(n);
  let px = 30;
  for (let k = 0; k < n; k++) {
    if (k) px *= 1 + steps[k - 1];
    t[k] = k * 10_000;
    mc[k] = px;
    real[k] = Math.max(1, px - 25);
    prog[k] = Math.min(99, Math.max(0, (px - 28) * 1.2));
  }
  return { mint: `M${i}`, symbol: `S${i}`, at: 1_790_000_000_000 + i * 60_000, createdAt: 1_790_000_000_000 + i * 60_000 - 90_000, verdict: "WATCH", score: 50, nano: 40, progress: prog[0], rise60: 2, uniq: 15, spb: 0.2, bs: 0.3, sn: 5, sm: 0, ds: false, soc: 0, t, mc, real, prog, done, ...f };
}
const walk = () => Array.from({ length: 60 }, () => (rnd() - 0.5) * 0.08);
const pump = () => [...Array.from({ length: 12 }, () => 0.06 + rnd() * 0.04), ...Array.from({ length: 40 }, () => (rnd() - 0.5) * 0.03)];
const dump = () => Array.from({ length: 60 }, () => -0.02 + (rnd() - 0.55) * 0.04);

(async () => {
  const fs = await import("fs");
  const g = await import("../src/lib/grid");

  // ---- 1. GRID SCORE: two weak, independent signals combined beat either alone; a duplicate rule adds nothing
  // world: a smart wallet (sm) and a social link (soc) each raise the migration odds on their own; "50+ buyers" is
  // the same coins as the smart wallet (a copy of that signal)
  const w1: GCoin[] = [];
  for (let i = 0; i < 4000; i++) {
    const a = rnd() < 0.25, b = rnd() < 0.25;
    const p = 0.04 + (a ? 0.1 : 0) + (b ? 0.1 : 0);
    w1.push(coin(i, walk(), { sm: a ? 1 : 0, uniq: a ? 60 : 10, soc: b ? 1 : 0, bonded: rnd() < p }));
  }
  const hit = g.PREDS.map((p) => (g.SCORE_RULES.has(p.id) ? undefined : w1.map((c) => p.ok(c))));
  const sc = g.fitScore(w1, hit, 2800);
  ok(!!sc.model && sc.used >= 3, `a score is fitted from the rules that fire (${sc.used} rules)`);
  const wOf = (id: string) => sc.model!.w[sc.model!.ids.indexOf(id)];
  ok(sc.model!.ids.includes("sm") && sc.model!.ids.includes("u50") && Math.abs(wOf("sm") - wOf("u50")) < 0.05, `a copied rule shares the weight instead of doubling it (sm ${wOf("sm")}, 50+ buyers ${wOf("u50")})`);
  ok(sc.effN < sc.used, `effective N counts the copy once: ${sc.effN} independent of ${sc.used}`);
  ok((sc.test?.auc ?? 0) > 0.6 && (sc.test?.top20.lift ?? 0) > 1.5, `judged on the newer calls only: AUC ${sc.test?.auc}, top 20% migrate ${sc.test?.top20.lift}x the average`);
  // both signals together score above either alone
  g.setScoreModel(sc.model);
  const both = g.scoreOf({ ...w1[0], sm: 1, uniq: 60, soc: 1 })!, one = g.scoreOf({ ...w1[0], sm: 1, uniq: 60, soc: 0 })!, none = g.scoreOf({ ...w1[0], sm: 0, uniq: 10, soc: 0 })!;
  ok(both > one && one > none, "two signals together outrank one, one outranks none");
  const p10 = g.PREDS.find((p) => p.id === "score10")!;
  ok(p10.ok({ ...w1[0], sm: 1, uniq: 60, soc: 1 }) && !p10.ok({ ...w1[0], sm: 0, uniq: 10, soc: 0 }), "score10 / score20 are rules on GRID's menu (appended)");
  g.setScoreModel(null);
  ok(!p10.ok({ ...w1[0], sm: 1, uniq: 60, soc: 1 }), "no model: the score rules never pass");
  // the first live run (17 Oct): a rule that (almost) separates the coins made the plain Newton fit swing and never settle
  const ys = Uint8Array.from({ length: 2000 }, () => (rnd() < 0.03 ? 1 : 0));
  const runs = [1, 2, 3, 5, 12, 40].map((it) => g.fitLogit([Uint8Array.from(ys), Uint8Array.from({ length: 2000 }, () => (rnd() < 0.5 ? 1 : 0))], ys, 2000, 2, it).w[0]);
  ok(runs.slice(3).every((w) => w > 3 && w < 10) && Math.abs(runs[4] - runs[5]) < 0.05, `a rule that separates the coins: the fit settles (${runs.map((w) => w.toFixed(2)).join(", ")})`);
  ok(g.aucOf([1, 2, 3, 4], [0, 0, 1, 1]) === 1 && g.aucOf([1, 1, 1, 1], [0, 1, 0, 1]) === 0.5, "AUC: 1 = perfect ranking, 0.5 = a coin flip");

  // ---- 2. PLATEAU: the neighbours of an exit
  const xi = g.GEXITS.findIndex((x) => !g.isRunner(x) && x.initials === 2 && x.trail === 0.25 && x.stop === 0.25 && x.timeMin === 15 && x.mig === "sell");
  const nb = g.neighbourIdx(xi).map((j) => g.GEXITS[j]);
  ok(nb.length === 6 && nb.every((e) => [e.initials !== 2, e.trail !== 0.25, e.stop !== 0.25, e.timeMin !== 15, e.mig !== "sell"].filter(Boolean).length === 1), "a 2x exit has 6 neighbours (initials up and down, trail, stop, time, migration)");
  const x15 = g.GEXITS.findIndex((x) => !g.isRunner(x) && x.initials === 1.5 && x.trail === 0.25 && x.stop === 0.25 && x.timeMin === 15 && x.mig === "sell");
  ok(g.neighbourIdx(x15).every((j) => g.GEXITS[j].initials !== 3), "1.5x and 3x are two steps apart: not neighbours");
  ok(g.neighbourIdx(g.GEXITS.findIndex((x) => g.isRunner(x))).length === 0, "runner exits have no neighbours (their own 60-trip exam)");

  // ---- 3. NULL RUN on a world with a real edge (the v0.1.71 world): the edge still passes, every check is shown
  const world: GCoin[] = [];
  for (let i = 0; i < 3000; i++) {
    const edge = rnd() < 0.12;
    world.push(coin(i, edge ? (rnd() < 0.7 ? pump() : dump()) : walk(), edge ? { sm: 2, uniq: 60 } : { sm: rnd() < 0.08 ? 1 : 0, uniq: Math.floor(rnd() * 70) }));
  }
  const v = await g.runGrid(world, { nulls: 2, nullHist: [] });
  ok(v.nullRun.runs === 2 && v.nullHist.length === 2, `2 shuffled searches ran (luck stats ${JSON.stringify(v.nullRun.thisRun)})`);
  ok(v.passed >= 1 && v.rows.some((r) => r.pass && /smart wallet/.test(r.filterLabel)), `the real edge beats the luck bar (${v.passed} passed, bar t ${v.nullRun.bar})`);
  const pr = v.rows.find((r) => r.pass)!;
  ok(!!pr.checks && pr.checks.basic && pr.checks.recent.ok && pr.checks.plateau.ok && pr.checks.t > pr.checks.bar, `a pass shows its checks: t ${pr.checks?.t} > bar ${pr.checks?.bar}, plateau ${pr.checks?.plateau.up}/${pr.checks?.plateau.n}, newest slice ${pr.checks?.recent.n} trips ${pr.checks?.recent.pnl} SOL`);
  ok(v.nullRun.thisRun.every((t) => t < pr.checks!.t), "shuffled outcomes keep each call's trades, so when every call pays the bar rises to that level: a rule must beat buying every call");
  ok(v.passedBasic >= v.passed, `stricter than before: ${v.passedBasic} on the test alone, ${v.passed} on every check`);
  ok(!!v.score && v.score.model === null && /too few migrations/.test(v.score.why), `no migrations in this world: no score, and the run says why ("${v.score.why}")`);

  // the bar: the 95th percentile of the luck stats once 10+ null runs are kept
  const vb = await g.runGrid(world, { nulls: 0, nullHist: Array(10).fill(500), fitScore: false });
  ok(vb.nullRun.bar === 500 && vb.passed === 0 && vb.passedBasic >= 1, "when shuffled outcomes 'pass' with t 500 every time, nothing real below that gets through");
  const vz = await g.runGrid(world, { nulls: 0, nullHist: [...Array(19).fill(0), 9], fitScore: false });
  ok(vz.nullRun.bar === 0 && vz.passed >= 1 && vz.nullRun.luckRate === 5, "1 lucky run in 20 (5%): the bar stays at 0, a real edge passes");

  // a world of pure noise: nothing passes, with or without the bar
  const noise: GCoin[] = [];
  for (let i = 0; i < 2000; i++) noise.push(coin(i, walk(), { sm: rnd() < 0.2 ? 1 : 0, uniq: Math.floor(rnd() * 70), soc: rnd() < 0.3 ? 1 : 0 }));
  const vn = await g.runGrid(noise, { nulls: 2, fitScore: false });
  ok(vn.passed === 0, `pure noise: nothing passes (${vn.passedBasic} on the test alone)`);

  // ---- 4. the SCORE family and the FAST LANE (GRID LIVE)
  const L = await import("../src/lib/gridlive");
  L.gridLiveReset();
  g.setScoreModel(null);
  ok(L.seedScore(Date.now()).length === 0, "no score yet: no SCORE books");
  g.setScoreModel({ ...sc.model!, auc: 0.5 });
  ok(L.seedScore(Date.now()).length === 0, "a score that ranks no better than a coin flip on the newer calls (AUC under 0.55): not traded");
  g.setScoreModel(sc.model);
  const s1 = L.seedScore(Date.now());
  ok(s1.length === 2 && s1.every((b) => b.by === "score") && s1[0].key === g.keyOf("score10", "now", g.RUNNER_EXITS[0]), `a score exists: top 10% and top 20% trade on live calls (${s1.map((b) => b.key).join(", ")})`);
  ok(L.seedScore(Date.now()).length === 0, "seeded once (2 slots)");

  const trip = (pnl: number, i: number) => ({ k: "x", mint: `T${i}`, symbol: "T", openedAt: i, closedAt: i, pnl, pnlPct: pnl * 2000 } as any);
  const good = Array.from({ length: 16 }, (_, i) => trip(i % 3 === 0 ? 0.03 : -0.005, i));
  const ex = { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15, mig: "sell" as const };
  const proven = { key: g.keyOf("sm", "now", ex), exit: ex, grid: { testN: 40, testAvg: 9, pass: true } };
  const explore = { key: g.keyOf("sm", "now", ex), exit: ex, grid: { testN: 40, testAvg: 9, pass: false, explore: true } };
  ok(L.bookStat(proven, good).passed && !!L.bookStat(proven, good).probation, "FAST LANE: GRID-proven, 16 trips in profit (also without the 2 best): probation, the desk may follow at the minimum size");
  ok(!L.bookStat(explore, good).passed, "an explore row (not proven by GRID) waits for the full exam");
  ok(!L.bookStat(proven, good.slice(0, 10)).passed, "under 15 trips: not yet");
  const lucky = [trip(0.5, 0), ...Array.from({ length: 15 }, (_, i) => trip(-0.01, i + 1))];
  ok(!L.bookStat(proven, lucky).passed, "in profit only thanks to one coin: no probation");

  // ---- 5. wiring
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/rn:grid:null/.test(wk) && /GRID_NULL/.test(wk) && /setScoreModel\(v\?\.score\?\.model\)/.test(wk), "the worker keeps the luck stats across runs and loads the last score at boot");
  const gl = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  ok(/const scs = seedScore\(now\)/.test(gl), "GRID LIVE seeds the SCORE family on every tend");
  ok(/gridChecks/.test(fs.readFileSync("src/lib/review.ts", "utf8")), "the daily review shows the checks, the luck bar and the score");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 112 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.112 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.112 checks pass");
  process.exit(fail ? 1 : 0);
})();
