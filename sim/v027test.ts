// v0.1.27 check: the homepage's exam summary and the desk page's cached full exam live under different keys, so the
// desk payload always carries the exam with its checks. Run: npx tsx sim/v027test.ts
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
  (globalThis as any).__rnConn = { getBalance: async () => 0, getSlot: async () => 1 };
  // the homepage summary, as the desk loop writes it
  await R.set(K.deskExam, { at: Date.now(), live: false, passed: 3, total: 5, checks: [] }, { ex: 600 });
  const { getDesk } = await import("../src/lib/desk");
  const d: any = await getDesk();
  ok(Array.isArray(d.exam?.checks) && d.exam.checks.length === 5, `desk payload has the full exam (${d.exam?.checks?.length} checks)`);
  const summary: any = await R.get(K.deskExam);
  ok(summary && summary.total === 5 && !summary.ex, "the homepage summary is left as it was");
  const again: any = await getDesk();
  ok(Array.isArray(again.exam?.checks), "second read (from the cache) still has the checks");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.27 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
