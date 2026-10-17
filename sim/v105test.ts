// v0.1.105 KOL and EXIT flows: from every firehose trade, the tracked KOL wallets that bought (and the market cap at the
// first), KOLs that sold, and how many of the first 20 buyers sold; GRID rules for them; GRID LIVE positions measure a
// flow exit side by side with their real exit (nothing traded on it). Run: npx tsx sim/v105test.ts
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
  const T = await import("../src/lib/tapeall");
  const g = await import("../src/lib/grid");
  const t0 = Date.now();

  // ---- 1. the flow book
  T._tapeReset();
  T.setKols(["KOL1", "KOL2", "KOL3"]);
  T.tapeCreate("M", "DEV");
  T.tapeTrade({ mint: "M", user: "DEV", isBuy: true, sol: 1, at: t0, mcSol: 28 });
  for (let i = 0; i < 25; i++) T.tapeTrade({ mint: "M", user: `B${i}`, isBuy: true, sol: 0.2, at: t0 + i * 100, mcSol: 30 + i });
  T.tapeTrade({ mint: "M", user: "KOL1", isBuy: true, sol: 2, at: t0 + 3000, mcSol: 40 });
  T.tapeTrade({ mint: "M", user: "KOL2", isBuy: true, sol: 1, at: t0 + 3100, mcSol: 45 });
  let f = T.flowFeatures("M");
  ok(f.kf === 2 && f.kmc === 40 && f.kx === 0 && f.e20 === 0, `2 KOLs in, the first at 40 SOL market cap; nobody sold (${JSON.stringify(f)})`);
  for (let i = 0; i < 10; i++) T.tapeTrade({ mint: "M", user: `B${i}`, isBuy: false, sol: 0.1, at: t0 + 5000 + i, mcSol: 50 });
  T.tapeTrade({ mint: "M", user: "B22", isBuy: false, sol: 0.1, at: t0 + 6000, mcSol: 50 }); // not one of the first 20
  T.tapeTrade({ mint: "M", user: "DEV", isBuy: false, sol: 1, at: t0 + 6100, mcSol: 50 }); // the dev is not an early buyer
  f = T.flowFeatures("M");
  ok(f.e20 === 0.5, `10 of the first 20 buyers sold: 0.5 (the 22nd buyer and the dev do not count) (${f.e20})`);
  T.tapeTrade({ mint: "M", user: "KOL1", isBuy: false, sol: 2, at: t0 + 7000, mcSol: 55 });
  ok(T.flowFeatures("M").kx === 1, "a KOL that bought sold: counted");
  T.tapeTrade({ mint: "N", user: "KOL3", isBuy: false, sol: 1, at: t0, mcSol: 30 });
  ok(T.flowFeatures("N").kf === 0 && T.flowFeatures("N").kx === 0, "a KOL selling a coin it never bought on our feed is not a KOL exit");
  for (let i = 0; i < 5; i++) T.tapeTrade({ mint: "S", user: `s${i}`, isBuy: true, sol: 0.1, at: t0, mcSol: 30 });
  ok(T.flowFeatures("S").e20 === null && T.flowFeatures("ZZ").kf === 0, "fewer than 10 buyers: the share is unknown");
  T.flowSweep(t0 + 4 * 3600_000);
  ok(T.flowFeatures("M").kf === 0, "coins older than 3 hours leave the book");

  // ---- 2. GRID
  const ids = g.PREDS.map((p) => p.id);
  const NEW = ["kol3", "kolsmall", "kolout", "hold20", "exit20"];
  ok(NEW.every((x) => ids.includes(x)) && ids.indexOf("kol3") > ids.indexOf("boosted"), "5 flow rules on GRID's menu, appended");
  const pred = (id: string) => g.PREDS.find((p) => p.id === id)!;
  const c1: any = { kf: 3, kmu: 4700, kx: 0, e20: 0.1 };
  const c2: any = { kf: 1, kmu: 25000, kx: 1, e20: 0.6 };
  ok(pred("kol3").ok(c1) && pred("kolsmall").ok(c1) && !pred("kolout").ok(c1) && pred("hold20").ok(c1) && !pred("exit20").ok(c1), "3 KOLs in under $10K, early buyers holding");
  ok(!pred("kol3").ok(c2) && !pred("kolsmall").ok(c2) && pred("kolout").ok(c2) && !pred("hold20").ok(c2) && pred("exit20").ok(c2), "a late KOL already out, early buyers exiting");
  ok(NEW.every((x) => !pred(x).ok({ kf: null, kmu: null, kx: null, e20: null } as any)), "unknown never passes");
  const gs = fs.readFileSync("src/lib/grid.ts", "utf8");
  ok(/kf: num\(tp\.kf\)/.test(gs) && /e20: num\(tp\.e20\)/.test(gs), "GRID loads them from the call's firehose read");

  // ---- 3. GRID LIVE: the flow exit, measured beside the real one
  const L = await import("../src/lib/gridlive");
  L.gridLiveReset();
  let flow: any = { kx: 0, e20: 0.1 };
  L.setFlowFeatures(() => flow);
  const key = "bond|now|2/0.25/0.25/15/sell";
  L._setBooks([{ key, label: "test", filter: "bond", mode: "now", exit: { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15, mig: "sell" }, since: 0, grid: { testN: 40, testAvg: 3, pass: false } } as any]);
  const now = Date.now();
  L.gridLiveCurve("F", { progress: 40, mcapSol: 60, realSol: 20 }, now);
  L.gridLiveCall({ mint: "F", symbol: "F", at: now, createdAt: now - 300_000, verdict: "BOND", score: 90, progress: 40, tp: {} } as any, now);
  L.gridLiveCurve("F", { progress: 40, mcapSol: 60, realSol: 20 }, now + 100);
  L.gridLiveCurve("F", { progress: 40, mcapSol: 60, realSol: 20 }, now + 2_500);
  L.gridLiveCurve("F", { progress: 41, mcapSol: 61, realSol: 20 }, now + 3_000);
  const pos = [...L.gridLiveState().pos.values()].find((p) => p.mint === "F");
  ok(!!pos && pos.f0?.e20 === 0.1, "a new position notes the flow at its buy");
  L.gridLiveCurve("F", { progress: 45, mcapSol: 70, realSol: 22 }, now + 60_000);
  ok(!pos?.fx, "no turn yet: nothing noted");
  flow = { kx: 0, e20: 0.55 };
  L.gridLiveCurve("F", { progress: 46, mcapSol: 72, realSol: 22 }, now + 90_000);
  ok(pos?.fx?.why === "e20" && (pos?.fx?.pct ?? -99) > 0, `half of the first 20 sold: the position notes selling now (${pos?.fx?.pct}%)`);
  L.gridLiveCurve("F", { progress: 30, mcapSol: 44, realSol: 15 }, now + 120_000); // -27%: the stop
  const fx = L.flowxView();
  ok(fx.n === 1 && (fx.flagAvg ?? 0) > (fx.actAvg ?? 0) && fx.flagBetter === 1, `at the real close (the stop) both results are kept: actual ${fx.actAvg}%, flow exit ${fx.flagAvg}%`);
  ok((await R.lrange<any>(L.FLOWX_KEY, 0, 9)).length === 1, "the record is kept in Redis for the review");
  ok([...L.gridLiveState().trips].some((t) => t.mint === "F" && t.why === "stop"), "the trade itself is unchanged (it still exits on its own rules)");

  // ---- 4. wiring and review
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/kf: kols \? fl\.kf : null/.test(wk) && /e20: fl\.e20/.test(wk) && /setFlowFeatures\(/.test(wk) && /setKols\(/.test(wk) && /flowSweep\(\)/.test(wk), "the call's firehose read carries the flow; GRID LIVE watches it; HOUND's KOLs load; old coins are swept");
  ok(/kmu: kols && fl\.kmc != null && usd > 0 \? Math\.round\(fl\.kmc \* usd\)/.test(wk), "the first KOL's market cap in dollars (at the SOL price the rats read)");
  const rv = await import("../src/lib/review");
  const v: any = await rv.reviewView(Date.now());
  ok(v.flowExit?.n === 1 && /Exit flows/.test(rv.reviewText(v)), "the daily review reports the exit-flow record");
  const at = fs.readFileSync("src/lib/attention.ts", "utf8");
  ok(/exists \(select 1 from ticks t where t\.mint = l\.mint\)/.test(at), "the DexScreener backfill takes only calls GRID can test");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 105 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.105 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.105 checks pass");
  process.exit(fail ? 1 : 0);
})();
