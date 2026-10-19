// v0.1.125 RECORDS SURVIVE RESTARTS: GRID LIVE's paper trips are merged back from the archive at boot.
// Run: npx tsx sim/v125test.ts
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
  L.gridLiveReset();
  const K = "any:pw1+bs70|now|2/0.5/0.35/60/hold/k0.3h24";
  L._setBooks([{ key: K, cold: null } as any]);
  const t = (i: number, ms = 0) => ({ k: K, mint: `M${i}`, symbol: "M", openedAt: 1_790_000_000_000 + i * 60_000, closedAt: 1_790_000_000_000 + i * 60_000 + 30_000 + ms, pnl: -0.01, pnlPct: -20, why: "stop" });
  // the Redis list came back with the newest 63; the archive holds all 121
  L._setTrips(Array.from({ length: 63 }, (_, i) => t(120 - i)).map((x) => x as any));
  const arch = Array.from({ length: 121 }, (_, i) => t(120 - i, 400)); // close times off by under a second (Postgres)
  const n = L.gridLiveBackfill(arch as any);
  const mine = L.gridLiveState().trips.filter((x: any) => x.k === K);
  ok(n === 58 && mine.length === 121, `58 lost trips restored, none counted twice (${mine.length} in the record)`);
  ok(mine.every((x: any, i: number) => i === 0 || mine[i - 1].closedAt >= x.closedAt), "newest first, as the exams read them");
  ok(L.gridLiveBackfill(arch as any) === 0, "a second run adds nothing");
  ok(L.gridLiveBackfill([]) === 0, "an empty archive changes nothing");
  const ar = fs.readFileSync("src/lib/archive.ts", "utf8");
  ok(/partition by book order by closed_at desc/.test(ar) && /book like 'grid:%'/.test(ar), "the archive returns the newest 400 per strategy");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/archiveGridTrips\(14, 400\)/.test(wk) && /gridLiveBackfill\(rows/.test(wk), "the worker merges them in once the archive is connected");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 125 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.125 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.125 checks pass");
  process.exit(fail ? 1 : 0);
})();
