// v0.1.84: live prices on the site from the firehose every second; open trades' change and P&L follow them.
// Run: npx tsx sim/v084test.ts
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
  const FC = await import("../src/lib/firecache");
  const PX = await import("../src/lib/pxcache");
  // ---- the firehose's price of a coin
  FC._fcReset();
  FC.fcConnected(Date.now());
  const cv = { progress: 40, mcapSol: 80, realSol: 20, complete: false, priceSol: 8e-8, supply: 1e9 };
  FC.fcCurveTrade("CURVE", cv, 1);
  FC.fcCurveTrade("MIG", { ...cv, complete: true, progress: 100 }, 2);
  FC.fcPoolTrade("MIG", { pool: "P", sol: 300, tok: 50_000_000, px: 6.6e-6 }, 3);
  ok(FC.fcPrice("CURVE")?.px === 8e-8 && FC.fcPrice("CURVE")?.grad === false, "on the curve: the curve's price");
  ok(FC.fcPrice("MIG")?.px === 6.6e-6 && FC.fcPrice("MIG")?.grad === true, "migrated: the canonical pool's price (never the finished curve)");
  const before = { ...FC.fcStats };
  FC.fcPrice("CURVE");
  ok(FC.fcStats.curveHits === before.curveHits && FC.fcStats.poolHits === before.poolHits, "pricing the site does not count as a saved chain read");
  ok(FC.fcPrice("NONE") === null, "nothing current: null (the chain refresh prices it)");

  // ---- the site cache: every second from the firehose, never overwritten by an older chain price
  PX._pxReset();
  const now = Date.now();
  await R.zadd(PX.PXWANT, { score: now, member: "MIG" }, { score: now, member: "SLOW" });
  let asked: string[] = [];
  await PX.refreshPxCache(async (ms) => ((asked = ms), { MIG: { px: 5e-6, grad: true }, SLOW: { px: 1e-7, grad: false } }), now);
  ok(asked.length === 2, "the slow pass learns which coins viewers want");
  const f = await PX.refreshPxFast((m) => FC.fcPrice(m), [], now + 1000);
  ok(f.list === 2 && f.moved === 1, "the fast pass reprices them from the firehose (one moved)");
  let all: any = await R.get(PX.PXALL);
  ok(all.px.MIG.px === 6.6e-6 && all.px.SLOW.px === 1e-7, "the firehose price is on the site, the other coin keeps its chain price");
  asked = [];
  await PX.refreshPxCache(async (ms) => ((asked = ms), { MIG: { px: 5e-6, grad: true }, SLOW: { px: 1.1e-7, grad: false } }), now + 2000);
  all = await R.get(PX.PXALL);
  ok(!asked.includes("MIG") && all.px.MIG.px === 6.6e-6 && all.px.SLOW.px === 1.1e-7, "the 4s chain refresh skips coins the firehose priced in the last 3s (no older price written over a newer one)");
  const quiet = await PX.refreshPxFast((m) => FC.fcPrice(m), [], now + 3000);
  ok(quiet.moved === 0, "nothing moved: nothing rewritten");

  // ---- the site: live P&L for open trades
  const LT = await import("../src/components/liveTrip");
  const t = { open: true, nowMc: 500_000, backSol: 0.05, valueSol: 0.06, costSol: 0.1, pnlSol: 0.01, pnlPct: 10 };
  const n = LT.liveTripNumbers(t as any, 560_000);
  ok(n.live && n.nowMc === 560_000 && Math.abs(n.pnlSol - (0.05 + 0.06 * 1.12 - 0.1)) < 1e-4 && n.pnlPct === 17.2, `GMGN at $560K, the page copy at $500K: change and P&L follow $560K (${n.pnlPct}%)`);
  ok(!LT.liveTripNumbers({ ...t, open: false } as any, 560_000).live && LT.liveTripNumbers(t as any, null).pnlPct === 10, "closed trades and no live price: the page's own numbers");

  // ---- wiring
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/refreshPxFast\(\(m\) => fcPrice\(m\)\)/.test(wk) && /\}, 1_000\);/.test(wk), "the worker reprices every second while the firehose is up");
  const rt = fs.readFileSync(new URL("../src/app/api/px/route.ts", import.meta.url), "utf8");
  ok(/cached\(\{ px: out, at: Date\.now\(\) \}, 1, 2\)/.test(rt) && /px: cache\[m\]\.px/.test(rt), "/api/px: 1s on the CDN, the price itself included");
  const pc = fs.readFileSync(new URL("../src/lib/pxcache.ts", import.meta.url), "utf8");
  ok(/memo\("pxall", 1_000/.test(pc), "server instances re-read the cache every second");
  const lp = fs.readFileSync(new URL("../src/components/livepx.ts", import.meta.url), "utf8");
  ok(/setInterval\(poll, 1500\)/.test(lp) && /> 1200\)/.test(lp), "pages poll every 1.5s");
  const db = fs.readFileSync(new URL("../src/components/DeskBoard.tsx", import.meta.url), "utf8");
  ok(/<LivePnlCell mint=\{p\.mint\} entryPx=\{p\.entryPx\} lastPx=\{p\.lastPx\} \/>/.test(db), "open positions: P&L from the live price");
  const tr = fs.readFileSync(new URL("../src/components/TrackRecord.tsx", import.meta.url), "utf8");
  ok((tr.match(/const t = useLiveTrip\(t0\)/g) || []).length === 2, "records (table and phone cards): open trades' now MC, change and P&L live");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version && BUILD === "0.1.84", `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
