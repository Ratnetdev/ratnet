// v0.1.61: the desk takes ARENA's better entry rules once; ARENA writes less. Run: npx tsx sim/v061test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const { getSettings, saveSettings } = await import("../src/lib/settings");
  const d = await import("../src/lib/desk");
  const cur = await getSettings();
  await saveSettings({ desk: { ...cur.desk, needNano: true, mode: "paper" } as any });
  ok((await d.fixOnce061()) === true, "the switch runs once");
  const s1: any = (await getSettings()).desk;
  ok(s1.needNano === false && s1.momoPullback === 0 && s1.mode === "paper", "King calls no longer need nano, MOMO buys at the signal, the desk stays on paper");
  await saveSettings({ desk: { ...s1, needNano: true } as any });
  ok((await d.fixOnce061()) === false && ((await getSettings()).desk as any).needNano === true, "a later change in Admin is never overwritten");

  const a = await import("../src/lib/arena");
  let writes = 0;
  const hset = R.hset.bind(R);
  (R as any).hset = async (...x: any[]) => (writes++, hset(...x));
  const p: any = { arena: "nonano", mint: "M", symbol: "X", series: [], tokens: 1 };
  await a.arenaSave(p, false);
  await a.arenaSave(p, false);
  await a.arenaSave(p, false);
  ok(writes === 1, `an unchanged position is written at most once a minute (${writes} writes for 3 beats)`);
  await a.arenaSave(p, true);
  ok(writes === 2, "a sell writes at once");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.61 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
