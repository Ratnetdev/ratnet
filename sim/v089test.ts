// v0.1.89: RUNNER MODE. Exits that sell most at the first target and let the rest ride up to a day, the runner exam
// (60+ trips, in profit, still in profit without the 2 best), the runner family on GRID LIVE, the desk following a
// runner, and a day of prices archived for called coins. Run: npx tsx sim/v089test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const g = await import("../src/lib/grid");
  const L = await import("../src/lib/gridlive");

  // ---- 1. the exit
  const run = g.RUNNER_EXITS[0];
  const key = g.keyOf("bond", "now", run);
  ok(key === "bond|now|2/0.5/0.35/60/hold/k0.3h24", `a runner's key carries what it keeps and how long (${key})`);
  const back = g.exitOfPart(key.split("|")[2])!;
  ok(back.keep === 0.3 && back.hours === 24 && back.mig === "hold" && g.isRunner(back) && g.keyOf("bond", "now", back) === key, "read back from its key exactly");
  ok(g.keyOf("bond", "now", g.GEXITS[3]) === `bond|now|${g.GEXITS[3].initials}/${g.GEXITS[3].trail}/${g.GEXITS[3].stop}/${g.GEXITS[3].timeMin}/${g.GEXITS[3].mig}` && !g.isRunner(g.GEXITS[3]), "regular keys unchanged");
  ok(g.GEXITS.length === 51 && g.GEXITS.slice(48).every((x) => g.isRunner(x)), "the runner exits are on GRID's menu, after the 48 regular ones (RESEARCHER's numbers unchanged)");
  ok(g.firstSell(run) === 0.7 && g.firstSell(g.GEXITS[0]) === 0.5 && g.holdMax(run) === 24 * 3600_000, "sells 70% at the first target, holds up to 24h");
  ok(/^RUNNER: 70% at 2x, the rest rides a 50% trail for up to 24h/.test(g.exitText(run)), g.exitText(run));

  // ---- 2. GRID: a 246x-style runner path (call, 2x, then 40x over hours, back to 25x)
  const H = 3600_000;
  const pts: [number, number, number][] = [
    [0, 30, 0], [5_000, 30, 0], [600_000, 61, 0], [1_800_000, 35, 0], [3 * H, 0, 2], [3 * H + 60_000, 400, 2], [6.5 * H, 900, 2], [8 * H, 1200, 2], [10 * H, 700, 2], [12 * H, 500, 2],
  ];
  const coin: any = { mint: "R", symbol: "R", at: 0, t: Int32Array.from(pts.map((p) => p[0])), mc: Float32Array.from(pts.map((p) => p[1])), real: Float32Array.from(pts.map(() => 20)), prog: Float32Array.from(pts.map((p) => (p[2] ? 100 : 50))), done: Uint8Array.from(pts.map((p) => p[2])) };
  coin.mc[4] = 80; // the migration tick (curve's last price)
  coin.done[4] = 1;
  const j = 1;
  const pr = g.tradeFrom(coin, j, run)!;
  const reg = g.tradeFrom(coin, j, { initials: 2, trail: 0.4, stop: 0.45, timeMin: 60, mig: "hold" })!;
  ok(pr > 0.2, `the runner keeps its 30% through the migration (peak 40x) and is out on its 50% trail: +${pr.toFixed(3)} SOL on 0.05`);
  ok(pr > reg * 3, `the regular exit (half at 2x, 40% trail) is shaken out on the dip after 2x: +${reg.toFixed(3)} SOL`);
  const sellReg = g.tradeFrom(coin, j, { initials: 3, trail: 0.4, stop: 0.45, timeMin: 60, mig: "sell" });
  ok(sellReg != null && sellReg < 0.05, "a regular exit that sells at the migration still ends within the hour on the curve");

  // ---- 3. the runner exam
  const tr = (k: string, pnl: number, i: number) => ({ k, mint: `m${i}`, symbol: "X", openedAt: i, closedAt: i + 1, pnl, pnlPct: (pnl / 0.0525) * 100, why: "t" });
  const two = Array.from({ length: 60 }, (_, i) => tr(key, i < 2 ? 1.2 : -0.03, i));
  const s2 = L.runnerStat(two as any);
  ok(!s2.passed && s2.runner && (s2.lessTop2 ?? 0) < 0 && (s2.totalPnl ?? 0) > 0, `in profit only because of 2 coins: not passed (${s2.totalPnl} SOL, ${s2.lessTop2} without them)`);
  const five = Array.from({ length: 60 }, (_, i) => tr(key, i < 5 ? 0.6 : -0.03, i));
  const s5 = L.runnerStat(five as any);
  ok(s5.passed && s5.winRate < 40, `5 runners in 60 trips: passed on its whole record (${s5.winRate}% won over the last 30)`);
  ok(L.dropReason(L.runnerStat(Array.from({ length: 30 }, (_, i) => tr(key, -0.018, i)) as any)) === null, "30 stopped-out trips (-36% each) do not drop a runner yet (1 in 12 BOND calls bonds)");
  ok(/losing/.test(String(L.dropReason(L.runnerStat(Array.from({ length: 30 }, (_, i) => tr(key, -0.03, i)) as any)))), "losing more than 40% of what it staked after 30: dropped");
  ok(/120 trips/.test(String(L.dropReason(L.runnerStat(Array.from({ length: 120 }, (_, i) => tr(key, i % 40 === 0 ? 0.5 : -0.02, i)) as any)))), "120 trips without passing: dropped");
  ok(L.dropReason(L.runnerStat(Array.from({ length: 6 }, (_, i) => tr(key, -0.02, i)) as any)) === null, "no win in 5 does not drop a runner (the regular rule would)");

  // ---- 4. the runner family on GRID LIVE
  L.gridLiveReset();
  const t1: any = await L.gridLiveTend();
  const rb = L.gridLiveBooks().filter((b) => b.by === "runner");
  ok(rb.length === 6 && rb.every((b) => g.isRunner(b.exit)) && rb.some((b) => b.key === key) && rb.some((b) => b.filter === "bond+pw1"), `the runner family is trading (${rb.map((b) => b.key).join(", ")})`);
  const books = await L.gridLiveSetBooks(Array.from({ length: 20 }, (_, i) => ({ key: `bond|now|2/0.25/0.25/15/sell#${i}`, filterLabel: "King BOND", filter: "bond", mode: "now", modeLabel: "at the call", exit: { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15, mig: "sell" }, test: { n: 40, avgPct: 3 }, pass: false })) as any);
  ok(books.filter((b: any) => !b.parent && !b.by && !b.back).length === 16 && books.filter((b: any) => b.by === "runner").length === 6, "GRID keeps its 16; runners have their own slots");
  const t2: any = await L.gridLiveTend();
  ok(t2.revived.length === 0 && L.gridLiveBooks().filter((b) => b.by === "runner").length === 6, "seeded once");
  ok(L.bookStat({ grid: { testN: 0, testAvg: 0, pass: false }, key }, five as any).passed && L.bookStat({ grid: { testN: 0, testAvg: 0, pass: false }, key: "bond|now|2/0.5/0.35/60/hold" }, five as any).passed === false, "a book's exam follows its exit (runner exam for runners only)");

  // ---- 5. the desk follows a runner exactly
  const D = await import("../src/lib/desk");
  const p: any = { gx: run, entryPx: 1, peakPx: 2.1, tp1Done: false, openedAt: 0, gradSeen: false };
  const a = D.gridExit(p, { px: 2.1, grad: false }, 5 * 60_000);
  ok(a.frac === 0.7 && /70% at 2\.10x/.test(a.why), `first target: ${a.why}`);
  p.tp1Done = true;
  p.peakPx = 3;
  ok(D.gridExit(p, { px: 1.05, grad: true }, 5 * H).frac === 0 || D.gridExit(p, { px: 1.05, grad: true }, 5 * H).why.includes("trail"), "after its first target, time does not end a runner (only the trail, the stop or its hours)");
  ok(D.gridExit(p, { px: 2.9, grad: true }, 5 * H).frac === 0, "5 hours in, near its peak, through the migration: still holding");
  ok(D.gridExit(p, { px: 2.9, grad: true }, 24 * H + 1).frac === 1, "24 hours: out");

  // ---- 6. a day of prices for called coins
  const ar = fs.readFileSync(new URL("../src/lib/archive.ts", import.meta.url), "utf8");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/export function archiveRunTick/.test(ar) && /if \(now - at < 62 \* 60_000\) return false;/.test(ar) && /< 60_000\) return false;/.test(ar), "one price a minute from the second hour to the 24th");
  ok(/call\.verdict === "BOND" \|\| Number\(call\.progress\) >= 30\)\) runTrack/.test(wk) && (wk.match(/archiveRunTick\(mint,/g) || []).length === 2, "BOND calls and calls 30%+ up the curve, curve and pool prices from the firehose");
  const gs = fs.readFileSync(new URL("../src/lib/grid.ts", import.meta.url), "utf8");
  ok(/at <= c\.at \+ RUN_MS \+ 30 \* 60_000\) c\.tk\.push/.test(gs), "GRID loads a day of prices per call");

  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const bld = fs.readFileSync(new URL("../src/config/build.ts", import.meta.url), "utf8");
  ok(pkg.version === bld.match(/"([0-9.]+)"/)![1], "build tag matches the package");
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
