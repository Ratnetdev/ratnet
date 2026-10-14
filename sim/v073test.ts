// v0.1.73: GRID runs every 3 hours even when REPLAY's timer fires at the same moment. Run: npx tsx sim/v073test.ts
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/const gridDue = async \(\) => \{\n\s+if \(gridding \|\| replaying \|\| Date\.now\(\) - gridAt < 3 \* 3600_000\) return;\n\s+gridAt = Date\.now\(\);\n\s+await grid\(\);/.test(wk), "GRID runs once 3 hours have passed since its last run, and only when REPLAY is not running");
  ok(/setInterval\(\(\) => gridDue\(\)\.catch\(\(\) => null\), 5 \* 60_000\)/.test(wk) && !/setInterval\(\(\) => grid\(\)\.catch/.test(wk), "checked every 5 minutes (the old 3-hour timer that collided with REPLAY is gone)");

  // the same logic on a simulated day: REPLAY runs 10 minutes every 3 hours, starting at the same moments as before
  const H = 3600_000;
  let now = 0, replaying = false, gridding = false, gridAt = 0;
  const runs: number[] = [];
  const due = () => {
    if (gridding || replaying || now - gridAt < 3 * H) return;
    gridAt = now;
    runs.push(now);
  };
  for (now = 0; now <= 24 * H; now += 60_000) {
    replaying = now % (3 * H) < 10 * 60_000 && now >= 3 * 60_000; // REPLAY at start + every 3h, 10 minutes long
    if (now === 8 * 60_000 || now % (5 * 60_000) === 0) due();
  }
  ok(runs.length >= 7, `GRID ran ${runs.length} times in 24 hours (was once)`);
  ok(runs.every((t, i) => i === 0 || t - runs[i - 1] >= 3 * H), "never more often than every 3 hours");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version && BUILD === "0.1.73", `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
