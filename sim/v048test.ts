// v0.1.48: WIRE trust (bots never trade, unknown accounts earn trust), the one-time fix (MOMO unpaused, cost defaults).
// Run: npx tsx sim/v048test.ts
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
  const w = await import("../src/lib/wire");
  ok(w.weightOf({ h: "AutorunAlert", cat: "found", tier: "j7" } as any, {}) === 0, "an alert bot never sends a coin to the desk");
  ok(w.weightOf({ h: "someone", cat: "found", tier: "j7" } as any, {}) < 0.2, "an unknown account from the feed starts under the bar");
  ok(w.weightOf({ h: "someone", cat: "found", tier: "j7" } as any, { "someone:picks": 6, "someone:runs": 3 }) >= 0.2, "and earns it with coins that ran (3 of 6)");
  ok(w.weightOf({ h: "theunipcs", cat: "trader", tier: "seed" } as any, {}) >= 0.2, "seed accounts keep their trust");

  const { K } = await import("../src/lib/redis");
  const d = await import("../src/lib/desk");
  const { saveSettings, getSettings } = await import("../src/lib/settings");
  await saveSettings({ desk: { ...(await getSettings()).desk, jitoTipMinSol: 0.0003, paperPrioritySol: 0.0005 } } as any);
  await R.set("rn:desk:pm", { momo: { r: [-0.06, -0.06, -0.4], pausedUntil: Date.now() + 3600_000, n: 3, wins: 0 } });
  ok((await d.fixOnce048()) === true, "the fix runs once on deploy");
  const s = (await getSettings()).desk as any;
  const pm: any = await R.get("rn:desk:pm");
  ok(s.jitoTipMinSol === 0.0001 && s.paperPrioritySol === 0.0003, "saved costs on the old defaults move to the new ones");
  ok(pm.momo.pausedUntil === 0 && pm.momo.r.length === 3, "MOMO unpaused, its record kept");
  ok((await d.fixOnce048()) === false, "only once");
  void K;
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.48 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
