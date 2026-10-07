// v0.1.35 checks: the X budget is enforced. Run: npx tsx sim/v035test.ts
process.env.X_API_KEY = "k";
process.env.X_CREDITS_PER_HOUR = "10000";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const calls: { url: string; body: any }[] = [];
  let nextId = 1;
  let updateOk = true;
  (globalThis as any).fetch = async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    if (/get_rules/.test(url)) return new Response(JSON.stringify({ rules: [] }));
    if (/add_rule/.test(url)) return new Response(JSON.stringify({ status: "success", rule_id: `r${nextId++}` }));
    if (/update_rule/.test(url)) return new Response(JSON.stringify({ status: updateOk ? "success" : "error" }));
    if (/delete_rule/.test(url)) return new Response(JSON.stringify({ status: "success" }));
    return new Response("{}");
  };
  // 60 seed-like accounts with picks; 10 of them post 60 times an hour, the rest 2
  const acc: Record<string, any> = {};
  const st: Record<string, number> = {};
  for (let i = 0; i < 60; i++) {
    acc[`a${i}`] = { h: `a${i}`, cat: "kol", tier: "found", added: 1 };
    st[`a${i}:picks`] = i < 10 ? 0 : 1;
    st[`a${i}:sparks`] = 3;
  }
  await R.hset("rn:x:acc", acc);
  await R.hset("rn:x:st", st);
  const prev = new Date(Date.now() - 3600_000).toISOString().slice(0, 13);
  const vol: Record<string, number> = {};
  for (let i = 0; i < 60; i++) vol[`a${i}`] = i < 10 ? 60 : 2;
  await R.hset(`rn:x:vol:${prev}`, vol);
  await R.set("rn:x:synced", { at: Date.now(), n: 9, accounts: 104, interval: 60, v: 24 });

  const w = await import("../src/lib/wire");
  (w as any).__noSeed = true;
  const res: any = await w.syncRules();
  ok(res.synced === true, "a sync from before v0.1.35 (or a new budget) resyncs on its own");
  ok(res.noisy >= 10, `accounts posting 60 times an hour with no picks are left to J7 (${res.noisy} left out)`);
  ok(res.estPerHour <= 6000, `the paid rules are sized to ~60% of the 10K budget (expected ~${res.estPerHour}/h, ${res.accounts} accounts)`);
  const added = calls.filter((c) => /add_rule/.test(c.url)).map((c) => c.body.value);
  ok(added.length > 0 && added.every((v: string) => / -is:retweet$/.test(v) && v.length <= 255), "rules leave reposts out and stay within 255 characters");

  // the guard: over budget -> rules off for the rest of the hour
  const { xSpend } = await import("../src/lib/xcredits");
  await xSpend("watchlist posts", 12_000);
  const g1: any = await w.xGuard();
  ok(g1.guard === "paused" && g1.rules === added.length, `over budget: every rule switched off (${g1.rules})`);
  const off = calls.filter((c) => /update_rule/.test(c.url) && c.body.is_effect === 0).length;
  ok(off === added.length, "with is_effect 0");
  const g2: any = await w.xGuard();
  ok(g2.guard === "paused this hour", "and it stays off this hour");
  const s2: any = await w.syncRules();
  ok(s2.synced === false, "no resync puts them back during the paused hour");
  // next hour: back on
  await R.set("rn:x:paused", { hour: "2000-01-01T00", min: 5 });
  const g3: any = await w.xGuard();
  ok(g3.guard === "resumed" && calls.filter((c) => /update_rule/.test(c.url) && c.body.is_effect === 1).length >= added.length, "next hour: rules back on");

  // a rule that will not switch off is deleted instead
  updateOk = false;
  await R.del("rn:x:paused");
  const g4: any = await w.xGuard();
  const del = calls.filter((c) => /delete_rule/.test(c.url)).length;
  ok(g4.guard === "paused" && del >= added.length, "if switching off fails, the rules are deleted (they would keep billing)");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.35 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
