// v0.1.43 (Run 11): the falling-knife rule, King calls nano does not back go to the ghost desk, and the one paper
// restart (needNano on, "auto" becomes "paper", learning kept). Run: npx tsx sim/v043test.ts
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
  const { DEFAULT_SETTINGS } = await import("../src/config/site");
  const cfg: any = DEFAULT_SETTINGS.desk;

  // 1. falling knife
  const kv = d.knifeVerdict;
  ok(!kv([1.0, 1.01, 1.02], [0.98, 1.0], null, cfg).falling, "rising: buy");
  ok(kv([0.88, 0.88, 0.87], [1.0, 0.97, 0.9], null, cfg).falling, "13% under the last minute's high: no buy");
  const sl = kv([1.0, 0.985, 0.965], [1.0], null, cfg);
  ok(sl.falling && /three lower/.test(sl.why), "three lower prices, 3.5% down in 3 seconds: no buy");
  ok(!kv([1.0, 0.995, 0.99], [1.0], null, cfg).falling, "a 1% wobble is not a fall");
  ok(kv([1, 1, 1], [1], { span: 45, mcCh60: -14, s20: 30, b20: 12 }, cfg).falling, "tape: -14% in a minute with sellers in charge: no buy");
  ok(!kv([1, 1, 1], [1], { span: 45, mcCh60: -14, s20: 8, b20: 20 }, cfg).falling, "tape down but buyers back in charge: buy");
  ok(kv([0.9, 0.93, 0.95], [1.0], null, cfg).px === 0.95, "the entry uses the newest price");

  // 2. a King call nano does not back: ghost desk, not skipped
  ok(d.ghostable(["nano_agrees"]), "nano not agreeing: the ghost desk follows the call");
  ok(d.ghostable(["nano_agrees", "daily_loss_ok"]), "nano plus the loss limit: still ghost");
  ok(!d.ghostable(["nano_agrees", "bundle_ok"]), "a bad coin (bundle) is skipped everywhere");
  ok(!d.ghostable([]), "a clean signal is not a ghost trade");

  // 3. the restart: settings switched, books cleared, learning kept, once
  const { saveSettings, getSettings } = await import("../src/lib/settings");
  await saveSettings({ desk: { ...(await getSettings()).desk, mode: "auto", needNano: false } } as any);
  await R.set(K.deskState, { live: true });
  ok((await d.resetOnceForNano()) === false, "no restart while the desk trades real money");
  ok((await getSettings()).desk.mode === "auto", "and the settings stay as they are");
  await R.set(K.deskState, { live: false, start: 0.625, cash: 0.448, equity: 0.448, closed: 15 });
  await R.lpush("rn:desk:trips", { mint: "OLD" });
  await R.set(K.deskLearn, { trailK: 0.9, arms: {} });
  await R.set(K.nano, { w: [1, 2], n: 900 });
  await R.lpush("rn:ghost:trades", { id: "g1", mint: "G", side: "buy", at: 1, sol: 0.1 });
  ok((await d.resetOnceForNano()) === true, "the paper desk restarts");
  const s = await getSettings();
  ok(s.desk.needNano === true && s.desk.mode === "paper", "needNano on; auto became paper (live is approved by hand)");
  ok(Number(await R.llen("rn:desk:trips")) === 0, "the losing record leaves the page (archived)");
  ok(((await R.get(K.deskLearn)) as any)?.trailK === 0.9 && ((await R.get(K.nano)) as any)?.n === 900, "what the desk and nano learned is kept");
  ok(Number(await R.llen("rn:ghost:trades")) === 1, "the ghost record is kept");
  ok((await d.resetOnceForNano()) === false, "only once");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.43 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
