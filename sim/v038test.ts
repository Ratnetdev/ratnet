// v0.1.38 checks (Run 7). Run: npx tsx sim/v038test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  // one format everywhere
  const f = await import("../src/components/fmt");
  ok(f.usd(950) === "$950" && f.usd(12_400) === "$12.4K" && f.usd(1_250_000) === "$1.25M" && f.usd(-3200) === "-$3.2K", "usd: $950, $12.4K, $1.25M, -$3.2K");
  ok(f.usdK(0) === "–" && f.usdK(54_000) === "$54.0K", "the old usdK name gives the same format");
  ok(f.sol(0.0341, 3, true) === "+0.034 ◎" && f.spct(-3.04) === "-3.0%", "signed SOL and percent");
  ok(f.utc(Date.UTC(2026, 9, 8, 14, 3, 22)) === "14:03:22 UTC", "times say UTC");

  // settings: read at most every 3s, a save is seen at once
  const { K } = await import("../src/lib/redis");
  const st = await import("../src/lib/settings");
  await R.set(K.settings, { desk: { maxOpen: 3 } });
  const a = await st.getSettings();
  await R.set(K.settings, { desk: { maxOpen: 9 } });
  const b = await st.getSettings();
  ok(a.desk.maxOpen === 3 && b.desk.maxOpen === 3, "a second read within 3s comes from memory");
  await st.saveSettings({ desk: { ...b.desk, maxOpen: 7 } } as any);
  ok((await st.getSettings()).desk.maxOpen === 7, "a save is read back at once");

  // one King call per coin: the claim key is taken once
  const first = await R.set("rn:callclaim:FLY", 1, { nx: true, ex: 60 });
  const second = await R.set("rn:callclaim:FLY", 1, { nx: true, ex: 60 });
  ok(!!first && !second, "a second pass cannot claim the same call (the $FLY double call)");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.38 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
