// v0.1.135 REAL GAP and EDGE AFTER FILLS: live GRID follows paired with paper on the same coin; books judged on their
// paper record plus the real gap, not on a flat 10% quote gap.
// Run: npx tsx sim/v135test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const L = await import("../src/lib/gridlive");
  const now = Date.now();
  const K1 = "any:pw1|c5|2/0.5/0.35/60/hold/k0.3h24";
  const K1b = "any:pw1|c5|2/0.5/0.35/60/hold/k0.3h24~fx:e30-100";
  const K2 = "early60:r15+lowauto|now|2/0.25/0.45/60/sell";
  // 30 paper trips each: K1 averages +50% (desk ladder +40%), K2 +10%
  const trips: any[] = [];
  for (let i = 0; i < 30; i++) {
    trips.push({ k: K1, mint: `m${i}`, symbol: "A", openedAt: now - (i + 1) * 600_000, closedAt: now - i * 600_000, pnl: i % 3 ? 0.035 : 0.005, pnlPct: i % 3 ? 70 : 10, why: "tp", sh: { desk: i % 3 ? 1.6 : 1.0 } });
    trips.push({ k: K1b, mint: `m${i}`, symbol: "A", openedAt: now - (i + 1) * 600_000 + 5_000, closedAt: now - i * 600_000, pnl: 0.03, pnlPct: 60, why: "tp", sh: { desk: 1.5 } });
    trips.push({ k: K2, mint: `n${i}`, symbol: "B", openedAt: now - (i + 1) * 600_000, closedAt: now - i * 600_000, pnl: i % 2 ? 0.01 : 0, pnlPct: i % 2 ? 20 : 0, why: "tp", sh: { desk: i % 2 ? 1.2 : 1.0 } });
  }
  L._setTrips(trips);
  L._pairsReset();
  L._gbClear();

  // ---- 1. before any measure: the flat quote gap no longer blocks a big edge
  L._setFill(K1, { bn: 20, bg: -0.12, sn: 20, sg: -0.05 });
  const e0 = L.edgeOf(K1);
  ok(e0.src === "quotes" && e0.avg > 5 && e0.ok, `K1 after the quoted 17% gap still makes ${e0.avg}% a trade: followed (the old flat rule blocked it)`);
  ok(!L.gapBlock(K1), "gapBlock lets it through");
  L._setFill(K2, { bn: 20, bg: -0.12, sn: 20, sg: -0.05 });
  L._gbClear();
  ok(L.gapBlock(K2), `K2 (+10% paper) after the same gap is under 5% a trade: blocked (${L.edgeOf(K2).avg}%)`);
  ok(!L.gapBlock("unknown|book"), "a book with no measure at all is not blocked");

  // ---- 2. pairing live follows
  ok(L.gridNoteLive({ k: K1, mint: "m0", openedAt: now - 600_000 + 20_000, pct: -30 }) === 1, "an exact live follow pairs with its book's paper trip on the coin");
  ok(L.gridNoteLive({ k: K1, mint: "m0", openedAt: now - 600_000 + 20_000, pct: -30 }) === 0, "the same live trade pairs once");
  ok(L.gridNoteLive({ mint: "m1", openedAt: now - 1_200_000 + 30_000, pct: -20 }) === 2, "an older follow (book unknown) pairs with every book that traded the coin then");
  ok(L.gridNoteLive({ mint: "m2", openedAt: now - 3_600_000 * 7, pct: 10 }) === 0 && L.pairsView().waiting === 0, "a follow far from any paper trip and over 6 hours old is dropped");
  ok(L.gridNoteLive({ k: K2, mint: "fresh", openedAt: now, pct: 5 }) === 0 && L.pairsView().waiting === 1, "a follow whose paper trip is still open waits");
  const pv = L.pairsView();
  ok(pv.trades === 2 && pv.exact === 1, `pairs view counts live trades once (${pv.trades} trades, ${pv.pairs} pairs)`);
  ok(L.realGap(K1) === null, "under 8 pairs there is no real gap yet");

  // ---- 3. a real gap decides
  for (let i = 3; i < 12; i++) L.gridNoteLive({ k: K1, mint: `m${i}`, openedAt: now - (i + 1) * 600_000 + 10_000, pct: -35 });
  const rg = L.realGap(K1)!;
  ok(rg.src === "book" && rg.n >= 8 && rg.gap < -50, `K1's own real gap: ${rg.gap} points over ${rg.n} live follows`);
  L._gbClear();
  const e1 = L.edgeOf(K1);
  ok(e1.src === "book" && !e1.ok && L.gapBlock(K1), `with that gap K1 loses ${e1.avg}% a trade with real money: blocked`);
  const rf = L.realGap(K1b)!;
  ok(rf.src === "family" || rf.src === "book", `a sibling book (same filter and entry) uses the family's gap (${rf.src}, ${rf.gap})`);
  ok(L.familyOf(K1b) === "any:pw1|c5", "family = filter and entry");
  const fp = L.realGap(K2)!;
  ok(fp && fp.src === "all", `a book with no pairs of its own falls back on every live follow (${fp.src}, ${fp.gap})`);

  // ---- 3b. v0.1.136: noise can't add edge, and evidence counts live trades
  L._pairsReset();
  for (let i = 0; i < 3; i++) L.gridNoteLive({ mint: `m${i + 20}`, openedAt: now - (i + 21) * 600_000 + 5_000, pct: 200 });
  const pv2 = L.pairsView();
  ok(pv2.pairs === 6 && pv2.trades === 3 && L.realGap(K1b) === null, `3 live trades make ${pv2.pairs} pairs but count as 3: no gap yet`);
  for (let i = 3; i < 10; i++) L.gridNoteLive({ mint: `m${i + 20}`, openedAt: now - (i + 21) * 600_000 + 5_000, pct: 200 });
  const pos = L.realGap(K1b)!;
  ok(pos.raw > 0 && pos.gap === -L.GAP_COST, `live beating paper by ${pos.raw} points is noise: the gap stays at the cost of a trade (${pos.gap})`);
  for (let i = 3; i < 12; i++) L.gridNoteLive({ k: K1, mint: `m${i}`, openedAt: now - (i + 1) * 600_000 + 10_000, pct: -35 });

  // ---- 4. persistence
  await L.pairsSave();
  const n0 = L.pairsView().pairs;
  L._pairsReset();
  ok((await L.pairsLoad()) === n0, "pairs survive a restart (Redis)");

  // ---- 5. wiring
  const src = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  ok(/pcts: \(\(\) => \{ const e = edgeAdj\(b\.key\); return mine\.map\(\(t\) => Math\.round\(e\.adj\(t\) \* 10\) \/ 10\); \}\)\(\)/.test(src), "the desk sizes follows on the record after the real gap");
  ok(/\.map\(\(x\) => \(\{ \.\.\.x, e: edgeOf\(x\.b\.key\)\.lessTop2/.test(src), "leaders are ranked by the record after the real gap");
  ok(/pairPending\(t\);/.test(src), "a waiting live follow pairs when its paper trip closes");
  const desk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/if \(p\.live && p\.gk && FOLLOW_CLOSE\)/.test(desk), "the desk reports every closed live follow with its book");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/setFollowClose\(\(x\) => void gridNoteLive\(x\)\)/.test(wk) && /GRID LIVE follow/.test(wk) && /pairsLoad\(\)/.test(wk), "the worker wires the hook, loads pairs and backfills past live follows");
  ok(JSON.parse(fs.readFileSync("package.json", "utf8")).version >= "0.1.135", "v0.1.135 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.135 checks pass");
  process.exit(fail ? 1 : 0);
})();
