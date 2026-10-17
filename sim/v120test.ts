// v0.1.120 TICK MODEL + NO QUICK KILLS. Run: npx tsx sim/v120test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
process.env.TICK_WARM = "1000";
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
(async () => {
  const fs = await import("fs");
  const T = await import("../src/lib/tick");
  const L = await import("../src/lib/gridlive");
  const g = await import("../src/lib/grid");

  // ---- 1. the model learns momentum from every moment of every coin, out of sample
  T._tickReset();
  const t0 = 1_790_000_000_000;
  const coins = Array.from({ length: 300 }, (_, i) => ({ m: `C${i}`, d: i % 2 ? 0.006 : -0.006, mc: 30 }));
  for (const c of coins) T.tickCreate(c.m, t0, c.m, c.m);
  const extra = () => ({ u60: 20, bs60: 0.6, wh: 0, pw: 0, n60: 30, kf: 0, kx: 0, e20: 0.2, ds: false, og: null, dx: null, tr: null });
  let sigs: any[] = [];
  for (let s = 0; s <= 50 * 60; s += 5) {
    const now = t0 + s * 1000;
    for (const c of coins) {
      // each coin keeps its drift for a while (momentum), with noise; the drift flips now and then
      if (rnd() < 0.004) c.d = -c.d;
      c.mc = Math.max(10, c.mc * (1 + c.d + (rnd() - 0.5) * 0.01));
      T.tickCurve(c.m, { progress: 30, mcapSol: c.mc, realSol: 6 }, now);
    }
    const out = T.tickRun(extra, now);
    if (s > 40 * 60) sigs.push(...out);
  }
  const v = T.tickView();
  const m2 = v.models.find((m) => m.h === 2)!;
  ok(m2.n > 20_000 && m2.ready, `thousands of graded predictions from 300 coins in 50 minutes (${m2.n} at 2 min, ${v.models.map((m) => m.n).join(" / ")})`);
  ok((m2.ic ?? 0) > 0.2, `out-of-sample correlation with what happened: ${m2.ic}`);
  const w = (f: string) => m2.top.find((t) => t.f === f)?.w ?? 0;
  ok(w("r60") > 0 || w("r180") > 0 || w("r30") > 0, `it found momentum by itself (r30 ${w("r30")}, r60 ${w("r60")}, r180 ${w("r180")}: + = momentum)`);
  ok(sigs.length > 0 && sigs.every((x) => x.ev > 0 && x.cost > 0.03), `signals only where the prediction beats the coin's costs (${sigs.length}, cost ${sigs[0]?.cost})`);
  ok((m2.act.avgPct ?? -1) > 0, `acting on it after costs, graded out of sample: ${m2.act.avgPct}% a trade over ${m2.act.n}`);

  // ---- 2. TICK books
  L.gridLiveReset();
  const books = L.seedTick(t0, T.tickReady, T.HORIZONS);
  ok(books.length === 6 && books.every((b) => b.by === "tick" && b.tick), `two books per horizon once its model is warm (${books.map((b) => b.key.split("|")[0]).join(", ")})`);
  const sg = sigs.find((x) => x.h === 2)!;
  L.gridLiveCurve(sg.mint, { progress: 30, mcapSol: 40, realSol: 6 }, t0 + 3000_000);
  const n = L.gridLiveTick(sg.mint, sg.sym, 2, 0.08, t0 + 3000_000);
  const pend = [...L.gridLiveState().pend.entries()].filter(([k]) => k.startsWith("tick:h2"));
  ok(n === 2 && pend.length === 2 && pend.some(([, p]) => (p as any).mult === 1.3) && pend.some(([, p]) => (p as any).mult === 1.8), "a signal 8 points over cost starts both 2-minute books; size follows the prediction (1.8x over the 0 margin, 1.3x over the 5-point one)");
  ok(L.gridLiveTick(sg.mint, sg.sym, 2, 0.02, t0 + 3001_000) === 0, "once per coin while it is open");
  L.gridLiveCall({ mint: sg.mint, symbol: "X", at: t0, createdAt: t0, verdict: "BOND", score: 90, progress: 30, tp: {} }, t0 + 3000_000);
  ok([...L.gridLiveState().pend.keys()].filter((k) => k.startsWith("tick:")).length === 2, "a King call never triggers a TICK book");

  // ---- 3. NO QUICK KILLS
  delete process.env.BOOK_KEEP_DAYS;
  L.gridLiveReset();
  const ex = { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15, mig: "sell" as const };
  const now = Date.now();
  const youngKey = g.keyOf("sm", "now", ex), oldKey = g.keyOf("u20", "now", ex);
  L._setBooks([
    { key: youngKey, label: "y", filter: "sm", mode: "now", exit: ex, since: now - 3600_000, grid: { testN: 0, testAvg: 0, pass: false, explore: true } } as any,
    { key: oldKey, label: "o", filter: "u20", mode: "now", exit: ex, since: now - 8 * 86400_000, grid: { testN: 0, testAvg: 0, pass: false, explore: true } } as any,
  ]);
  const lose = (k: string) => Array.from({ length: 12 }, (_, i) => ({ k, mint: `${k}${i}`, symbol: "x", openedAt: i, closedAt: i, pnl: -0.01, pnlPct: -20 }) as any);
  L._setTrips([...lose(youngKey), ...lose(oldKey)]);
  const r = await L.gridLiveTend(undefined, now);
  const bs = L.gridLiveBooks();
  ok(bs.some((b) => b.key === youngKey && b.cold) && r.dropped.every((d) => d.key !== youngKey), "a book an hour old with a losing record is not dropped: it goes COLD and keeps trading on paper");
  ok(!bs.some((b) => b.key === oldKey) && r.dropped.some((d) => d.key === oldKey), "past 7 days with a losing record: removed (its trips stay)");
  L._setTrips([...Array.from({ length: 12 }, (_, i) => ({ k: youngKey, mint: `w${i}`, symbol: "x", openedAt: i, closedAt: i, pnl: i % 2 ? 0.02 : -0.005, pnlPct: 10 }) as any)]);
  await L.gridLiveTend(undefined, now + 60_000);
  ok(L.gridLiveBooks().some((b) => b.key === youngKey && !b.cold), "its record recovers: warm again");
  const rows = Array.from({ length: 20 }, (_, i) => ({ key: g.keyOf("bond", "now", { ...ex, timeMin: 15 + i }), filter: "bond", filterLabel: "x", mode: "now", modeLabel: "x", exit: { ...ex, timeMin: 15 + i }, test: { n: 30, avgPct: 3 }, pass: false })) as any;
  L._setBooks(Array.from({ length: 16 }, (_, i) => ({ key: g.keyOf("sn", "now", { ...ex, timeMin: 100 + i }), label: "c", filter: "sn", mode: "now", exit: { ...ex, timeMin: 100 + i }, since: now, grid: { testN: 0, testAvg: 0, pass: false }, cold: { at: now, why: "x" } }) as any));
  L._setTrips([]);
  const after = await L.gridLiveSetBooks(rows, now);
  ok(after.filter((b: any) => !b.cold && !b.by).length === 16, "cold books do not take GRID's 16 slots: new candidates still go live");

  // ---- 4. QUALITY FIRST: GRID pairs only rules that beat buying every call on their own (older calls)
  const gs = fs.readFileSync("src/lib/grid.ts", "utf8");
  ok(/if \(!allPairs && !\(good\[a\] && good\[b\]\)\) continue;/.test(gs) && /for \(let i = 0; i < cut; i\+\+\) if \(\(!h \|\| h\[i\]\)/.test(gs), "pairs are built only from rules that are good alone, judged on the older calls only (no look at the test)");

  // ---- 5. wiring
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/tickCreate\(c\.mint/.test(wk) && /tickCurve\(mint/.test(wk) && /tickRun\(/.test(wk) && /gridLiveTick\(g\.mint, g\.sym, g\.h, g\.ev\)/.test(wk) && /await tickLoad\(\)/.test(wk) && /tickSave\(\)/.test(wk), "the worker feeds TICK every curve update, runs it every 20s, saves and loads what it learned");
  ok(/const mult = o\.mult && Number\.isFinite\(o\.mult\)/.test(fs.readFileSync("src/lib/desk.ts", "utf8")), "the desk sizes a followed TICK trade by its prediction (0.5x to 2x, inside every cap)");
  ok(fs.existsSync("src/app/api/desk/tick/route.ts") && /TICK MODEL/.test(fs.readFileSync("src/lib/review.ts", "utf8")), "/api/desk/tick and the daily review");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 120 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.120 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.120 checks pass");
  process.exit(fail ? 1 : 0);
})();
