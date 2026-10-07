// v0.1.31 checks (Run 4, honest paper desk): live costs, the exam on one window, learning switches with hysteresis,
// the exit lab on new paths with a held-out check, COACH's "no read" vs dead, the reset and the false-print cleanup.
// Run: npx tsx sim/v031test.ts
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
  // 1. costs
  const c = await import("../src/lib/costs");
  ok(c.venueFee(false, 50) === 0.0125, "curve fee 1.25%");
  ok(c.venueFee(true, 300) === 0.0125 && c.venueFee(true, 50_000) === 0.0055 && c.venueFee(true, 200_000) === 0.003, "PumpSwap tiers by market cap in SOL");
  const fixed = c.txCost(0.05);
  ok(Math.abs(fixed - (0.0003 + 0.0005 + 0.000005)) < 1e-9, `fixed cost per tx at 0.05 SOL: ${fixed.toFixed(6)} SOL (tip floor + priority + base)`);
  const rt = c.roundTripCost(0.05, false, 20, 60);
  ok(rt > 0.06 && rt < 0.2, `a 0.05 SOL curve round trip costs ${(rt * 100).toFixed(1)}% (was ~6% on the old flat model with no fixed costs)`);
  const net = c.sellProceeds(1000, 0.0001, true, 85, {}, true);
  ok(net < 0.1 && net > 0.09, `selling 0.1 SOL worth brings ${net.toFixed(4)} after costs, rent back on the close`);
  const huge = c.sellProceeds(1, 70, true, 85, {});
  ok(huge < 40, `a 70 SOL sale into an 85 SOL pool cannot take out more than the pool gives (${huge.toFixed(1)} SOL)`);

  // 2. switches
  const d = await import("../src/lib/desk");
  ok(d.propSwitch(false, 9, 15, 15, 0.6) === false, "9/15 (60%) does not switch an exit on: the interval still includes less");
  ok(d.propSwitch(false, 14, 15, 15, 0.6) === true, "14/15 switches it on");
  ok(d.propSwitch(true, 8, 15, 15, 0.6) === true, "and 8/15 does not switch it straight back off (hysteresis)");
  ok(d.propSwitch(true, 3, 20, 15, 0.6) === false, "3/20 does");
  const taken = { n: 40, sum: 40 * 0.02, sq: 40 * (0.02 * 0.02 + 0.09) };
  ok(d.priorSwitch(true, { n: 60, sum: 60 * 0.15, sq: 60 * (0.0225 + 0.09) }, taken, 20, 0.05) === false, "a prior is overruled when skipped coins clearly beat bought ones");
  ok(d.priorSwitch(true, { n: 25, sum: 25 * 0.06, sq: 25 * (0.0036 + 0.5) }, taken, 20, 0.05) === true, "but not on a noisy edge");

  // 3. exam: one window, profit after costs, profit factor without the best trade
  const { K } = await import("../src/lib/redis");
  const now = Date.now();
  const trades: any[] = [];
  for (let i = 0; i < 30; i++) {
    const m = `M${i}`;
    const pnl = i === 0 ? 0.6 : i % 2 ? -0.004 : 0.003; // one 10x carries everything
    trades.push({ id: `${i}b`, mint: m, side: "buy", at: now - 100_000 + i * 1000, sol: 0.05, live: false });
    trades.push({ id: `${i}s`, mint: m, side: "sell", at: now - 99_500 + i * 1000, sol: 0.05 + pnl, pnlSol: pnl, live: false });
  }
  for (const t of trades.reverse()) await R.rpush(K.deskTrades, t);
  const ex = await d.exam({ live: false, cash: 1, start: 0.6, startedAt: 0, realized: 0, closed: 30, wins: 15, dayKey: "", dayStart: 0.6, peakEq: 1, maxDD: 0, liveStart: null, promotedAt: null, demotions: 0, lastEqAt: 0, equity: 1 } as any, 1);
  const pf = ex.checks.find((x: any) => /best trade/.test(x.label));
  const profit = ex.checks.find((x: any) => /realized profit/.test(x.label));
  ok(!!profit?.ok && !!pf && !pf.ok, `one 10x passes profit but fails "profit factor without the best trade" (${pf?.now})`);
  ok(!ex.passed, "so the exam is not passed on one lucky trade");

  // 4. exit lab: costs in the replay, only new paths, held-out check
  const lab = await import("../src/lib/exitlab");
  const pts: [number, number][] = [[0, 1], [1, 1.5], [2, 2.2], [3, 1.4]];
  ok(lab.replay(pts, lab.DEFAULT_SET, 0.1) < lab.replay(pts, lab.DEFAULT_SET, 0), "a replay pays the trade's costs");
  for (let i = 0; i < 15; i++) await lab.notePath({ at: now - 1000 * (20 - i), tier: "micro", sl: "momo", sl2: undefined, pts: [[0, 1], [0.5, 0.9], [1, 0.8], [2, 0.7], [3, 1.6]], cost: 0.08 } as any);
  const first = await lab.relearn("momo:micro", lab.DEFAULT_SET);
  const again = await lab.relearn("momo:micro", lab.DEFAULT_SET);
  ok(again === null, `no re-learning without new paths (first pass: ${first ? "moved" : "kept"})`);

  // 5. reset: archives the record, never while live, and only once
  await R.lpush("rn:desk:trips", { mint: "OLD", symbol: "OLD" });
  await R.set(K.deskState, { live: true });
  ok((await d.resetOnceForCosts()) === false, "no reset while the desk is live");
  await R.set(K.deskState, { live: false });
  ok((await d.resetOnceForCosts()) === true, "the paper desk resets once for honest costs");
  ok(Number(await R.llen("rn:desk:trips")) === 0, "the old track record leaves the page");
  const keys = Array.from((R as any).kv.keys()) as string[];
  ok(keys.some((k) => k.startsWith("rn:desk:trips:")), "and is kept in an archive");
  ok((await d.resetOnceForCosts()) === false, "only once");

  // 6. false prints out of learning
  await R.rpush("rn:ghost:trades", { id: "a", mint: "XP", side: "buy", at: 1, sol: 0.1 }, { id: "b", mint: "XP", side: "sell", at: 2, sol: 70, pnlPct: 69994 }, { id: "c", mint: "OK", side: "sell", at: 3, sol: 0.12, pnlPct: 20 });
  await lab.notePath({ at: now, tier: "small", sl: "momo", pts: [[0, 1], [1, 1457], [2, 1.2], [3, 1.1]] } as any);
  const fix = await d.dropWicksOnce();
  const gt = (await R.lrange("rn:ghost:trades", 0, -1)) as any[];
  ok(!!fix && gt.length === 1 && gt[0].mint === "OK", `false prints removed (${fix})`);

  // 7. COACH: a failed read is "no read" (tried again), never a dead coin
  (globalThis as any).__rnConn = {
    getMultipleAccountsInfo: async () => {
      throw new Error("timeout");
    },
  };
  const coach = await import("../src/lib/coach");
  await coach.follow({ id: "t1", mint: "So11111111111111111111111111111111111111112", symbol: "T", closedAt: now - 6 * 60_000, entryPx: 1, exitPx: 1, exitGrad: false, reason: "x" });
  await coach.coachStep(150);
  const st: any = await R.hgetall("rn:coach:stat");
  const due: any = await R.zrange("rn:coach:due", 0, -1);
  ok(!st?.["5m:dead"] && (due || []).some((x: string) => x.endsWith("|5m")), "a failed read is retried, not scored as -100%");

  // 8. a stream that sends launches but no trades: stream tapes are refused (the chain is read instead)
  const sl = await import("../src/lib/streamlog");
  const tp = await import("../src/lib/tape");
  sl.logCreate("MINTX", "DEV", now, 1, 1000);
  ok(tp.tapeFromStream("MINTX", "DEV", now) === null, "no trade messages in the last minute: no stream tape (it would hold only the dev's buy)");
  sl.logTrade({ mint: "MINTX", w: "W1", buy: true, sol: 0.5, tok: 100 });
  ok(tp.tapeFromStream("MINTX", "DEV", now) !== null, "trades flowing again: stream tapes are back");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.31 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
