// v0.1.78: real-fill check, the hot strategy's family (exit variants + every-launch twin), faster drops. Run: npx tsx sim/v078test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const L = await import("../src/lib/gridlive");
  const g = await import("../src/lib/grid");
  const fs = await import("fs");

  // ---- faster drops
  const st = (o: any) => ({ n: 0, wins: 0, winRate: 0, avgPct: 0, pnl: 0, pfLessBest: 0, passed: false, ...o });
  ok(/no win in 5/.test(String(L.dropReason(st({ n: 5, wins: 0, avgPct: -20 })))), "0 wins after 5 trips: dropped");
  ok(L.dropReason(st({ n: 5, wins: 1, avgPct: -3 })) === null, "one win in 5: kept");
  ok(/avg -16/.test(String(L.dropReason(st({ n: 8, wins: 2, avgPct: -16 })))), "avg -15% or worse after 8: dropped");
  ok(L.dropReason(st({ n: 30, wins: 0, passed: true })) === null, "a passed strategy is never dropped");

  // ---- the hot strategy and its family
  const exit = { initials: 1.5, trail: 0.25, stop: 0.25, timeMin: 60, mig: "hold" as const };
  ok(L.neighborExits(exit).length === 6, "6 exits one setting away (2 targets, trail, stop, time, migration)");
  L.gridLiveReset();
  const hotKey = g.keyOf("p70+r5", "now", exit);
  const coldKey = g.keyOf("bond+n50", "c20", { ...exit, initials: 3, mig: "sell" });
  const grid = { testN: 40, testAvg: 4, pass: false, explore: true };
  L._setBooks([
    { key: hotKey, label: "curve 70%+ (near migration) + curve +5 pts in the minute before, buy at the call", filter: "p70+r5", mode: "now", exit, since: 1, grid },
    { key: coldKey, label: "cold", filter: "bond+n50", mode: "c20", exit: { ...exit, initials: 3, mig: "sell" }, since: 1, grid },
  ]);
  const trip = (k: string, pnl: number, i: number) => ({ k, mint: `m${k.length}${i}`, symbol: "X", openedAt: i, closedAt: i + 1, pnl, pnlPct: (pnl / 0.0525) * 100 });
  const trips = [
    ...Array.from({ length: 16 }, (_, i) => trip(hotKey, i % 16 < 9 ? 0.02 : -0.01, i)),
    ...Array.from({ length: 5 }, (_, i) => trip(coldKey, -0.02, 100 + i)),
  ];
  L._setTrips(trips as any);
  ok(L.hotBook()?.key === hotKey, "the hot strategy: 16 trips, 56% won, in profit, PF 1.2+");
  const msgs: string[] = [];
  const r = await L.gridLiveTend(async (t) => msgs.push(t));
  ok(r.dropped.some((d) => d.key === coldKey), "the cold book (0 wins in 5) is dropped");
  ok(r.added.length === 7 && r.added.includes(`any:${hotKey}`), "family spawned: the every-launch twin + 6 exit variants");
  ok(msgs.length === 1 && /got its family/.test(msgs[0]), "Telegram names the family");
  const r2 = await L.gridLiveTend(async (t) => msgs.push(t));
  ok(r2.added.length === 0 && msgs.length === 1, "spawned once per hot strategy");
  const books = L.gridLiveBooks();
  ok(books.filter((b) => b.parent === hotKey).every((b) => b.grid.explore), "the family is exploring (45-trip rule applies)");
  ok(L.gridLiveState().check.has(hotKey) && L.gridLiveState().check.has(`any:${hotKey}`), "the hot strategy and its family get their fills checked");

  // GRID's 16 slots do not count the family
  const rows = Array.from({ length: 20 }, (_, i) => ({ key: g.keyOf("bond", "now", { ...exit, initials: 2, trail: 0.4 }) + `#${i}`, filterLabel: "King BOND", filter: "bond", mode: "now", modeLabel: "at the call", exit, test: { n: 40, avgPct: 3 }, pass: false, explore: true })) as any;
  const after = await L.gridLiveSetBooks(rows);
  ok(after.filter((b: any) => !b.parent).length === 16 && after.filter((b: any) => b.parent).length === 7, "GRID still fills 16; the family has its own slots");

  // ---- the twin: the hot rule on every launch, from the curve alone
  const quotes: any[] = [];
  L._setQuote(async (c: any) => (quotes.push(c), c.side === "buy" ? c.paper * 0.95 : c.paper * 0.97));
  const t0 = Date.now();
  const mint = "TwinMint1111111111111111111111111111111pump";
  L.gridLiveSymbol(mint, "TWIN");
  L.gridLiveCurve(mint, { progress: 60, mcapSol: 200, realSol: 50 }, t0);
  L.gridLiveCurve(mint, { progress: 66, mcapSol: 230, realSol: 55 }, t0 + 30_000);
  ok(![...L.gridLiveState().pend.keys()].some((k) => k.startsWith("any:")), "no entry under 70%");
  L.gridLiveCurve(mint, { progress: 72, mcapSol: 260, realSol: 60 }, t0 + 61_000);
  ok(L.gridLiveState().pend.has(`any:${hotKey}#${mint}`), "70%+ and +12 points in the last minute: the twin signals (no King call)");
  ok(![...L.gridLiveState().pend.keys()].some((k) => k.startsWith(hotKey)), "the King-call book does not take it (no call)");
  L.gridLiveCurve(mint, { progress: 74, mcapSol: 270, realSol: 62 }, t0 + 64_000);
  const p = L.gridLiveState().pos.get(`any:${hotKey}#${mint}`);
  ok(!!p && p.symbol === "TWIN", "filled 2s+ later, with the launch's name");
  L.gridLiveCurve(mint, { progress: 60, mcapSol: 200, realSol: 50 }, t0 + 70_000);
  L.gridLiveCurve(mint, { progress: 75, mcapSol: 280, realSol: 63 }, t0 + 140_000);
  ok([...L.gridLiveState().pend.keys()].filter((k) => k === `any:${hotKey}#${mint}`).length === 0, "once per coin");

  // ---- real-fill check
  await wait(50);
  ok(quotes.some((q) => q.side === "buy" && q.mint === mint && q.amount === BigInt(Math.round(g.GRID_SOL * 1e9))), "the buy is quoted on Jupiter at the desk's size");
  ok(L.gridLiveState().fills.get(`any:${hotKey}`)?.bn === 1 && Math.abs((L.gridLiveState().fills.get(`any:${hotKey}`)?.bg ?? 0) + 0.05) < 1e-9, "buy gap recorded (-5%)");
  // stop it out: the sell is quoted too
  L.gridLiveCurve(mint, { progress: 40, mcapSol: 150, realSol: 30 }, t0 + 150_000);
  await wait(1_700);
  const f = L.gridLiveState().fills.get(`any:${hotKey}`)!;
  ok(f.sn === 1 && Math.abs(f.sg + 0.03) < 1e-9, "sell gap recorded (-3%)");

  // ---- the gap gate: passed on paper, but real fills 10%+ worse over a round trip: not followed
  const passTrips = Array.from({ length: 30 }, (_, i) => trip(hotKey, i < 18 ? 0.02 : -0.01, 1000 + i));
  L._setTrips([...passTrips, ...Array.from({ length: 20 }, (_, i) => trip(hotKey, 0.01, 2000 + i))] as any);
  L._setBooks(L.gridLiveBooks().map((b) => ({ ...b })));
  ok(L.gridLeader()?.key === hotKey, "passed: the desk would follow it");
  L.gridLiveState().fills.set(hotKey, { bn: 8, bg: -0.06, sn: 8, sg: -0.05, nr: 0 });
  ok(L.gapBlock(hotKey) && L.gridLeader()?.key !== hotKey, "real fills -11% over a round trip: not followed");
  L.gridLiveState().fills.set(hotKey, { bn: 8, bg: -0.03, sn: 8, sg: -0.02, nr: 0 });
  ok(!L.gapBlock(hotKey) && L.gridLeader()?.key === hotKey, "-5%: followed");
  L.gridLiveState().fills.set(hotKey, { bn: 3, bg: -0.2, sn: 3, sg: -0.2, nr: 0 });
  ok(!L.gapBlock(hotKey), "fewer than 8 checks each way: no verdict yet");

  // ---- worker wiring and the UI
  const w = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/setInterval\(tend, 5 \* 60_000\)/.test(w) && /gridLiveSymbol\(mint/.test(w), "worker: tend every 5 minutes, launch names for the twins");
  const ui = fs.readFileSync(new URL("../src/components/GridLiveBoard.tsx", import.meta.url), "utf8");
  ok(/EVERY LAUNCH/.test(ui) && /VARIANT/.test(ui) && /real fills \(Jupiter vs paper\)/.test(ui), "UI: twin and variant tags, real-fill line");
  const gl = fs.readFileSync(new URL("../src/lib/gridlive.ts", import.meta.url), "utf8");
  ok(/lite-api\.jup\.ag\/swap\/v1/.test(gl) && !/readPools|canonicalPool/.test(gl.split("v0.1.78: real-fill check")[1] || ""), "fills checked on Jupiter's route (what live money uses), not PumpSwap directly");

  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version && BUILD === "0.1.78", `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
