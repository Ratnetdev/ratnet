// v0.1.73: GRID runs every hour even when REPLAY's timer fires at the same moment; GRID LIVE keeps books until their record decides. Run: npx tsx sim/v073test.ts
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/const gridDue = async \(\) => \{\n\s+if \(gridding \|\| replaying \|\| Date\.now\(\) - gridAt < 3600_000\) return;\n\s+gridAt = Date\.now\(\);\n\s+await grid\(\);/.test(wk), "GRID runs once an hour has passed since its last run, and only when REPLAY is not running");
  ok(/setInterval\(\(\) => gridDue\(\)\.catch\(\(\) => null\), 5 \* 60_000\)/.test(wk) && !/setInterval\(\(\) => grid\(\)\.catch/.test(wk), "checked every 5 minutes (the old 3-hour timer that collided with REPLAY is gone)");

  // the same logic on a simulated day: REPLAY runs 10 minutes every 3 hours, starting at the same moments as before
  const H = 3600_000;
  let now = 0, replaying = false, gridding = false, gridAt = 0;
  const runs: number[] = [];
  const due = () => {
    if (gridding || replaying || now - gridAt < H) return;
    gridAt = now;
    runs.push(now);
  };
  for (now = 0; now <= 24 * H; now += 60_000) {
    replaying = now % (3 * H) < 10 * 60_000 && now >= 3 * 60_000; // REPLAY at start + every 3h, 10 minutes long
    if (now === 8 * 60_000 || now % (5 * 60_000) === 0) due();
  }
  ok(runs.length >= 20, `GRID ran ${runs.length} times in 24 hours (was once)`);
  ok(runs.every((t, i) => i === 0 || t - runs[i - 1] >= H), "never more often than every hour");
  // ---- GRID LIVE keeps its books until their live record decides them
  const { MockRedis } = await import("./mockredis");
  (globalThis as any).__rnRedis = new MockRedis();
  const L = await import("../src/lib/gridlive");
  const g = await import("../src/lib/grid");
  L.gridLiveReset();
  const ex = { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15, mig: "sell" as const };
  const S = { n: 20, wins: 8, winRate: 40, avgPct: 5, pnl: 0.05, pfLessBest: 1.3 };
  const row = (f: string) => ({ key: g.keyOf(f, "now", ex), filter: f, filterLabel: f, mode: "now", modeLabel: "now", exit: ex, exitLabel: "", train: S, test: S, pass: false, senders: 0 });
  let b: any = await L.gridLiveSetBooks(["bond", "sm", "u20"].map(row) as any);
  ok(b.length === 3 && L.LIVE_MAX_BOOKS === 16, "16 slots; 3 strategies go live");
  // "bond" collects a losing record, "sm" is halfway and fine
  const st = L.gridLiveState();
  const push = (k: string, pnl: number, n: number) => { for (let i = 0; i < n; i++) st.trips.push({ k, mint: `${k}${i}`, symbol: "x", openedAt: 0, closedAt: i, pnl, pnlPct: (pnl / 0.056) * 100, why: "t" }); };
  push(row("bond").key, -0.008, 12); // -14% avg after 12
  push(row("sm").key, 0.004, 12);
  b = await L.gridLiveSetBooks(["p70", "u50"].map(row) as any);
  const keys = b.map((x: any) => x.filter);
  ok(keys.includes("sm") && keys.includes("u20"), "books still collecting stay, even when GRID no longer ranks them");
  ok(!keys.includes("bond") && b.dropped.some((d: any) => /losing live/.test(d.why)), "a book with a losing live record is dropped");
  ok(keys.includes("p70") && keys.includes("u50"), "new GRID candidates fill the free slots");
  b = await L.gridLiveSetBooks(["bond"].map(row) as any);
  ok(!b.some((x: any) => x.filter === "bond"), "a strategy its live record ruled out never comes back");
  ok(L.dropReason({ n: 30, wins: 10, winRate: 33, avgPct: 1, pnl: 0.02, pfLessBest: 1.1, passed: false }) === "30 trips without passing the exam", "30 trips without a pass frees the slot");
  ok(L.dropReason({ n: 30, wins: 15, winRate: 50, avgPct: 9, pnl: 0.15, pfLessBest: 1.5, passed: true }) === null, "a passed strategy stays for good");

  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
