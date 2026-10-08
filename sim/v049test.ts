// v0.1.49: a trade with more than one sell shows the average exit, not the last sell. Run: npx tsx sim/v049test.ts
// Fixture: the real $ERARI paper trade of 8 Oct 22:12 UTC. Half sold at $174.9K (initials), half at $111.2K (trailing
// stop). The card said exit $111.2K, change -13.5%, next to a +4.4% P&L.
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
  const half = 21224.306979224046;
  const trades = [
    { id: "e1", mint: "E", symbol: "ERARI", side: "buy", at: now - 85_000, sol: 0.05, cost: 0.0526, tokens: half * 2, px: 1.16376e-6, reason: "MOMO", live: false, mc: 128572 },
    { id: "e2", mint: "E", symbol: "ERARI", side: "sell", at: now - 20_000, sol: 0.0324, tokens: half, px: 1.58202e-6, reason: "initials at 1.4x, cost is back", pnlSol: 0.0061, pnlPct: 23.4, live: false, mc: 174882 },
    { id: "e3", mint: "E", symbol: "ERARI", side: "sell", at: now - 1000, sol: 0.0225, tokens: half, px: 1.0061e-6, reason: "trailing stop 31% off the peak (1.5x), out at 0.9x", pnlSol: -0.0038, pnlPct: -14.3, live: false, mc: 111218 },
  ];
  // F: the same trade with one sell only (the trade list is cached between reads, so both coins go in at once)
  const single = [{ ...trades[0], id: "f1", mint: "F", tokens: half, at: now - 900 }, { ...trades[2], id: "f2", mint: "F", at: now - 500 }];
  for (const t of [...trades, ...single].slice().reverse()) await R.rpush(K.deskTrades, t);
  await R.set(K.deskState, { live: false, start: 1, equity: 1, startedAt: now - 100_000 });
  const rec: any = await d.getRecord();
  const t = rec.trips.find((x: any) => x.mint === "E");
  ok(t && t.pnlPct > 0, `P&L still positive (${t?.pnlPct}%)`);
  ok(t && Math.abs(t.exitMc - 143050) < 5, `exit market cap is the average over both sells ($${t?.exitMc}, was $111,218)`);
  ok(t && t.exitPct > 10 && t.exitPct < 13, `exit change is the average price vs entry (${t?.exitPct}%, was -13.5%)`);
  ok(t && t.lastMc === 111218 && t.sells === 2, "the last sell and the sell count are kept for the card");

  // one sell: unchanged
  const one: any = rec.trips.find((x: any) => x.mint === "F");
  ok(one && one.exitMc === 111218 && one.sells === 1, `a single sell still shows that sell (${one?.exitMc}, ${one?.sells})`);

  // the position's own average for the Telegram close alert
  ok(Math.abs(d.avgExitPx({ soldPxTok: 1.58202e-6 * half + 1.0061e-6 * half, tokens0: half * 2 }, 1.0061e-6) - 1.29406e-6) < 1e-10, "avgExitPx: token-weighted over the sells");
  ok(d.avgExitPx({ tokens0: 5 }, 7) === 7, "avgExitPx: positions from before v0.1.49 fall back to the last price");

  const ta = await import("../src/lib/tradealerts");
  const c = ta.closeText({ book: "paper", mint: "E", symbol: "ERARI", how: "momo", costSol: 0.0526, backSol: 0.0549, entryMc: 128572, exitMc: 143050, lastMc: 111218, sells: 2, peakX: 1.462, openedAt: now - 85_000, reason: "trailing stop 31% off the peak (1.5x), out at 0.9x" });
  ok(/\$128\.6K → \$143\.1K avg \(\+11\.3%\)/.test(c) && /Sells<\/b>  2 · last one at \$111\.2K/.test(c) && /Last exit<\/b>  trailing stop/.test(c), "close alert: average exit, number of sells, last one marked as last");
  const p = ta.closeText({ book: "paper", mint: "E", symbol: "ERARI", costSol: 0.05, backSol: 0, entryMc: null, exitMc: null, peakX: 1, openedAt: now, reason: "initials at 1.4x, cost is back", partial: { frac: 0.5, sol: 0.0324, mc: 174882 } });
  ok(/0\.0324 SOL at \$174\.9K mcap/.test(p), "partial sell alert says the market cap it sold at");
  const s1 = ta.closeText({ book: "ghost", mint: "E", symbol: "X", costSol: 0.1, backSol: 0.12, entryMc: 10000, exitMc: 12000, peakX: 1.3, openedAt: now, reason: "stop loss" });
  ok(!/avg|Sells/.test(s1) && /<b>Exit<\/b>  stop loss/.test(s1), "a single sell alert is unchanged");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.49 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
