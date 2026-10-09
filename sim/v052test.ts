// v0.1.52: minute-1 reads and minute-5 calls keep running when the rats' share of the chain budget is used.
// Run: npx tsx sim/v052test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
(globalThis as any).fetch = async () => new Response("{}");
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const { K } = await import("../src/lib/redis");
  const dg = await import("../src/lib/digger");
  const sol = await import("../src/lib/solana");
  const b = sol.budgetState();
  if (b.pace * 1.06 >= sol.DAY_BUDGET) {
    console.log("skip: late in the UTC day the pace equals the whole budget, run again earlier");
    process.exit(0);
  }
  const now = Date.now();
  await R.zadd(K.due, { score: now - 2_000, member: "CALLME|t5" });
  await R.zadd(K.due, { score: now - 2_000, member: "README|t1" });
  await R.zadd(K.due, { score: now - 2_000, member: "LATER|h1" });
  await R.zadd(K.due, { score: now - 3 * 3600_000, member: "OLD|d1" });
  // the rats' share used (over 105% of pace), the day still has room
  sol.seedDayUsed(new Date().toISOString().slice(0, 10), Math.ceil(b.pace * 1.06));
  ok(!sol.laneOpen(1) && sol.dayRoom(), "rats paused, the day has room");
  const res: any = await dg.processDue({} as any);
  const left = ((await R.zrange(K.due, 0, -1)) || []) as string[];
  ok(/calls only/.test(String(res.due)), `the pass runs in calls-only mode (${res.due})`);
  ok(!left.includes("CALLME|t5") && !left.includes("README|t1"), "the minute-5 call and the minute-1 read were taken");
  ok(left.includes("LATER|h1") && left.includes("OLD|d1"), "the 1h and 1d outcome checks wait for the rats' budget");

  // the whole day used: nothing more
  sol.seedDayUsed(new Date().toISOString().slice(0, 10), sol.DAY_BUDGET + 1);
  await R.zadd(K.due, { score: Date.now() - 1000, member: "CALL2|t5" });
  const r2: any = await dg.processDue({} as any);
  const left2 = ((await R.zrange(K.due, 0, -1)) || []) as string[];
  ok(/whole day/.test(String(r2.due)) && left2.includes("CALL2|t5"), "the day's whole budget is the hard ceiling");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.52 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
