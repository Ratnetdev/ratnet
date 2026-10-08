// v0.1.36 checks: the track record counts P&L the way the books do. Run: npx tsx sim/v036test.ts
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
  const now = Date.now();
  // A: bought 0.05 (cost 0.0528 with tip, priority, base fee and rent), sold all for 0.051 -> -0.0018
  // B: an older buy without the cost field; its sell says pnl -0.004 on 0.046 back -> cost 0.050
  // C: open, 1,000,000 tokens at 5e-8 SOL (0.05 SOL at mid), cost 0.0528
  const trades = [
    { id: "a1", mint: "A", symbol: "A", side: "buy", at: now - 9000, sol: 0.05, cost: 0.0528, tokens: 1, px: 1, reason: "x", live: false },
    { id: "a2", mint: "A", symbol: "A", side: "sell", at: now - 8000, sol: 0.051, tokens: 1, px: 1, reason: "tp", pnlSol: 0.051 - 0.0528, live: false },
    { id: "b1", mint: "B", symbol: "B", side: "buy", at: now - 7000, sol: 0.05, tokens: 1, px: 1, reason: "x", live: false },
    { id: "b2", mint: "B", symbol: "B", side: "sell", at: now - 6000, sol: 0.046, tokens: 1, px: 1, reason: "stop", pnlSol: -0.004, live: false },
    { id: "c1", mint: "C", symbol: "C", side: "buy", at: now - 5000, sol: 0.05, cost: 0.0528, tokens: 1e6, px: 5e-8, reason: "x", live: false },
  ];
  for (const t of trades.slice().reverse()) await R.rpush(K.deskTrades, t);
  await R.hset(K.deskPos, { C: { mint: "C", symbol: "C", openedAt: now - 5000, entryPx: 5e-8, costSol: 0.0528, tokens: 1e6, tokens0: 1e6, soldSol: 0, lastPx: 5e-8, peakPx: 5e-8, mkt: { grad: false, real: 20 }, live: false, series: [] } });
  await R.set(K.deskState, { live: false, start: 1, equity: 1, startedAt: now - 10000 });
  const rec: any = await d.getRecord();
  const by = Object.fromEntries(rec.trips.map((t: any) => [t.mint, t]));
  ok(Math.abs(by.A.pnlSol - -0.0018) < 1e-4 && Math.abs(by.A.costSol - 0.0528) < 1e-4, `A: the buy's fees count (${by.A.pnlSol} SOL on ${by.A.costSol}; it used to show +0.001)`);
  ok(Math.abs(by.B.costSol - 0.05) < 1e-4 && Math.abs(by.B.pnlSol - -0.004) < 1e-4, "B: an old trade without the cost field takes its cost from its own sell");
  ok(by.C.open && Math.abs(by.C.valueSol - 0.0501) < 2e-4 && by.C.pnlSol < -0.0025, `C: an open position is worth what selling it brings after costs, rent back (${by.C.valueSol} SOL, P&L ${by.C.pnlSol}; it showed 0 at mid)`);
  ok(Math.abs(rec.summary.realizedSol - (-0.0018 - 0.004)) < 1e-4, `realized = what the books realized (${rec.summary.realizedSol})`);
  ok(rec.summary.wins === 0, "a trade that only made money before fees is not a win");

  const { waitingOn } = await import("../src/components/DeskNow");
  const w = waitingOn({ budget: { used: 100, pace: 90, budget: 300000, ratsPaused: true, agentsPaused: true } } as any, [{ sleeve: "momo", paused: now + 60_000 }]);
  ok(w.length === 2 && /pace/.test(w[0]) && /momo/.test(w[1]), "the desk says why it is not buying (pace, paused strategy)");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.36 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
