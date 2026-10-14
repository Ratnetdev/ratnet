// v0.1.74: EXPLORE. When nothing ranks, GRID LIVE still trades the best strategies on all calls. Run: npx tsx sim/v074test.ts
import { MockRedis } from "./mockredis";
import type { GCoin } from "../src/lib/grid";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function coin(i: number, steps: number[], f: Partial<GCoin> = {}): GCoin {
  const n = steps.length + 1;
  const t = new Int32Array(n), mc = new Float32Array(n), real = new Float32Array(n), prog = new Float32Array(n), done = new Uint8Array(n);
  let px = 30;
  for (let k = 0; k < n; k++) {
    if (k) px *= 1 + steps[k - 1];
    t[k] = k * 10_000;
    mc[k] = px;
    real[k] = Math.max(1, px - 25);
    prog[k] = Math.min(99, Math.max(0, (px - 28) * 1.2));
  }
  return { mint: `M${i}`, symbol: `S${i}`, at: 1_790_000_000_000 + i * 60_000, createdAt: 1_790_000_000_000 + i * 60_000 - 90_000, verdict: "WATCH", score: 50, nano: 40, progress: prog[0], rise60: 2, uniq: 15, spb: 0.2, bs: 0.3, sn: 5, sm: 0, ds: false, soc: 0, t, mc, real, prog, done, ...f };
}
const walk = () => Array.from({ length: 60 }, () => (rnd() - 0.5) * 0.08);
const pump = () => [...Array.from({ length: 12 }, () => 0.06 + rnd() * 0.04), ...Array.from({ length: 40 }, () => (rnd() - 0.5) * 0.03)];
(async () => {
  const g = await import("../src/lib/grid");
  const L = await import("../src/lib/gridlive");
  // a weak edge only in the newest calls (like a regime change): nothing ranks on train, but all calls show it
  const cs: GCoin[] = [];
  for (let i = 0; i < 1500; i++) {
    const late = i > 1050;
    const edge = late && rnd() < 0.3;
    cs.push(coin(i, edge && rnd() < 0.6 ? pump() : walk(), edge ? { sm: 3 } : {}));
  }
  const v = await g.runGrid(cs);
  ok(v.rows.length === 0, `nothing ranks on train (${v.rows.length})`);
  ok(v.explore.length > 0 && v.explore.every((r) => r.explore && !r.pass), `${v.explore.length} exploring strategies, never marked passed`);
  ok(v.explore.some((r) => /smart wallet/.test(r.filterLabel)), `the edge is among them: ${v.explore[0]?.filterLabel}`);
  const cands = g.liveCandidates(v, 16);
  ok(cands.length > 0 && cands.length <= 16, `GRID LIVE gets ${cands.length} books instead of none`);
  L.gridLiveReset();
  const books = await L.gridLiveSetBooks(cands);
  ok(books.length === cands.length && books.every((b) => b.grid.explore), "the books are marked exploring");
  // an exploring book needs 45+ trips in total, positive, on top of the exam on its last 30
  const mk = (n: number, good: boolean) => Array.from({ length: n }, (_, i) => ({ k: "x", mint: `m${i}`, symbol: "s", openedAt: 0, closedAt: n - i, pnl: i % 2 ? 0.02 : good ? -0.008 : -0.03, pnlPct: 0, why: "t" }));
  const exp = { grid: { testN: 0, testAvg: 0, pass: false, explore: true } };
  const rank = { grid: { testN: 30, testAvg: 5, pass: true } };
  ok(L.bookStat(rank, mk(30, true)).passed, "a ranked strategy passes on the exam alone (30 trips)");
  const p30 = L.bookStat(exp, mk(30, true));
  ok(!p30.passed && p30.pending && L.dropReason(p30) === null, "an exploring one with a passing exam at 30 trips is pending, and kept");
  ok(L.bookStat(exp, mk(46, true)).passed, "it passes once 45+ trips are positive in total");
  ok(!L.bookStat(exp, mk(30, false)).passed && L.dropReason(L.bookStat(exp, mk(30, false))) != null, "an exploring book that fails the exam is dropped");
  const fs = await import("fs");
  const lb = fs.readFileSync(new URL("../src/components/GridLiveBoard.tsx", import.meta.url), "utf8");
  ok(/EXPLORING/.test(lb), "exploring books are labelled on /desk");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version && BUILD === "0.1.74", `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
