// v0.1.117 EARLY FAST TRACK: launches read at 60s, 2, 3 and 5 minutes (one search and its own books per age), the best
// EARLY book gets its exit family, and EARLY books go on probation after 15 good trips (the desk may follow at the
// minimum size). Run: npx tsx sim/v117test.ts
import type { GCoin } from "../src/lib/grid";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
// the probation rule these checks were written for (v0.1.122 raised it: 25 trips and a luck bar, see v122test)
process.env.PROBATION_MIN = "15";
process.env.PROBATION_T = "-99";
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const g = await import("../src/lib/grid");
  const E = await import("../src/lib/early");
  const L = await import("../src/lib/gridlive");

  // ---- 1. reads at several ages
  delete process.env.EARLY_CHECKS;
  ok(JSON.stringify(E.EARLY_CHECKS()) === "[60,120,180,300]", `reading ages: ${E.EARLY_CHECKS().join(", ")}s`);
  E._earlyReset();
  const t0 = 1_790_000_000_000;
  const feat = () => ({ pw: 0, u60: 20, bs60: 0.7, wh: 0, ds: false, kf: 0, kmu: null, kx: 0, e20: 0.2, og: null, dx: null });
  E.earlyCreate("RUN", t0, "RUN");
  const reads: any[] = [];
  // the curve climbs 4 points every 15 seconds from 6%; the sweep runs every 5 seconds
  for (let s = 5; s <= 380; s += 5) {
    if (s % 15 === 0) E.earlyCurve("RUN", { progress: Math.min(95, 2 + (s / 15) * 4), mcapSol: 30 + s / 10, realSol: 2 + s / 30 }, t0 + s * 1000);
    reads.push(...E.earlySweep(feat, t0 + s * 1000));
  }
  ok(reads.length === 4 && reads.map((r) => r.sec).join(",") === "60,120,180,300", `one read at each age (${reads.map((r) => `${r.sec}s ${r.f.p}%`).join(", ")})`);
  ok(reads.slice(1).every((r) => r.f.r60 === 16) && reads[0].f.r60 === 12, `each read's last minute: +${reads.map((r) => r.f.r60).join(", +")} points (the 60s read: since its first trade)`);
  ok(E.earlyStats.coins === 1 && E.earlyStats.read === 4 && E.earlyStats.dayN === 1, "the daily cap counts coins, not reads (one coin, followed once)");
  ok((E.earlyCoin("RUN", reads[0].at, t0, reads[0].f) as any).es === 60, "the read carries its age");

  // ---- 2. EARLY books per age
  L.gridLiveReset();
  const ex = { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15, mig: "sell" as const };
  const row: any = { key: g.keyOf("r15", "now", ex), filter: "r15", filterLabel: "curve +15 pts in the minute before", mode: "now", modeLabel: "at the call", exit: ex, exitLabel: "", train: {}, test: { n: 20, avgPct: 9 }, pass: false, senders: 0 };
  const b60 = await L.gridLiveEarlyBooks([row], [], Date.now(), 60);
  const b120 = await L.gridLiveEarlyBooks([row], [], Date.now(), 120);
  ok(b60[0]?.key === `early60:${row.key}` && b60[0].earlySec === 60 && b120[0]?.key === `early:${row.key}` && b120[0].earlySec === undefined, `each age its own books (${b60[0]?.key}, ${b120[0]?.key})`);
  L.gridLiveCurve("RUN", { progress: 30, mcapSol: 40, realSol: 8 }, t0 + 60_000);
  const c60 = E.earlyCoin("RUN", reads[1].at, t0, reads[1].f) as unknown as GCoin; // a read with +16 in its last minute
  ok(L.gridLiveEarly("RUN", c60, t0 + 60_000, 60) === 1 && [...L.gridLiveState().pend.keys()].some((k) => k.startsWith("early60:")) && ![...L.gridLiveState().pend.keys()].some((k) => k.startsWith("early:")), "a 60-second read starts only the 60-second books");

  // ---- 3. the EARLY family and probation
  const trips = (key: string, n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ k: key, mint: `T${i}`, symbol: "T", openedAt: i, closedAt: i, pnl: f(i), pnlPct: f(i) * 2000 }) as any);
  const hotKey = `early:${row.key}`;
  L._setTrips(trips(hotKey, 16, (i) => (i % 2 ? 0.02 : -0.004)));
  const hot = L.earlyHot();
  ok(hot?.key === hotKey, "the best EARLY book (16 trips, in profit) is the hot one");
  await L.gridLiveTend(undefined, Date.now());
  const fam = L.gridLiveBooks().filter((b) => b.early && b.parent === hotKey);
  ok(fam.length === 6 && fam.every((b) => b.key.startsWith("early:") && b.filter === "r15"), `it gets its exit family, same filter and age (${fam.length} books)`);
  const st = L.bookStat({ key: hotKey, exit: ex, grid: { testN: 20, testAvg: 9, pass: false, explore: true } }, trips(hotKey, 16, (i) => (i % 2 ? 0.02 : -0.004)));
  ok(st.passed && !!st.probation, "EARLY probation: 15+ trips in profit, also without the 2 best: the desk may follow at the minimum size");
  const lucky = L.bookStat({ key: hotKey, exit: ex, grid: { testN: 20, testAvg: 9, pass: false, explore: true } }, [...trips(hotKey, 15, () => -0.005), ...trips(hotKey, 1, () => 0.4)]);
  ok(!lucky.passed, "one lucky coin carrying the record: no probation");

  // ---- 4. wiring
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/for \(const sec of EARLY_CHECKS\(\)\)/.test(wk) && /archiveEarlyGrid\(10, \{ nulls: sec === 120 \? 2 : 1/.test(wk) && /gridLiveEarly\(r\.mint, .*r\.sec\)/.test(wk), "one EARLY search per age, hourly; live reads go to their age's books");
  const ar = fs.readFileSync("src/lib/archive.ts", "utf8");
  ok(/early_reads2 \(mint text not null, sec integer not null/.test(ar) && /on conflict \(mint, sec\) do nothing/.test(ar), "reads are stored per coin and age (early_reads2)");
  ok(/union all/.test(fs.readFileSync("src/lib/early.ts", "utf8")), "the 2-minute search still reads the reads from before this build");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 117 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.117 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.117 checks pass");
  process.exit(fail ? 1 : 0);
})();
