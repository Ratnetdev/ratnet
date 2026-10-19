// v0.1.126 RUG GUARD: every paper buy notes the coin's state; rules that would have skipped losing, rug-heavy entries
// (older 70% and newest 30% alike) go live; until then the 45 to 90 second window is skipped live.
// Run: npx tsx sim/v126test.ts
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
  L.gridLiveReset();
  const ef = (o: Partial<import("../src/lib/gridlive").EntryF>) => ({ age: 200, dev: 1, u60: 20, bs60: 0.6, wh: 0, ds: false, og: 1, ...o });

  // ---- 1. the safety default
  ok(L.rugBlock(ef({ age: 65 })) === "45 to 90 seconds after launch" && L.rugBlock(ef({ age: 140 })) === null, "before any study: a buy 65 seconds after launch is skipped live, 140 seconds is not");
  ok(L.rugBlock(null) === null && L.rugBlock(ef({ age: null })) === null, "an unknown state never blocks");

  // ---- 2. the study: copies rug and lose, young coins at 45-90 s turn out fine in this data
  let i = 0;
  const trip = (e: any, pnl: number, rug: boolean) => ({ k: "b", mint: `M${i}`, symbol: "M", openedAt: i * 1000, closedAt: ++i * 1000, pnl, pnlPct: pnl * 2000, why: "", ef: e, rug }) as any;
  const xs: any[] = [];
  for (let n = 0; n < 200; n++) {
    xs.push(trip(ef({ og: 3, age: 150 }), n % 5 ? -0.025 : 0.02, n % 5 !== 0)); // copies: mostly rugs, losing
    xs.push(trip(ef({ age: 60 }), n % 2 ? 0.03 : -0.012, false)); // the window: winning in this data
    xs.push(trip(ef({}), n % 3 ? 0.01 : -0.02, n % 3 === 0 && n % 2 === 0));
  }
  const v = L.rugStudy(xs, 1);
  const row = (id: string) => v.rows.find((r: any) => r.id === id)!;
  ok(row("copy").verdict === "live" && row("copy").test.pnl < 0 && row("copy").skipRug > 1.5 * row("copy").keptRug, `copies: lost money on both halves and rugged ${row("copy").skipRug}% vs ${row("copy").keptRug}%: live`);
  ok(row("age45_90").verdict === "off", "the 45 to 90 second window made money here: its safety block is lifted by the data");
  ok(L.rugBlock(ef({ og: 2, age: 300 })) === "copies an earlier coin's name or ticker" && L.rugBlock(ef({ age: 70 })) === null, "live now: copies blocked, the window open");
  ok(row("dev_sold").verdict === "waiting", "a rule without 20 skipped trips on each half waits");

  // ---- 3. wiring
  const g = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  ok(/ef: entryNow\(pe\.mint, now\)/.test(g) && /t\.rug = now - pos\.openedAt <= RUG_SECS \* 1000 && t\.pnlPct <= -30/.test(g), "each paper buy keeps the coin's state; a stop at -30% or worse within 90 seconds counts as a rug");
  ok(/rug: rugBlock\(pos\.ef\)/.test(g) && /data: pos\.ef \? \{ ef: pos\.ef, rug: !!t\.rug \}/.test(g), "GRID orders carry the guard's verdict; the state goes to the archive with the trip");
  const d = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/if \(o\.rug\) \{/.test(d) && /RUG GUARD, \$\{o\.rug\}/.test(d), "the desk skips a guarded entry and says why");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/setEntryFeatures\(/.test(wk) && /noteDevSol\(c\.mint/.test(wk), "the worker feeds age, dev buy, flow, dev sold and origin");
  ok(/x\.data\?\.ef/.test(fs.readFileSync("src/lib/archive.ts", "utf8")), "a restart restores the states too");
  ok(/RUG GUARD/.test(fs.readFileSync("src/lib/review.ts", "utf8")), "the daily review shows each rule's verdict");
  ok(/avg\(trS\) < avg\(trK\) && avg\(teS\) < avg\(teK\)/.test(g), "a rule must skip trips that do worse than the ones it keeps (most paper trips lose)");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 126 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.126 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.126 checks pass");
  process.exit(fail ? 1 : 0);
})();
