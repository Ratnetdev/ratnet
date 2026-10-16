// v0.1.94: a stream intake batch that hangs no longer stops the intake. Its mints are free again after 15s, a late
// batch writes nothing and does not mark its launches seen (the chain backfill stores them), and the step it hung on
// is named. Run: npx tsx sim/v094test.ts
import { MockRedis } from "./mockredis";
import { Keypair } from "@solana/web3.js";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let NOW = Date.UTC(2026, 9, 16, 18, 20, 0);
Date.now = () => NOW;
const addr = () => Keypair.generate().publicKey.toBase58();
(globalThis as any).__rnConn = {
  getMultipleAccountsInfo: async (keys: any[]) => keys.map(() => null),
  getAccountInfo: async () => null,
  getSignaturesForAddress: async () => [],
  getParsedTransaction: async () => null,
  getBalance: async () => 0,
};
(globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const tick = () => new Promise((r) => setTimeout(r, 30));

async function main() {
  const dg = await import("../src/lib/digger");
  const { K } = await import("../src/lib/redis");
  const fs = await import("fs");
  const item = { mint: addr(), sig: "sigH", creator: addr(), name: "Hang", symbol: "HANG", uri: "", devBuySol: 1, createdAt: NOW };

  // 1. a read that never answers: the batch hangs and says where
  const hmget = R.hmget.bind(R);
  let held: (() => void)[] = [];
  const release = () => (held.splice(0).forEach((f) => f()));
  (R as any).hmget = (...a: any[]) => new Promise((go) => held.push(() => go(hmget(...(a as [any, any])))));
  let hungDone: any = null;
  dg.ingestStream([item]).then((x) => (hungDone = x));
  await tick();
  ok(dg.INTAKE_STEP.step === "meta+curves", `the hung batch names its step (${dg.INTAKE_STEP.step})`);
  (R as any).hmget = hmget;

  // 2. 16s later the next batch with the same launch is not blocked by the hung one's mark
  NOW += 16_000;
  const again: any = await dg.ingestStream([item]);
  const rec: any = await R.get(K.launch(item.mint));
  ok(again.dug === 1 && !!rec, `the next batch stores the launch (dug ${again.dug})`);

  // 3. the hung batch finally answers: it is late, writes nothing over the stored launch
  const before = JSON.stringify(rec);
  release();
  for (let i = 0; i < 20 && !hungDone; i++) await tick();
  ok(hungDone?.dug === 0, `the late batch stores nothing (${JSON.stringify(hungDone)})`);
  ok(JSON.stringify(await R.get(K.launch(item.mint))) === before, "the stored launch is untouched");

  // 4. a late batch alone does not mark its launch seen (the chain backfill stores it)
  const item2 = { ...item, mint: addr(), sig: "sigL" };
  (R as any).hmget = (...a: any[]) => new Promise((go) => held.push(() => go(hmget(...(a as [any, any])))));
  let done2: any = null;
  dg.ingestStream([item2]).then((x) => (done2 = x));
  await tick();
  NOW += 16_000;
  release();
  for (let i = 0; i < 20 && !done2; i++) await tick();
  (R as any).hmget = hmget;
  ok(done2?.dug === 0 && !(await R.get(K.launch(item2.mint))), "a late batch writes nothing");
  ok(!(await R.get("rn:sig:sigL")), "and does not mark the launch seen");
  ok(!!(await R.get("rn:sig:sigH")), "a stored launch is marked seen");

  // 5. the worker limits every batch and reports the intake on /status
  const w = fs.readFileSync("worker/index.ts", "utf8");
  ok(/intake batch over/.test(w) && /DIGGING_MS\)\)\)/.test(w), "the worker gives each intake batch DIGGING_MS");
  ok(/intake: intakeNote\(\)/.test(w), "the stream note shows the intake");
  ok(/INTAKE\.length >= INTAKE_MAX/.test(w), "the intake queue is capped");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 94 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.94 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.94 checks pass");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
