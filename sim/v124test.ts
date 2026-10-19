// v0.1.124 STOP THE BLEED: runners judged with their open positions marked now, the runner hold needs its record
// without the 2 best above a floor, and the desk never chases a GRID entry already 5%+ over paper.
// Run: npx tsx sim/v124test.ts
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
  delete process.env.HOLD_FLOOR;
  const rx = g.RUNNER_EXITS[0];
  const key = g.keyOf("pw1+bs70", "now", rx);
  const B = { key, exit: rx, grid: { testN: 0, testAvg: 0, pass: false, explore: true } };
  const now = Date.now();
  const trip = (pnl: number, i: number) => ({ k: key, mint: `T${i}`, symbol: "T", openedAt: i, closedAt: i, pnl, pnlPct: pnl * 2000 }) as any;

  // ---- 1. the 19 Oct case: +0.17 total, -0.58 without the 2 best: no longer held
  L.gridLiveReset();
  L._resetOpenMarks();
  const rec = [trip(0.42, 0), trip(0.33, 1), ...Array.from({ length: 119 }, (_, i) => trip(-0.58 / 119, i + 2))];
  L._setEver([key]);
  const st = L.bookStat(B, rec);
  ok(!st.passed && (st.lessTop2 ?? 0) < -0.1, `total +${st.totalPnl}, ${st.lessTop2} without the 2 best: not held any more (floor -${L.HOLD_FLOOR()} SOL)`);

  // ---- 2. open positions count, marked now less the exit haircut
  const P = L.gridLiveState().pos;
  for (let i = 0; i < 12; i++) P.set(`${key}#O${i}`, { key, mint: `O${i}`, symbol: "O", openedAt: now - 3600_000, fillPx: 1e-7, tokens: 150_000, cost: 0.0505, back: 0.07, peak: 3e-7, initials: true, tEnd: now + 1e7, lastPx: 2.8e-7, lastReal: 30 } as any);
  L._resetOpenMarks();
  const marks = L.openMarks(key, now);
  const v = 0.07 + 150_000 * 2.8e-7 * (1 - L.EXIT_HAIRCUT) - 0.0505;
  ok(marks.length === 12 && Math.abs(marks[0].pnl - v) < 1e-6, `an open runner counts at what it would bring back now (${marks[0].pnl} SOL: sold part + bag at 2.8x less ${L.EXIT_HAIRCUT * 100}%)`);
  const st2 = L.bookStat(B, rec);
  ok(st2.total === 133 && (st2.totalPnl ?? 0) > (st.totalPnl ?? 0) && (st2.lessTop2 ?? -1) > -0.1, `with its 12 open runners: ${st2.total} trips, total +${st2.totalPnl}, ${st2.lessTop2} without the 2 best`);
  ok(st2.passed, "its whole record, open runners included, passes the runner exam on its own");
  P.clear();
  L._resetOpenMarks();

  // ---- 3. the hold still works above the floor
  const near = [trip(0.3, 0), trip(0.2, 1), ...Array.from({ length: 80 }, (_, i) => trip(i % 9 ? -0.0011 : 0.004, i + 2))];
  const h = L.bookStat(B, near);
  ok(h.passed && !!h.hold && (h.lessTop2 ?? 0) >= -0.1 && (h.lessTop2 ?? 0) < 0, `just under water without the 2 best (${h.lessTop2}): still held at the minimum size`);

  // ---- 4. no chasing
  const D = await import("../src/lib/desk");
  ok(D.entryChase() === 0.05, "the desk skips a GRID entry once the price is 5%+ over the paper fill");
  const dk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/chase - 1 > entryChase\(\)/.test(dk) && /fresh\.px \/ o\.px0/.test(dk), "checked on the fresh price right before the buy");
  ok(/px0, \.\.\.\(pe\.mult/.test(fs.readFileSync("src/lib/gridlive.ts", "utf8")), "GRID LIVE hands the desk its paper fill price with every order");
  ok(/GRID_BUYING \|\| !rec\.call \? "GRID LIVE follow"/.test(dk), "a GRID follow says GRID LIVE even when the coin had a King call");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 124 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.124 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.124 checks pass");
  process.exit(fail ? 1 : 0);
})();
