// v0.1.95: COMPOUNDING SIZE. A passed GRID LIVE strategy is sized by its own record (quarter Kelly, its 2 best trips
// left out, between kellyMinPct and kellyMaxPct of the bank). Run: npx tsx sim/v095test.ts
import * as S from "../src/lib/sizing";
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const near = (a: number, b: number, e = 0.011) => Math.abs(a - b) <= e;
(async () => {
  const fs = await import("fs");
  // 1. Kelly: +100% or -50% at even odds -> f* = 0.5
  const coin = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : -0.5));
  ok(near(S.kellyFrac(coin), 0.5), `even odds, +100%/-50%: Kelly ${S.kellyFrac(coin)} (0.5)`);
  // win 60% at +20%, lose 40% at -20% -> f* = (0.6*0.2 - 0.4*0.2)/(0.2*0.2) = 1.0 (bounded at 1)
  ok(S.kellyFrac([-0.3, -0.3, 0.1]) === 0, "losing record: 0");
  ok(S.kellyFrac(Array.from({ length: 50 }, (_, i) => (i % 10 === 0 ? -1 : 0.05))) === 0 || S.kellyFrac(Array.from({ length: 50 }, (_, i) => (i % 10 === 0 ? -1 : 0.05))) < 0.05, "a record with total wipeouts gets almost nothing");
  // 2. plans
  const cfg = { sizePct: 5, kellyFrac: 0.25, kellyMinPct: 1, kellyMaxPct: 10 };
  ok(S.sizePlan(coin.slice(0, 29).map((r) => r * 100), cfg) === null, "under 30 trips: flat sizePct");
  const p = S.sizePlan(coin.map((r) => r * 100), cfg)!;
  ok(p && p.pct > 9 && p.pct <= 10, `strong record: ${p.pct}% (quarter of ~49%, capped at 10)`);
  const lucky = [...Array.from({ length: 30 }, () => -10), 500, 400];
  const pl = S.sizePlan(lucky, cfg)!;
  ok(pl.pct === 1 && /without its 2 best/.test(pl.why), `two lucky coins and 30 losers: floor ${pl.pct}% (${pl.why})`);
  const modest = Array.from({ length: 40 }, (_, i) => (i % 5 < 2 ? 30 : -12)); // 40% win +30%, 60% lose -12%
  const pm = S.sizePlan(modest, cfg)!;
  ok(pm.pct >= 1 && pm.pct < 10, `modest edge: ${pm.pct}% (${pm.why})`);
  // 3. compounding: the same plan on a bigger bank is a bigger trade
  const trade = (bank: number) => Math.min(0.5, Math.max(0.05, (bank * pm.pct) / 100));
  ok(trade(4) > trade(2) && near(trade(4) / trade(2), 2, 0.01), `bank 2 -> ${trade(2).toFixed(3)} SOL, bank 4 -> ${trade(4).toFixed(3)} SOL`);
  // 4. wiring
  const desk = fs.readFileSync("src/lib/desk.ts", "utf8");
  const gl = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  const site = fs.readFileSync("src/config/site.ts", "utf8");
  const admin = fs.readFileSync("src/lib/deskbounds.ts", "utf8"); // v0.1.100: the bounds moved here
  ok(/sizePlan\(o\.pcts/.test(desk) && /\(eqValue \* pct\) \/ 100\), liqCap/.test(desk), "the desk sizes FOLLOW buys from the leader's record, on its equity, under the liquidity cap");
  ok(/pcts: TRIPS\.filter\(\(t\) => t\.k === b\.key\)\.map\(\(t\) => t\.pnlPct\)/.test(gl), "GRID LIVE sends the leader's record with each order");
  ok(/kellyFrac: 0\.25/.test(site) && /kellyMaxPct: 10/.test(site) && /kellyMaxPct: \[1, 20\]/.test(admin), "defaults and admin bounds set");
  ok(/daily_loss_ok/.test(desk) && /roomFor\("direct"/.test(desk), "the daily loss stop still gates FOLLOW buys");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 95 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.95 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.95 checks pass");
  process.exit(fail ? 1 : 0);
})();
