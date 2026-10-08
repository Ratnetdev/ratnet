// v0.1.39 checks (Run 8). Run: npx tsx sim/v039test.ts
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
  const d = await import("../src/lib/desk");
  // final reset: never while live, once, the record archived, PM pauses cleared, learning kept
  await R.set(K.deskState, { live: true });
  ok((await d.resetOnceForFinal()) === false, "no reset while the desk trades real money");
  await R.set(K.deskState, { live: false, start: 1, cash: 0.9, equity: 0.95, closed: 9 });
  await R.lpush("rn:desk:trips", { mint: "OLD" });
  await R.rpush(K.deskTrades, { id: "x", mint: "OLD", side: "buy", at: 1, sol: 0.05 });
  await R.set("rn:desk:pm", { momo: { r: [-0.5, -0.4], pausedUntil: Date.now() + 3600_000, n: 2, wins: 0 } });
  await R.set(K.nano, { w: [1, 2, 3], n: 4516 });
  ok((await d.resetOnceForFinal()) === true, "the paper desk resets for the final run");
  ok(Number(await R.llen(K.deskTrades)) === 0 && Number(await R.llen("rn:desk:trips")) === 0, "the old trades leave the page");
  const keys = Array.from((R as any).kv.keys()) as string[];
  ok(keys.some((k) => k.startsWith("rn:desk:trips:")), "and are archived");
  const pm: any = await R.get("rn:desk:pm");
  ok(pm.momo.pausedUntil === 0 && pm.momo.r.length === 2, "paused strategies start unpaused; PM's record is kept");
  ok(((await R.get(K.nano)) as any)?.n === 4516, "the King's model is untouched");
  ok((await d.resetOnceForFinal()) === false, "only once");

  // the queues of LENS and MIND cannot grow without end
  const { enqueueLens } = await import("../src/lib/lens");
  const p = R.pipeline();
  for (let i = 0; i < 350; i++) enqueueLens(p as any, `M${i}`, "bond" as any);
  await p.exec();
  ok(Number(await R.zcard("rn:lens:q")) <= 300, `the LENS queue keeps its 300 most urgent coins (${await R.zcard("rn:lens:q")})`);

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.39 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
