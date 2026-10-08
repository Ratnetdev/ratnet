// v0.1.50: PM's pause brake. A win never pauses a strategy, and the brake counts trades since v0.1.50 only.
// Run: npx tsx sim/v050test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const pm = await import("../src/lib/pm");
  const L = Math.log;
  // the live state on 8 Oct: MOMO's record full of bug-era losses, paused at 22:14 UTC by the $ERARI win
  const old = [L(0.94), L(0.94), L(0.94), L(0.6), L(0.55), L(0.5)];
  await R.set("rn:desk:pm", { momo: { r: old, pausedUntil: Date.now() + 3600_000, n: 9, wins: 3 } });
  const w0 = await pm.sleeveWeight("momo");
  ok(!w0.paused, "the pause the old rule set is lifted once on deploy");
  const st: any = await R.get("rn:desk:pm");
  ok(st.momo.r.length === 6 && st.momo.n === 9, "what PM learned for sizing is kept (returns, trade count)");

  // a win right after: no pause (this is what paused MOMO)
  const n1 = await pm.onClose("momo", L(1.044));
  ok(!(await pm.sleeveWeight("momo")).paused && !/paused/.test(n1 || ""), "a winning trade never pauses the strategy");

  // the brake still works on real losses since v0.1.50
  for (let i = 0; i < 4; i++) await pm.onClose("momo", L(0.7));
  ok(!(await pm.sleeveWeight("momo")).paused, "5 trades since the fix: not enough for the brake");
  const n2 = await pm.onClose("momo", L(0.7));
  ok((await pm.sleeveWeight("momo")).paused && /paused for 2 hours/.test(n2 || ""), "6 trades since the fix losing more than 60% together: paused");

  // the once-only lift does not repeat
  const st2: any = await R.get("rn:desk:pm");
  ok(st2.momo.v === 50 && st2.momo.pausedUntil > Date.now(), "a new pause stays (the lift ran once)");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.50 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
