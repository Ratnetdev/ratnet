// v0.1.122 PROOF FIRST: probation needs 25 trips and a luck bar, TICK trades only while acting on it pays, and each
// book keeps its own trip record. Run: npx tsx sim/v122test.ts
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
  const L = await import("../src/lib/gridlive");
  const T = await import("../src/lib/tick");
  const g = await import("../src/lib/grid");
  delete process.env.PROBATION_MIN;
  delete process.env.PROBATION_T;

  // ---- 1. probation: 25 trips and the luck bar
  const ex = { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15, mig: "sell" as const };
  const B = { key: `early:${g.keyOf("r15", "now", ex)}`, exit: ex, grid: { testN: 20, testAvg: 9, pass: false, explore: true } };
  const trip = (pnlPct: number, i: number) => ({ k: B.key, mint: `T${i}`, symbol: "T", openedAt: i, closedAt: i, pnl: pnlPct / 2000, pnlPct } as any);
  const lucky = Array.from({ length: 16 }, (_, i) => trip(i % 2 ? 40 : -8, i)); // the 17 Oct kind: 16 trips, in profit
  ok(!L.bookStat(B, lucky).probation, "16 good-looking trips: no probation any more (25 needed)");
  const noisy = Array.from({ length: 30 }, (_, i) => trip(i % 5 === 0 ? 120 : -20, i)); // in profit only through a few big wins
  ok(!L.bookStat(B, noisy).probation && L.tStat(noisy) < 2, `30 trips in profit through a few big wins: below the luck bar (t ${L.tStat(noisy).toFixed(2)})`);
  const real = Array.from({ length: 30 }, (_, i) => trip(i % 3 === 0 ? -10 : 18, i));
  ok(!!L.bookStat(B, real).probation && L.tStat(real) >= 2, `30 trips with a steady edge: probation (t ${L.tStat(real).toFixed(2)})`);

  // ---- 2. per-book trip record
  const many = [...Array.from({ length: 1000 }, (_, i) => ({ k: "tick:a", mint: `A${i}`, closedAt: 2000 - i } as any)), ...Array.from({ length: 30 }, (_, i) => ({ k: "early:b", mint: `B${i}`, closedAt: i } as any))];
  const kept = L.keepTrips(many);
  ok(kept.filter((t) => t.k === "tick:a").length === L.TRIPS_PER_BOOK && kept.filter((t) => t.k === "early:b").length === 30, `a busy book keeps its last ${L.TRIPS_PER_BOOK}; a quiet book keeps its whole record`);
  ok(L.TRIPS_MAX >= 20_000, "the saved record holds 20,000 trips (was 3,000)");

  // ---- 3. TICK acts only while acting pays
  T._tickReset();
  ok(T.tickActs(2), "no record yet: allowed (paper only, until the record says otherwise)");
  const src = fs.readFileSync("src/lib/tick.ts", "utf8");
  ok(/if \(tickReady\(h\) && tickActs\(h\)\)/.test(src) && /a\.sum \/ a\.n > 0/.test(src), "a horizon signals only while its acted predictions paid after costs (2,000+ graded)");

  // ---- 4. GRID buys say what they are
  const d = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok((d.match(/: "GRID LIVE follow"/g) || []).length === 2 && !/`King \$\{rec\.call\?\.verdict\}/.test(d), "a GRID follow is logged as such (was \"King undefined undefined\")");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 122 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.122 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.122 checks pass");
  process.exit(fail ? 1 : 0);
})();
