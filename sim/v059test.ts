// v0.1.59: REPLAY on archived calls and curve paths. Run: npx tsx sim/v059test.ts
import { newDb } from "pg-mem";
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const rp = await import("../src/lib/replay");
  const t0 = Date.UTC(2026, 9, 9, 0, 0, 0);
  const path = (xs: number[], step = 10_000, mc0 = 30) => xs.map((x, i) => ({ at: t0 + i * step, progress: 20, mcSol: mc0 * x, realSol: 10, complete: false }));
  const call = (ticks: any[], over: any = {}) => ({ mint: "M", symbol: "X", at: t0, score: 80, verdict: "BOND", nanoScore: 70, nanoVerdict: "BOND", progress: 20, farm: false, bundle: 0.1, ticks, ...over });
  const x = { initials: 2, trail: 0.25, stop: 0.25, timeMin: 45 };
  // a runner: up to 3x, back to 2.2x -> initials at 2x, rest trailed out at 2.25x
  const win = rp.simulate(call(path([1, 1.5, 2, 3, 2.2])), x)!;
  ok(win && win.pnl > 0 && win.why === "trail", `a runner: initials, then trailed out, a win (${win?.pct.toFixed(1)}%, ${win?.why})`);
  const loss = rp.simulate(call(path([1, 0.9, 0.7])), x)!;
  ok(loss && loss.why === "stop" && loss.pct < -25, `a dump: stopped out, costs included (${loss?.pct.toFixed(1)}%)`);
  const flat = rp.simulate(call(path([1, 1, 1])), x)!;
  ok(flat && flat.pct < 0 && flat.pct > -12, `flat: only the round-trip costs (${flat?.pct.toFixed(1)}%)`);
  ok(rp.simulate(call(path([1, 1.2]).map((t) => ({ ...t, at: t.at + 60_000 }))), x) === null, "no price within 30s of the call: not replayed");
  const mig = rp.simulate(call([...path([1, 1.3]), { at: t0 + 20_000, progress: 100, mcSol: 60, realSol: 85, complete: true }]), x)!;
  ok(mig?.why === "migrated", "a coin that migrates is sold at the migration price");
  // entry rules and the train/test split
  const calls = Array.from({ length: 40 }, (_, i) => call(path(i % 3 === 0 ? [1, 2.5, 3, 2.2] : [1, 0.8, 0.7]), { mint: `M${i}`, at: t0 + i * 3600_000, nanoVerdict: i % 2 ? "BOND" : "DUST" }).ticks ? { ...call([], { mint: `M${i}` }), at: t0 + i * 3600_000, nanoVerdict: i % 2 ? "BOND" : "DUST", ticks: path(i % 3 === 0 ? [1, 2.5, 3, 2.2] : [1, 0.8, 0.7]).map((t) => ({ ...t, at: t.at + i * 3600_000 })) } : null);
  const res = rp.runReplay(calls as any);
  const desk = res.rows.find((r) => r.entry === "desk")!;
  const king = res.rows.find((r) => r.entry === "king")!;
  ok(res.usable === 40 && res.trainN === 28 && res.testN === 12, `train on the older 70%, test on the newest 30% (${res.trainN}/${res.testN})`);
  ok(king.signals === 40 && desk.signals === 20, `the nano rule halves the desk's signals (${desk.signals} vs ${king.signals})`);
  ok(king.test.n === 12 && typeof king.test.pfLessBest === "number", "test results reported for the exit picked on train");
  // reading from the archive
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await pool.query(`create table launches (mint text primary key, symbol text, created_at timestamptz, call_score real, data jsonb); create table ticks (mint text, at timestamptz, progress real, mc_sol real, real_sol real, complete boolean);`);
  const at = Date.now() - 3 * 3600_000;
  await pool.query(`insert into launches values ('A', 'AAA', $1, 80, $2)`, [new Date(at).toISOString(), JSON.stringify({ call: { at: at + 300_000, score: 80, verdict: "BOND", nano: { score: 70, verdict: "BOND" }, progress: 20 }, tape: { bundleShare: 0.1 } })]);
  for (let i = 0; i < 5; i++) await pool.query(`insert into ticks values ('A', $1, 20, $2, 10, false)`, [new Date(at + 300_000 + i * 10_000).toISOString(), 30 + i]);
  const loaded = await rp.loadCalls(pool);
  ok(loaded.length === 1 && loaded[0].ticks.length === 5 && loaded[0].verdict === "BOND", "calls and their paths load from the archive");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.59 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
