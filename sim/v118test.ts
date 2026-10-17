// v0.1.118 FILL CHECK FIX: the real-fill check quoted Jupiter up to a minute after a paper fill and compared it with
// the fill-time price, so on fast-climbing EARLY coins price drift read as "Jupiter 11% worse" and blocked the first
// strategy to pass its exam. Paper is now priced again at the quote moment; old (drift-biased) checks are dropped.
// Run: npx tsx sim/v118test.ts
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
  L.gridLiveReset();
  const ex = { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15, mig: "sell" as const };
  const key = `early:${g.keyOf("r15", "now", ex)}`;
  L._setBooks([{ key, label: "x", filter: "r15", mode: "now", exit: ex, since: 1, grid: { testN: 0, testAvg: 0, pass: false, explore: true }, by: "early", early: true } as any]);
  L.gridLiveState().check.add(key);
  // a quote that is fair at whatever the price is when it is asked (the route costs nothing extra)
  const mint = "Climb111111111111111111111111111111111pump";
  const seen: any[] = [];
  L._setQuote(async (c: any) => (seen.push({ ...c }), c.side === "buy" ? c.paper : null)); // the route at paper's price now
  const t0 = Date.now();
  L.gridLiveCurve(mint, { progress: 20, mcapSol: 40, realSol: 8 }, t0);
  const c: any = { mint, symbol: "CLB", at: t0, createdAt: t0 - 120_000, verdict: "EARLY", score: 0, progress: 20, rise60: 16, sx: null };
  ok(L.gridLiveEarly(mint, c, t0) === 1, "an EARLY read starts its entry");
  L.gridLiveCurve(mint, { progress: 22, mcapSol: 42, realSol: 9 }, t0 + 2_500);
  L.gridLiveSweep(t0 + 2_600);
  ok(L.gridLiveState().pos.has(`${key}#${mint}`), "filled on paper");
  // before the quote is asked, the coin climbs 20%
  L.gridLiveCurve(mint, { progress: 40, mcapSol: 50.4, realSol: 14 }, t0 + 3_000);
  const filled = L.gridLiveState().pos.get(`${key}#${mint}`)!.tokens;
  const re = L._reprice({ side: "buy", key, mint, amount: 50_000_000n, paper: filled, sol: g.GRID_SOL } as any);
  ok(re.paper < filled * 0.9 && re.paper > filled * 0.7, `a late quote is set against paper at the price of that moment: ${Math.round((re.paper / filled) * 100)}% of the tokens of the fill, after the coin went up 20%`);
  await wait(100);
  const f = L.gridLiveState().fills.get(key);
  ok(!!f && f.bn === 1 && f.v === 118, "the buy is checked (a v0.1.118 check)");
  ok(!!f && Math.abs(f.bg) < 0.03, `the 20% climb before the quote is not counted against the route (gap ${((f?.bg ?? 0) * 100).toFixed(1)}%)`);
  // old checks are dropped at load, but a strategy they blocked stays blocked until the new check has its say
  L._gridLiveUnload();
  await R.hset("rn:gridlive:fills", { [key]: { bn: 26, bg: -0.114, sn: 25, sg: -0.019, nr: 5 } });
  await L.gridLiveLoad(1, 0);
  ok(!L.gridLiveState().fills.has(key) && L.gapBlock(key), "an old blocking record is dropped, and the strategy stays blocked meanwhile (no live money on an unchecked route)");
  L.gridLiveState().fills.set(key, { bn: 8, bg: -0.02, sn: 8, sg: -0.01, nr: 0, v: 118 } as any);
  ok(!L.gapBlock(key), "8 fair quotes each way on the new check: followed");
  L.gridLiveState().fills.set(key, { bn: 8, bg: -0.09, sn: 8, sg: -0.03, nr: 0, v: 118 } as any);
  ok(L.gapBlock(key), "if the route really is 10%+ worse, it stays blocked");
  const src = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  ok(/if \(f\.v === FILL_V\) FILLS\.set\(k, f\)/.test(src), "only checks from this build on are loaded (the old ones carried the drift)");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 118 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.118 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.118 checks pass");
  process.exit(fail ? 1 : 0);
})();
