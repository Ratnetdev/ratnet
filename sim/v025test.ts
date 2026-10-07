// v0.1.25 checks: owned locks that renew while work runs, the fallback dig stepping aside while the worker lives,
// lessons parked (never trained unlocked) when the trainer lock is busy, every fetch with a deadline, the daily RPC
// counter and the historian's cap. Run: npx tsx sim/v025test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { withLock, acquire, release } = await import("../src/lib/lock");

  // --- 1. a lock renews itself while the work runs past its TTL, and nobody else gets in meanwhile
  let second: any = null;
  const first = withLock("rn:lock:t", 1200, async () => {
    await sleep(800);
    second = await withLock("rn:lock:t", 1200, async () => "ran");
    await sleep(1500); // past the TTL: only renewal keeps it
    return "done";
  });
  await sleep(2000); // the first is now 2s in, past its 1.2s TTL
  const third = await withLock("rn:lock:t", 1200, async () => "ran");
  ok((second as any)?.skipped === "busy" && (third as any)?.skipped === "busy", `a second holder is refused while the first works past its TTL (${JSON.stringify(second)} ${JSON.stringify(third)})`);
  ok((await first) === "done", "the first holder finished");
  const fourth = await withLock("rn:lock:t", 1200, async () => "ran");
  ok(fourth === "ran", "released after the work: the next holder gets it");

  // --- 2. the fallback dig steps aside while the worker is alive
  const { dig, applyNano, loadModel } = await import("../src/lib/digger");
  await R.set("rn:worker:at", Date.now());
  const d: any = await dig();
  ok(d?.skipped === "worker", "fallback dig steps aside while the worker is alive");

  // --- 3. lessons are parked when the trainer lock is busy, and learned by the next holder
  const { K } = await import("../src/lib/redis");
  const x = Array.from({ length: 41 }, (_, i) => (i % 3) / 3);
  const held = await acquire("rn:lock:nano", 60_000);
  const t0 = Date.now();
  await applyNano([{ k: 0, x, y: true }, { k: 0, x, y: false }]);
  const waited = Date.now() - t0;
  const parked = await R.llen("rn:nano:pending");
  const m0 = await loadModel(K.nano);
  ok(parked === 2 && m0.n === 0, `busy trainer: 2 lessons parked, none trained without the lock (waited ${waited}ms)`);
  await release(held!);
  await applyNano([{ k: 0, x, y: true }]);
  const m1 = await loadModel(K.nano);
  ok(m1.n === 3 && (await R.llen("rn:nano:pending")) === 0, `next holder learned the parked lessons too (model n ${m1.n})`);

  // --- 4. every fetch without a signal gets a deadline
  let sawSignal = false;
  (globalThis as any).__rnFetchGuard = false;
  (globalThis as any).fetch = async (_u: any, init: any) => {
    sawSignal = !!init?.signal;
    return new Response("{}");
  };
  const { installFetchGuard } = await import("../src/lib/fetchguard");
  installFetchGuard();
  await fetch("http://x.test/a");
  ok(sawSignal, "a bare fetch gets a timeout signal");

  // --- 5. the daily RPC counter and the historian's cap
  const { rpcStats } = await import("../src/lib/solana");
  const { flushRpcDay, rpcDayView, historianCapped, HIST_PER_DAY } = await import("../src/lib/rpcday");
  rpcStats.byLane[0] += 100;
  rpcStats.byLane[3] += HIST_PER_DAY;
  await flushRpcDay();
  const v = await rpcDayView();
  ok(v.today === 100 + HIST_PER_DAY && Number(v.byLane.desk) === 100, `calls today counted per lane (${v.today})`);
  ok(await historianCapped(), "the historian stops at its daily cap");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.25 checks passed");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
