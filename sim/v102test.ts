// v0.1.102 SEER: see the coin before it exists. The FTR replay (a 130K post, "Flying Tesla Roadster" 135s later), the
// watchlist rules, GRID's SEER rules, the SEER family on GRID LIVE, its probation exam and the sell-the-news exit.
// Run: npx tsx sim/v102test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test";
// no network in the test: every collector that fetches fails (its error is counted, the others go on)
(globalThis as any).fetch = async () => {
  throw new Error("offline");
};
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const S = await import("../src/lib/seer");
  const g = await import("../src/lib/grid");
  const L = await import("../src/lib/gridlive");

  // ---- 1. the FTR replay: the post arrives, SEER arms the names, the coin is created 135s later
  const now = Date.now();
  const postAt = now - 60_000;
  await R.lpush("rn:x:tw", { id: "1978", h: "niccruzpatane", f: 130_148, at: postAt, text: "Buckle up. Roadster is launching tomorrow.", kind: "post" });
  let asked = "";
  const forecast = async (_sys: string, blocks: any[]) => {
    asked = blocks[0].text;
    return JSON.stringify({ arm: [{ id: "tw:1978", names: ["Flying Tesla Roadster", "Tesla Roadster", "Flying Roadster"], tickers: ["FTR", "ROADSTER", "$TROAD", "TOOLONGTICKER1"], tier: 1, at: null, hours: 48, why: "Elon's Roadster demo" }, { id: "nope", names: ["x"], tickers: ["XXX"], tier: 1 }] });
  };
  const t = await S.seerTick(now, forecast as any);
  ok(/id tw:1978 \[post\]/.test(asked) && /130K followers/.test(asked), "the 130K post reached the forecaster");
  ok(t.armed === 1 && t.total === 1, `one entry armed; an id the forecaster made up is ignored (${JSON.stringify(t)})`);
  const a = S.seerArmed()[0];
  ok(a.tickers.join() === "FTR,ROADSTER,TROAD" && a.tier === 1 && a.until >= now + 47 * 3600_000, "tickers cleaned ($ dropped, too long refused), watched for 48h");
  const createdAt = postAt + 135_000;
  const t0 = performance.now();
  const m = S.seerSee("FTRmint", "Flying Tesla Roadster", "FTR", createdAt, "", createdAt + 400);
  const took = performance.now() - t0;
  ok(!!m && m.rank === 1 && m.tier === 1 && m.by === "ticker" && m.lagMs === 400, `FTR matched at its create, the first coin for it (${JSON.stringify(m)})`);
  ok(took < 5, `matching takes ${took.toFixed(2)}ms (the buy can go in the coin's first second)`);
  const copy = S.seerSee("copy1", "flying tesla roadster 2.0", "FTR2", createdAt + 30_000);
  ok(!!copy && copy.rank === 2 && copy.by === "name", "a later coin with the name is a copy (rank 2), matched on its name");
  ok(S.seerSee("FTRmint", "Flying Tesla Roadster", "FTR", createdAt) === m, "the same coin seen again (both feeds) is one match");
  ok(S.seerSee("other", "Dog Wif Hat", "WIF", createdAt) === null, "an unrelated launch does not match");
  ok(S.seerSee("tx", "Elon car", "ECAR", createdAt, "elon just said the flying tesla roadster ships") !== null, "the dig's text (description, linked post) matches too");
  ok(S.seerSee("short", "Road", "RD", createdAt) === null, "short names and tickers never match on their own (no 'road' coin for 'Roadster')");
  ok((await R.lrange<any>("rn:seer:matches", 0, 9)).some((x: any) => x.mint === "FTRmint" && x.sym === "FTR"), "matches are kept for the review and the site");
  const view: any = await R.get("rn:seer:view");
  ok(view?.armed?.[0]?.tickers?.includes("FTR") && view.stats.runs === 1, "the watchlist is published (rn:seer:view)");
  const t2 = await S.seerTick(now + 600_000, forecast as any);
  ok(t2.fresh === 0, "an item already forecast is not asked again");
  // the watchlist survives a restart
  S._seerReset();
  ok((await S.seerLoad(now)) === 1 && S.seerSee("FTRmint2", "x", "ROADSTER", now) !== null, "a restarted worker loads the watchlist from Redis");

  // ---- 2. the forecaster's answer is checked
  const items = new Map([["e1", { id: "e1", src: "launch", title: "Starship flight 12", at: now + 3 * 86400_000, weight: 1 }]]);
  const c1 = S.checkArm({ id: "e1", names: ["Starship"], tickers: ["SHIP"], tier: 7, hours: 500 }, items, now)!;
  ok(c1.tier === 3 && c1.until === now + 4 * 86400_000, "tier out of range becomes 3; watched until a day after the event");
  ok(S.checkArm({ id: "e1", names: [], tickers: ["$"] }, items, now) === null, "nothing usable: not armed");
  const c2 = S.checkArm({ id: "e1", names: ["Starship"], tickers: [], at: new Date(now + 30 * 86400_000).toISOString() }, items, now)!;
  ok(c2.until <= now + 8 * 86400_000, "never watched more than 8 days out");

  // ---- 3. GRID: the SEER rules
  const ids = g.PREDS.map((p) => p.id);
  ok(["seer", "seertop", "seerfirst"].every((x) => ids.includes(x)) && ids.indexOf("seer") > ids.indexOf("mindwatch"), "3 SEER rules on GRID's menu, appended after the others");
  const pred = (id: string) => g.PREDS.find((p) => p.id === id)!;
  const first: any = { sx: { seer: { tier: 1, rank: 1 } } };
  const copy2: any = { sx: { seer: { tier: 2, rank: 3 } } };
  ok(pred("seer").ok(first) && pred("seertop").ok(first) && pred("seerfirst").ok(first) && pred("seer").ok(copy2) && !pred("seertop").ok(copy2) && !pred("seerfirst").ok(copy2) && !pred("seer").ok({ sx: null } as any), "each rule reads the match");
  const gs = fs.readFileSync("src/lib/grid.ts", "utf8");
  ok(!/lifts[\s\S]{0,200}\.slice\(0, 8\)/.test(gs), "GRID keeps every rule's lift (new rules no longer cut at the top 8)");

  // ---- 4. the SEER family on GRID LIVE
  L.gridLiveReset();
  await L.gridLiveTend();
  const sb = L.gridLiveBooks().filter((b) => b.by === "seer");
  ok(sb.length === L.SEER_SEEDS.length && sb.every((b) => b.any && /\bseer/.test(b.key)), `the SEER family trades (${sb.length} books)`);
  await L.gridLiveTend();
  ok(L.gridLiveBooks().filter((b) => b.by === "seer").length === sb.length, "seeded once");
  const ev = Date.now() + 60_000;
  const T = Date.now();
  L.gridLiveSeer("FTRMINT", { tier: 1, rank: 1, at: ev }, T);
  ok(![...L.gridLiveState().pend.keys()].some((k) => k.includes("FTRMINT")), "matched before its first price: queued");
  L.gridLiveCurve("FTRMINT", { progress: 2, mcapSol: 30, realSol: 1 }, T + 300);
  const pend = [...L.gridLiveState().pend.keys()].filter((k) => k.includes("FTRMINT"));
  ok(pend.length >= 4, `its first price starts the SEER books at once (${pend.length} entries)`);
  L.gridLiveCurve("FTRMINT", { progress: 3, mcapSol: 31, realSol: 1.2 }, T + 2_500);
  L.gridLiveCurve("FTRMINT", { progress: 3, mcapSol: 31, realSol: 1.2 }, T + 5_000);
  const pos = [...L.gridLiveState().pos.values()].filter((p) => p.mint === "FTRMINT");
  ok(pos.length === L.SEER_SEEDS.length - 1 && !pos.some((p) => /\|c5\|/.test(p.key)), `bought within seconds (${pos.length} paper positions); the minute-5 book waits for minute 5`);
  L.gridLiveCurve("FTRMINT", { progress: 4, mcapSol: 32, realSol: 1.3 }, ev + 16 * 60_000);
  const sold = L.gridLiveState().trips.filter((x) => x.mint === "FTRMINT");
  ok(sold.length >= 4 && sold.every((x) => /sold the news/.test(x.why)), `15 minutes after the event: sold the news (${sold.map((x) => x.why).join("; ")})`);

  // ---- 5. probation: 15 trips, in profit, also without the 2 best -> the desk may follow at the minimum size
  const key = L.SEER_SEEDS[0];
  const tr = (pnl: number, i: number) => ({ k: key, mint: `s${i}`, symbol: "X", openedAt: i, closedAt: i + 1, pnl, pnlPct: (pnl / 0.0525) * 100, why: "t" });
  const B = { grid: { testN: 0, testAvg: 0, pass: false }, key };
  const good = Array.from({ length: 15 }, (_, i) => tr(i % 3 === 0 ? 0.04 : -0.01, i));
  const sg = L.bookStat(B, good as any);
  ok(sg.passed && sg.probation === true, `15 trips in profit, still in profit without the 2 best: on probation (${sg.totalPnl} SOL, ${sg.lessTop2} without them)`);
  const lucky = Array.from({ length: 15 }, (_, i) => tr(i < 2 ? 0.2 : -0.01, i));
  ok(!L.bookStat(B, lucky as any).passed, "in profit only because of 2 coins: no probation");
  ok(!L.bookStat(B, good.slice(0, 14) as any).passed, "14 trips: not yet");
  ok(!L.bookStat({ ...B, key: "any:bond|now|2/0.25/0.25/15/sell" }, good as any).probation, "probation is for SEER books only");
  const dk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/o\.probation \? Math\.min\(cfg\.minSol, liqCap, avail \* 0\.95\)/.test(dk) && /const plan = o\.probation \? null/.test(dk), "the desk trades a probation book at the minimum size, no compounding");
  const gl = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  ok(/Number\(!!a\.s\.probation\) - Number\(!!z\.s\.probation\)/.test(gl), "a fully passed book leads before a probation one");

  // ---- 6. the worker
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok((wk.match(/seerOn\(/g) || []).length === 3, "both launch feeds check every create against the watchlist");
  ok(/await seerLoad\(\)/.test(wk) && /setInterval\(seerRun, 10 \* 60_000\)/.test(wk) && /if \(seerBusy\) return;/.test(wk), "SEER loads at boot and looks ahead every 10 minutes, one pass at a time");
  const dg = fs.readFileSync("src/lib/digger.ts", "utf8");
  ok(/seerSee\(l\.mint, l\.name, l\.symbol, l\.createdAt/.test(dg), "the dig checks the description and linked post too");
  const rv = await import("../src/lib/review");
  const v: any = await rv.reviewView(Date.now());
  ok(v.seer && v.seer.matches.some((x: any) => x.sym === "FTR") && /SEER<\/b>: watching for/.test(rv.reviewText(v)), "the daily review reports the watchlist and the matches");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 102 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.102 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.102 checks pass");
  process.exit(fail ? 1 : 0);
})();
