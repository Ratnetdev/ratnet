// v0.1.62: stalks without the launch record, written only when they change. Run: npx tsx sim/v062test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const { K } = await import("../src/lib/redis");
  const d = await import("../src/lib/desk");
  let writes = 0, reads = 0;
  const hset = R.hset.bind(R), hgetall = R.hgetall.bind(R);
  (R as any).hset = async (...x: any[]) => (writes++, hset(...x));
  (R as any).hgetall = async (...x: any[]) => (reads++, hgetall(...x));
  const big = { mint: "M", description: "a long description", tape: { early: Array(25).fill("wallet") }, cp: { t1: {}, t5: {} } } as any;
  await d.putStalk({ mint: "M", symbol: "X", at: Date.now(), px0: 1, depth: 12, hi: 1, lo: 1, armed: false, early: false, how: "momo", rec: big, mins: 10 } as any, true);
  const stored: any = (await hgetall(K.deskStalk))?.M;
  ok(stored && !stored.rec && stored.desc === "a long description", "a stalk is stored without the launch record (its description kept)");
  writes = 0;
  for (let i = 0; i < 20; i++) await d.putStalk({ ...stored, hi: 1.001, lo: 1 });
  ok(writes <= 1, `20 beats of a stalk that barely moved: ${writes} write(s) (was 20)`);
  await d.putStalk({ ...stored, hi: 1.05, lo: 1 });
  await d.putStalk({ ...stored, hi: 1.05, lo: 1, armed: true });
  ok(writes >= 2, "a real move (1%+) or arming is written");
  reads = 0;
  for (let i = 0; i < 20; i++) await d.loadStalks();
  ok(reads <= 1, `20 beats read the stalks from Redis ${reads} time(s) (every 15 seconds, was every beat)`);
  // the other Redis costs found in the worker's hourly breakdown (9 Oct)
  const fs = await import("fs");
  const w = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  const hf = fs.readFileSync(new URL("../src/lib/heliusfeed.ts", import.meta.url), "utf8");
  ok(/max: CURVE_MAX, pools: false/.test(w) && /opts\.pools !== false/.test(hf), "the launch-curve feed never looks up pool vaults (28MB an hour)");
  const dg = fs.readFileSync(new URL("../src/lib/digger.ts", import.meta.url), "utf8");
  ok((dg.match(/laneOpen\(1\) \? await wirePicks\(\)/g) || []).length === 2, "post picks wait while the rats' budget is closed (they failed and re-read the posts every second)");
  // an open post older than 30 minutes is dropped before the pass reads candidates
  const { dueTweets } = await import("../src/lib/wire");
  await R.zadd("rn:x:open", { score: Date.now() - 40 * 60_000, member: "old" });
  await R.zadd("rn:x:open", { score: Date.now() - 60_000, member: "new" });
  const due = await dueTweets();
  ok(due.length === 1 && due[0].tid === "new", "a post open for 30+ minutes is dropped");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.62 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
