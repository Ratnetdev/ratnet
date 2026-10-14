// v0.1.75: FOLLOW. The desk trades the GRID LIVE strategy that passed, with its exact exits. Run: npx tsx sim/v075test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const D = await import("../src/lib/desk");
  const g = await import("../src/lib/grid");
  const L = await import("../src/lib/gridlive");
  // ---- GRID's exits on a desk position
  const t0 = 1_900_000_000_000;
  const sell = { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15, mig: "sell" as const };
  const hold = { ...sell, mig: "hold" as const };
  const pos = (x: any, o: any = {}) => ({ gx: x, entryPx: 1, peakPx: 1, tp1Done: false, openedAt: t0, gradSeen: false, ...o });
  ok(D.gridExit(pos(sell), { px: 2.1, grad: false }, t0 + 60_000).frac === 0.5, "half at the target");
  ok(D.gridExit(pos(sell, { tp1Done: true, peakPx: 3 }), { px: 2.2, grad: false }, t0 + 60_000).frac === 1, "the rest on the trail (25% off the peak)");
  ok(D.gridExit(pos(sell, { tp1Done: true, peakPx: 3 }), { px: 2.4, grad: false }, t0 + 60_000).frac === 0, "inside the trail: hold");
  ok(D.gridExit(pos(sell), { px: 0.74, grad: false }, t0 + 60_000).frac === 1, "the stop");
  ok(D.gridExit(pos(sell), { px: 1.05, grad: false }, t0 + 16 * 60_000).frac === 1, "out after the time limit without initials");
  ok(/sold at the migration/.test(D.gridExit(pos(sell), { px: 1.3, grad: true }, t0 + 5 * 60_000).why), "sell strategies leave at the migration");
  ok(D.gridExit(pos(hold), { px: 1.3, grad: true }, t0 + 5 * 60_000).frac === 0, "hold strategies ride on into the pool");
  ok(D.gridExit(pos(hold, { tp1Done: true, peakPx: 4 }), { px: 3.5, grad: true }, t0 + 6 * 3600_000 + 1).frac === 1, "and leave after 6 hours");
  ok(D.gridExit(pos(hold, { gradSeen: true }), { px: 1.1, grad: true }, t0 + 60_000).frac === 0, "a position bought in the pool is not sold as 'migrated'");

  // ---- the leader: a strategy that passed the exam live; its fills go to the desk
  L.gridLiveReset();
  const S = { n: 40, wins: 20, winRate: 50, avgPct: 8, pnl: 0.2, pfLessBest: 1.6 };
  const row = (f: string) => ({ key: g.keyOf(f, "now", sell), filter: f, filterLabel: f, mode: "now", modeLabel: "at the call", exit: sell, exitLabel: "", train: S, test: S, pass: true, senders: 0 });
  await L.gridLiveSetBooks([row("sm"), row("bond")] as any);
  ok(L.gridLeader() === null, "no leader before a live pass");
  const st = L.gridLiveState();
  for (let i = 0; i < 30; i++) st.trips.push({ k: row("sm").key, mint: `w${i}`, symbol: "w", openedAt: 0, closedAt: i, pnl: i % 2 ? 0.03 : -0.01, pnlPct: 0, why: "t" });
  const sent: string[] = [];
  const v = await L.gridLivePublish(async (t) => sent.push(t));
  ok(L.gridLeader()?.filter === "sm" && v.follow?.key === row("sm").key, "the passed strategy leads");
  ok(sent.some((t) => /desk now follows/.test(t)), "Telegram says the desk follows it");
  const fol: any = await R.get("rn:grid:follow");
  ok(fol?.live?.passed === true, "the follow record is stored for the desk's exam");
  await L.gridLivePublish(async (t) => sent.push(t));
  ok(sent.filter((t) => /desk now follows/.test(t)).length === 1, "said once, not every minute");
  const orders: any[] = [];
  L.setGridFollow((o) => orders.push(o));
  let T = 1_950_000_000_000;
  L.gridLiveCurve("Z", { progress: 20, mcapSol: 40, realSol: 15, complete: false }, T);
  L.gridLiveCall({ mint: "Z", symbol: "ZZ", createdAt: T - 60_000, verdict: "BOND", score: 70, progress: 20, tp: { sm: 2 } }, T);
  T += 3_000;
  L.gridLiveCurve("Z", { progress: 21, mcapSol: 41, realSol: 16, complete: false }, T);
  ok(orders.length === 1 && orders[0].mint === "Z" && orders[0].key === row("sm").key && orders[0].exit.initials === 2, "the leader's fill becomes a desk order with its exits");
  ok(!orders.some((o) => o.key === row("bond").key), "other books' fills never reach the desk");

  // ---- the desk's exam: its own 30 trips, or the followed strategy's live pass (with a funded wallet)
  const ex = await D.exam({ start: 1, startedAt: 0 } as any, 1);
  ok(ex.passed && ex.checks.some((c) => /GRID LIVE strategy passed/.test(c.label) && c.ok), "the exam passes on the followed strategy's live record");
  const ex2 = await D.exam({ start: 1, startedAt: 0 } as any, 0.1);
  ok(!ex2.passed, "not without a funded wallet");
  await R.del("rn:grid:follow");
  const ex3 = await D.exam({ start: 1, startedAt: 0 } as any, 1);
  ok(!ex3.passed, "and not without a passed strategy");

  // ---- wiring
  const fs = await import("fs");
  const dk = fs.readFileSync(new URL("../src/lib/desk.ts", import.meta.url), "utf8");
  ok(/if \(p\.gx && !closeAll\)/.test(dk) && /gridExit\(p,/.test(dk), "desk positions following GRID run GRID's exits");
  ok(/while \(GRID_ORDERS\.length\)[\s\S]{0,200}gridEntry\(/.test(dk), "the desk buys GRID orders first in every beat");
  ok(/await shield\(\{ mint: o\.mint/.test(dk), "SHIELD still checks every GRID buy");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/setGridFollow\(\(o\) => queueGridOrder\(o\)\)/.test(wk), "the worker connects GRID LIVE to the desk");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
