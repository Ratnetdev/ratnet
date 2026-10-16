// v0.1.91: a chain read always refreshes a stale firehose entry (a coin that traded once, then went quiet, was read
// from the chain on every pass and never kept: ~10K post-pick reads an hour, 12% of pool reads saved); the X budget
// guard trips at 92% and LENS looks ahead at the hour's pace. Run: npx tsx sim/v091test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const FC = await import("../src/lib/firecache");
  FC._fcReset();
  const t0 = Date.now();
  FC.fcConnected(t0);
  const cv = { progress: 40, mcapSol: 80, realSol: 20, complete: false, priceSol: 8e-8, supply: 1e9 };
  FC.fcCurveTrade("Q", cv, 500, t0 - 11 * 60_000); // traded once, 11 minutes ago
  ok(FC.fcCurve("Q", t0) === null, "quiet past the 10-minute guard: read from the chain");
  FC.fcCurveBase("Q", { ...cv, progress: 41 }, t0 - 5);
  ok(FC.fcCurve("Q", t0)?.progress === 41, "the chain read is kept (it was refused: the old trade's order was higher)");
  FC.fcCurveTrade("Q", { ...cv, progress: 45 }, 501, t0 + 1000);
  ok(FC.fcCurve("Q", t0 + 1000)?.progress === 45, "the coin's next trade still replaces it");
  FC.fcCurveTrade("Q", { ...cv, progress: 30 }, 499, t0 + 1100);
  ok(FC.fcCurve("Q", t0 + 1100)?.progress === 45, "an older trade arriving late does not");
  FC.fcPoolTrade("P", { pool: "x", sol: 300, tok: 5e7, px: 6e-6 }, 900, t0 - 2 * 60_000);
  ok(FC.fcPool("P", t0) === null, "a pool quiet past 60s: read from the chain");
  FC.fcPoolBase("P", { pool: "x", sol: 310, tok: 4.9e7, px: 6.3e-6 }, t0 - 5);
  ok(FC.fcPool("P", t0)?.sol === 310, "pools too");
  FC.fcCurveTrade("R", cv, 600, t0);
  FC.fcCurveBase("R", { ...cv, progress: 10 }, t0 - 5000);
  ok(FC.fcCurve("R", t0)?.progress === 40, "a trade that landed after the read was sent still wins");

  const wire = fs.readFileSync(new URL("../src/lib/wire.ts", import.meta.url), "utf8");
  ok(/used\.thisHour < X_BUDGET \* 0\.92\)/.test(wire), "the X guard switches the paid rules off at 92% of the hour");
  const xc = fs.readFileSync(new URL("../src/lib/xcredits.ts", import.meta.url), "utf8");
  const lens = fs.readFileSync(new URL("../src/lib/lens.ts", import.meta.url), "utf8");
  ok(/export async function xAllowed\(share = 1, project = false\)/.test(xc) && /if \(pace >= X_BUDGET \* 0\.95\) return false;/.test(xc) && /xAllowed\(0\.7, true\)/.test(lens), "LENS stops when the hour's pace would pass the budget");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const bld = fs.readFileSync(new URL("../src/config/build.ts", import.meta.url), "utf8");
  ok(pkg.version === bld.match(/"([0-9.]+)"/)![1], "build tag matches the package");
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
