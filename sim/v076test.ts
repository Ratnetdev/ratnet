// v0.1.76: the desk goes live by itself on the exam pass, no human step. Run: npx tsx sim/v076test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const S = await import("../src/lib/settings");
  const D = await import("../src/lib/desk");
  await S.saveSettings({ desk: { ...(await S.getSettings()).desk, mode: "paper" } as any });
  ok(await D.autoOnce076(), "paper becomes auto once");
  ok((await S.getSettings()).desk.mode === "auto", "desk mode is auto");
  await S.saveSettings({ desk: { ...(await S.getSettings()).desk, mode: "paper" } as any });
  ok(!(await D.autoOnce076()) && (await S.getSettings()).desk.mode === "paper", "a later change in Admin is never overwritten");
  // waiting to go live: no new paper buys anywhere
  const cfg: any = { ...(await S.getSettings()).desk, dailyLoss: 25, maxOpen: 5 };
  const st: any = { live: false, dayStart: 1, cash: 1 };
  ok((await D.roomFor("direct", st, 1, cfg)) === null, "normally there is room");
  D._promoWait(true);
  ok(/no new paper buys/.test(String(await D.roomFor("direct", st, 1, cfg))), "exam passed in auto: no new paper buys (stalks, re-entries, MOMO)");
  ok((await D.roomFor("direct", { ...st, live: true }, 1, cfg)) === null, "once live, buys go on");
  D._promoWait(false);
  const fs = await import("fs");
  const dk = fs.readFileSync(new URL("../src/lib/desk.ts", import.meta.url), "utf8");
  ok(/if \(!state\.live && cfg\.mode === "auto" && kp && positions\.length\) \{[\s\S]{0,200}exw\.passed/.test(dk), "with open paper positions the passed exam starts the wait");
  ok(/if \(PROMO_WAIT\) \{\n\s+GRID_ORDERS\.length = 0;\n\s+queued\.length = 0;/.test(dk), "queued signals and GRID orders are dropped while waiting");
  ok(/if \(PROMO_WAIT && !state\.live\) return log\(b, "LEDGER"/.test(dk), "every other entry path stops too");
  ok(/RATNET desk is LIVE/.test(dk) && /RATNET desk is back on paper/.test(dk), "Telegram when it goes live and if it is sent back to paper");
  ok(/await autoOnce076\(\)/.test(dk), "the switch to auto runs at desk start");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
