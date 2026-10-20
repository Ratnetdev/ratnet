// v0.1.138 FAST FILL, FILL LEDGER, KEEP SHARE, PROOF BOARD.
// Run: npx tsx sim/v138test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const L = await import("../src/lib/gridlive");
  const P = await import("../src/lib/proof");
  const now = Date.now();

  // ---- 1. the order goes out at the signal, once
  L.gridLiveReset();
  const inner = L.bookFromKey("front|now|2/0.25/0.25/30/hold", now)!;
  const key = `any:${inner.key}`;
  L._setBooks([{ ...inner, key, any: true, by: "smart" } as any]);
  L._setLeaders([key]);
  const orders: any[] = [];
  L.setGridFollow((o: any) => orders.push(o));
  const M = "Fast111111111111111111111111111111111pump";
  L.gridLiveCurve(M, { progress: 10, mcapSol: 40, realSol: 5 }, now);
  L.gridLiveSmart(M, { fr: 1 }, now);
  L.gridLiveCurve(M, { progress: 11, mcapSol: 41, realSol: 5.2 }, now + 300);
  ok(orders.length === 1 && orders[0].early === true && orders[0].at === now, "the live order goes out at the signal itself, before the paper fill");
  ok(Math.abs(orders[0].px0 - 40 / 1e9) < 1e-15, "it carries the price at the signal, for the desk's no-chasing check");
  L.gridLiveCurve(M, { progress: 12, mcapSol: 42, realSol: 5.4 }, now + 2_500);
  ok(orders.length === 1 && L.gridLiveState().pos.has(`${key}#${M}`), "the paper still fills 2 s later; no second order");
  ok(L.fastStats.early === 1, "counted as an early order");
  // v0.1.139: a quiet coin (no tick between the signal and the paper fill) still gets its order at the signal
  L._setLeaders([key]);
  const MQ = "Quiet11111111111111111111111111111111pump";
  L.gridLiveCurve(MQ, { progress: 10, mcapSol: 40, realSol: 5 }, now);
  L.gridLiveSmart(MQ, { fr: 1 }, now + 100);
  ok(orders.length === 2 && orders[1].early === true && orders[1].at === now + 100, "a quiet coin: the order goes out the moment the entry is armed, not on its next tick");
  L.gridLiveCurve(MQ, { progress: 12, mcapSol: 42, realSol: 5.4 }, now + 3_000);
  ok(orders.length === 2, "and only once");
  // not followed: no order
  L._setLeaders(["other"]);
  const M2 = "Slow111111111111111111111111111111111pump";
  L.gridLiveCurve(M2, { progress: 10, mcapSol: 40, realSol: 5 }, now);
  L.gridLiveSmart(M2, { fr: 1 }, now);
  L.gridLiveCurve(M2, { progress: 11, mcapSol: 41, realSol: 5 }, now + 2_500);
  ok(orders.length === 2, "a strategy the desk does not follow sends nothing");

  // ---- 2. keep share
  L._keepReset();
  const trips: any[] = [];
  for (let i = 0; i < 200; i++) trips.push({ k: "x", mint: `k${i}`, symbol: "K", openedAt: now - i * 1000, closedAt: now - i * 1000, pnl: 0, pnlPct: 25, why: "trail", pk: 2 }); // peaked +100%, kept +25%
  L._setTrips(trips);
  const ks = L.keepShare(now + 120_000);
  ok(ks.n === 200 && Math.abs(ks.k - 0.25) < 1e-9, `closed trips kept ${ks.k * 100}% of their peak gain`);
  L._setTrips(trips.slice(0, 10));
  L._keepReset();
  ok(L.keepShare(now + 120_000).k === L.KEEP_DEF, "under 150 trips: the default share");

  // ---- 3. the proof board's math
  const fills: any[] = [
    { at: 1, mint: "a", symbol: "A", path: "fast", early: true, wait: 50, prep: 400, land: 900, total: 1350, slip: 1.2, live: true },
    { at: 2, mint: "b", symbol: "B", path: "fast", early: true, wait: 60, prep: 500, land: 1100, total: 1660, slip: -0.5, live: true },
    { at: 3, mint: "c", symbol: "C", path: "beat", early: false, wait: 2500, prep: 600, land: 1000, total: 4100, slip: 6.0, live: true },
  ];
  const fsum = P.fillSummary(fills);
  ok(fsum.n === 3 && fsum.ms === 1660 && fsum.fast.n === 2 && fsum.beat.ms === 4100 && fsum.early === 2, `fill summary: median ${fsum.ms} ms, on arrival ${fsum.fast.n}, next beat ${fsum.beat.ms} ms`);
  const rows = P.pairRows([
    { k: "a", mint: "m1", at: 10, live: -20, paper: 10, exact: false, sym: "ONE" },
    { k: "b", mint: "m1", at: 10, live: -20, paper: 30, exact: false, sym: "ONE" },
    { k: "a", mint: "m2", at: 20, live: 50, paper: 40, exact: true, sym: "TWO" },
  ] as any);
  ok(rows.length === 2 && rows[0].sym === "TWO" && rows[1].paper === 20 && rows[1].gap === -40 && rows[1].books === 2, "one row per live trade, newest first, paper averaged over the strategies that held it");

  // ---- 4. wiring
  const desk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/kickFast\(\);/.test(desk) && /FAST_CTX = PROMO_WAIT \? null :/.test(desk), "the desk buys GRID orders on arrival with the running session's books");
  ok(/FAST_CTX = null;\s*await FAST_CHAIN/.test(desk), "a session that ends stops the fast path and saves what it bought");
  ok(/const b: Batch = \{ ev: b0\.ev, trades: b0\.trades, ghost: b0\.ghost \};\s*b0\.ev = \[\];/.test(desk), "the log batch is taken before its write: nothing logged during the write is lost");
  ok(/lpush\(FILLS_LOG, f\)/.test(desk) && /const knownP = getLaunch\(o\.mint\)/.test(desk), "every GRID buy goes to the fill ledger; the coin's record loads next to the price");
  ok(fs.existsSync("src/app/proof/page.tsx") && fs.existsSync("src/app/api/proof/route.ts") && fs.existsSync("src/app/api/desk/fills/route.ts"), "the proof page and its API");
  const gl = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  ok(/\(value - p\.cost\) \* keepShare\(now\)\.k/.test(gl), "open gains count at the kept share");
  ok(!/—/.test(fs.readFileSync("src/components/ProofBoard.tsx", "utf8") + fs.readFileSync("src/app/proof/page.tsx", "utf8")), "no em dashes on the proof page");
  ok(JSON.parse(fs.readFileSync("package.json", "utf8")).version >= "0.1.138", "v0.1.138 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.138 checks pass");
  process.exit(fail ? 1 : 0);
})();
