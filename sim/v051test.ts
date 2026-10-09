// v0.1.51: the due pass no longer re-reads Redis every second while the chain budget is closed. Run: npx tsx sim/v051test.ts
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
  const now = Date.now();
  // a backlog of 500 old checks (hours old) and nothing fresh
  for (let i = 0; i < 500; i++) await R.zadd(K.due, { score: now - 3 * 3600_000 + i, member: `M${i}|h1` });
  const calls: any[] = [];
  const zr = R.zrange.bind(R);
  (R as any).zrange = async (...a: any[]) => {
    calls.push(a);
    return zr(...a);
  };
  const model: any = {};
  await dg.processDue(model);
  const oldCall = calls.find((a) => a[0] === K.due && a[1] === 0);
  ok(!!oldCall && oldCall[3]?.count <= 60, `the backlog drains at most 60 checks per pass (asked for ${oldCall?.[3]?.count})`);
  calls.length = 0;
  await dg.processDue(model);
  ok(!calls.some((a) => a[0] === K.due && a[1] === 0), "and only every 5 seconds (the next pass a moment later skips the backlog)");

  // an error: the pass backs off for 30 seconds instead of retrying every second
  (R as any).zrange = async () => {
    throw new Error("boom");
  };
  let threw = false;
  try {
    await dg.processDue(model);
  } catch {
    threw = true;
  }
  let n = 0;
  (R as any).zrange = async (...a: any[]) => {
    n++;
    return zr(...a);
  };
  const r2: any = await dg.processDue(model);
  ok(threw && n === 0 && /backing off/.test(r2.due), "after an error the next pass waits 30s, no Redis reads");

  // the chain budget closed for the rats: no Redis reads at all (it was ~1MB a second for hours)
  sol.seedDayUsed(new Date().toISOString().slice(0, 10), 10_000_000);
  ok(!sol.laneOpen(1), "budget closed");
  const r3: any = await dg.processDue(model);
  ok(n === 0 && /chain budget/.test(r3.due), "with the budget closed the pass waits without touching Redis");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.51 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
