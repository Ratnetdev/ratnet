// v0.1.64: ARENA tells when a variant passes its exam (once). Run: npx tsx sim/v064atest.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const a = await import("../src/lib/arena");
  const v = (passed: boolean) => [{ id: "nonano", label: "King, no nano rule", passed, n: 30, winRate: 53, pnlPct: 14.2, pfLessBest: 1.6, dd: 12 }];
  ok((await a.arenaPassAlert(v(false))).length === 0, "nothing said before a pass");
  const said = await a.arenaPassAlert(v(true));
  ok(said.length === 1 && /passed the exam: 30 trips, 53% won, \+14\.2%/.test(said[0]), `said once: ${said[0]}`);
  ok((await a.arenaPassAlert(v(true))).length === 0, "never repeated");
  const ev: any[] = (await R.lrange("rn:desk:ev", 0, 5)) as any[];
  ok(ev.some((e) => /Ready for live, small/.test(e.text)), "in the desk log");
  const fs = await import("fs");
  const bm = fs.readFileSync(new URL("../src/lib/bwmeter.ts", import.meta.url), "utf8");
  ok(/if \(!bwLimited\(\)\) return;/.test(bm), "no bandwidth alerts on Railway's Redis");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
