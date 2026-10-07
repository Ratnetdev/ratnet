// v0.1.29 checks: the rebuilt nano learner (King v1.1), its one-time migration, the runner's locked training, the
// CATCH curve lock, the desk never budget-blocked, and the site address without a trailing slash.
// Run: npx tsx sim/v029test.ts
process.env.RPC_CALLS_PER_DAY = "1000";
process.env.NEXT_PUBLIC_SITE_URL = "https://www.ratnet.network/";
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
  const nano = await import("../src/lib/nano");
  const D = nano.NANO_FEATURES.length;
  // synthetic launches: input 1 (curve) and input 5 (X linked) decide; 3% bond
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sample = () => {
    const x = Array.from({ length: D }, () => 0);
    x[0] = 1;
    for (let i = 1; i < D; i++) x[i] = rnd() < 0.3 ? rnd() : 0;
    x[1] = rnd();
    x[4] = rnd() < 0.4 ? 1 : 0;
    const z = -6 + 5 * x[1] + 2 * x[4];
    return { x, y: rnd() < 1 / (1 + Math.exp(-z)) };
  };
  const m = nano.emptyModel();
  let maxStep = 0;
  for (let i = 0; i < 6000; i++) {
    const s = sample();
    const before = m.w.slice();
    nano.learn(m, s.x, s.y);
    for (let k = 0; k < D; k++) maxStep = Math.max(maxStep, Math.abs(m.w[k] - before[k]));
  }
  ok(m.v === 2 && m.n === 6000, `v2 model learned 6000 lessons (${m.pos} bonds)`);
  ok(maxStep <= 0.1 + 1e-9, `no single step moves a weight more than the cap x boost (max ${maxStep.toFixed(4)})`);
  ok(m.w.every(Number.isFinite), "all weights finite");
  const hi = Array.from({ length: D }, () => 0);
  hi[0] = 1;
  hi[1] = 0.95;
  hi[4] = 1;
  const lo = Array.from({ length: D }, () => 0);
  lo[0] = 1;
  lo[1] = 0.05;
  ok(nano.predict(m, hi) > nano.predict(m, lo) * 3, `ranks a strong launch far above a weak one (${nano.predict(m, hi).toFixed(3)} vs ${nano.predict(m, lo).toFixed(3)})`);
  const w0 = m.w.slice();
  const bad = hi.slice();
  bad[3] = NaN;
  bad[7] = Infinity;
  nano.learn(m, bad, true);
  ok(m.w.every(Number.isFinite), "a NaN/Infinity input never breaks the weights");
  nano.learn(m, hi.slice(0, 10), false);
  ok(m.w.length === w0.length, `a shorter input is padded, weights never truncated (${m.w.length} of ${w0.length})`);
  // one class weight for every source: the old posWeight argument no longer matters
  const a = nano.emptyModel();
  const b = nano.emptyModel();
  for (let i = 0; i < 500; i++) {
    const s = sample();
    nano.learn(a, s.x, s.y, 50);
    nano.learn(b, s.x, s.y, 1);
  }
  ok(a.w.every((v, i) => Math.abs(v - b.w[i]) < 1e-12), "same lessons, same model, whatever class weight the caller passes");
  // shift boost: at most once a day
  ok((m.shifts || 0) <= 1, `market-shift boost fired at most once (${m.shifts || 0})`);
  // a v1 model is started over on the v2 learner
  const old: any = { w: Array.from({ length: D }, () => 0.3), n: 900, pos: 30, loss: 0.2, acc: 0.9, updatedAt: 1 };
  nano.learn(old, hi, true);
  ok(old.v === 2 && old.n === 1, "a v1 model is restarted on the v2 learner (its raw-input weights do not carry over)");

  // migration: v1 kept, v2 warm-started from the live lesson buffer
  const { K } = await import("../src/lib/redis");
  await R.set(K.nano, { w: Array.from({ length: D }, () => 0.1), n: 5000, pos: 100, loss: 0.3, acc: 0.8, updatedAt: 1 });
  const lessons = Array.from({ length: 800 }, () => {
    const s = sample();
    return { x: s.x, x1: s.x, y: s.y ? 1 : 0 };
  });
  for (const l of lessons) await R.lpush("rn:replay", l);
  await R.set("rn:h:state2", { phase: "done" });
  const { migrateNano, loadModel } = await import("../src/lib/digger");
  const mg: any = await migrateNano();
  const nm = await loadModel();
  const v1: any = await R.get("rn:nano:v1");
  ok(mg.nano === "migrated" && nm.v === 2 && nm.n === 800, `nano migrated, warm start on 800 lessons (n=${nm.n})`);
  ok(v1 && v1.n === 5000, "the v1 model is kept as rn:nano:v1");
  ok(!(await R.get("rn:h:state2")), "the historian walks its window again (clean labels)");
  const again: any = await migrateNano();
  ok(again.nano === "v2", "migration runs once");
  const { KING_V1 } = await import("../src/lib/kingcal");
  ok(KING_V1 === "v1.1", "the board version is v1.1 (v1.0 keeps its own record)");

  // runner: trained only through the locked path, on the latest copy
  const { applyRunnerOps, loadRunner, RK } = await import("../src/lib/runner");
  await applyRunnerOps([{ x: hi, y: true }, { x: lo, y: false }]);
  await applyRunnerOps([{ x: lo, y: false }]);
  const rm = await loadRunner();
  ok(rm.v === 2 && rm.n === 3, `runner lessons from two passes both kept (n=${rm.n})`);
  void RK;

  // CATCH curve lock: opens on 30 closed curve trades averaging +5% with 30%+ winners
  const { catchStageRecord } = await import("../src/lib/desk");
  for (let i = 0; i < 30; i++) await R.lpush("rn:ct:res:curve", i % 3 === 0 ? 60 : -12);
  const cr: any = await catchStageRecord("curve");
  ok(cr.n === 30 && cr.earned, `curve unlocks on a proven record (avg ${cr.avg}%, ${cr.win}% winners)`);
  for (let i = 0; i < 30; i++) await R.lpush("rn:ct:res:pool", -20);
  const pr: any = await catchStageRecord("pool");
  ok(!pr.earned, "a losing record stays locked");

  // the desk is never stopped by the daily budget
  const sol = await import("../src/lib/solana");
  sol.seedDayUsed(new Date().toISOString().slice(0, 10), 50_000);
  ok(sol.laneOpen(0) && !sol.laneOpen(1), "at 50x the day's budget the desk still reads, the rats do not");

  // the site address never ends in a slash (Telegram refuses the // redirect)
  const { SITE } = await import("../src/config/site");
  ok(SITE.url === "https://www.ratnet.network", `site url trimmed (${SITE.url})`);

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.29 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
