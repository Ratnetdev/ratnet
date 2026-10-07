// v0.1.26 checks: big slow-changing reads cached in memory, critical outages sent to Telegram once (plus the
// recovery line). Run: npx tsx sim/v026test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const sent: string[] = [];
(globalThis as any).fetch = async (u: any, init: any) => {
  if (String(u).includes("api.telegram.org")) sent.push(JSON.parse(init.body).text);
  return new Response("{}");
};
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.TELEGRAM_IDEAS_CHAT_ID = "1";

async function main() {
  // --- 1. memo: one load per TTL, concurrent callers share it
  const { memo, memoPatch } = await import("../src/lib/memo");
  let loads = 0;
  const load = async () => {
    loads++;
    await new Promise((r) => setTimeout(r, 20));
    return { a: 1 } as Record<string, number>;
  };
  await Promise.all([memo("k", 1000, load), memo("k", 1000, load), memo("k", 1000, load)]);
  await memo("k", 1000, load);
  memoPatch("k", { b: 2 });
  const v = await memo("k", 1000, load);
  ok(loads === 1 && v.b === 2, `4 reads, 1 load; a local write patches the cache (${loads} loads)`);

  // --- 2. WIRE: ingesting posts no longer reads the whole account list each time
  const { ingest } = await import("../src/lib/wire");
  const big: Record<string, unknown> = {};
  for (let i = 0; i < 3000; i++) big[`acc${i}`] = { h: `acc${i}`, cat: "j7", tier: "j7", added: 1 };
  await R.hset("rn:x:acc", big);
  await R.set("rn:x:seedn", (await import("../src/config/x-accounts")).X_SEED.length);
  const before = R.calls;
  let hgetalls = 0;
  const orig = R.hgetall.bind(R);
  (R as any).hgetall = async (k: string) => {
    if (k === "rn:x:acc") hgetalls++;
    return orig(k);
  };
  for (let i = 0; i < 10; i++) await ingest([{ id: `t${i}`, h: `acc${i}`, text: "hello world", at: Date.now(), f: 10 } as any]);
  ok(hgetalls <= 1, `10 ingests read the account list ${hgetalls} time(s) (was 10)`);
  void before;

  // --- 3. critical alerts: one blip is not an outage; two failures alert once; recovery says so
  const { noteCheck } = await import("../src/lib/critical");
  await noteCheck("redis", false, "ERR This database has reached current Fixed plan limits");
  ok(sent.length === 0, "one failed check: no alert yet");
  await noteCheck("redis", false, "ERR This database has reached current Fixed plan limits");
  await noteCheck("redis", false, "ERR This database has reached current Fixed plan limits");
  ok(sent.length === 1 && /Redis/.test(sent[0]) && /Fixed plan limits/.test(sent[0]), "two failures: one Telegram alert with the reason");
  await noteCheck("redis", true);
  ok(sent.length === 2 && /back/.test(sent[1]), "recovery: one line");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.26 checks passed");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
