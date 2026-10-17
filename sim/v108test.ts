// v0.1.108 FLOW EXIT: every flow exit variant (trigger x share) scored on the same paper trips; the learner picks the
// variants that hold up (our suggestion until the record is big enough) and twin books run them for real; the desk runs
// a followed twin's flow exit on live money. Run: npx tsx sim/v108test.ts
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
  const F = await import("../src/lib/flowx");

  // ---- 1. triggers fire only on what happens after the buy
  ok(F.fired("kol1", { kx: 0, e20: 0.1 }, { kx: 1, e20: 0.1 }) && !F.fired("kol1", { kx: 1, e20: 0.1 }, { kx: 1, e20: 0.1 }) && F.fired("kol2", { kx: 1, e20: 0 }, { kx: 3, e20: 0 }), "a KOL selling after the buy fires kol1; 2 more fire kol2");
  ok(F.fired("e50", { kx: 0, e20: 0.2 }, { kx: 0, e20: 0.55 }) && !F.fired("e50", { kx: 0, e20: 0.6 }, { kx: 0, e20: 0.8 }) && F.fired("e70", { kx: 0, e20: null }, { kx: 0, e20: 0.75 }), "the early-buyer triggers fire when the line is crossed after the buy");
  ok(!F.fired("kol1", { kx: 0, e20: 0 }, { kx: null, e20: 0 }) && !F.fired("e30", null, null), "unknown never fires");
  ok(F.VARIANTS.length === 10 && F.parseVariant("kol1-50")?.share === 0.5 && F.parseVariant("e70-100")?.trig === "e70" && F.parseVariant("x-50") === null, "10 variants: 5 triggers x (half, all)");

  // ---- 2. the learner: every variant on the same trips, including trips where nothing fired
  const recs: any[] = [];
  for (let i = 0; i < 40; i++) {
    // KOL exits fire on 20 trips: selling then saves 20 points; the early-buyer trigger fires on 15 and costs 10
    const fl: any = {};
    if (i < 20) fl.kol1 = -10;
    if (i >= 20 && i < 35) fl.e50 = -40;
    recs.push({ k: `b${i % 3}`, mint: `m${i}`, at: i, act: -30, flag: -30, why: "x", fl });
  }
  recs.push({ k: "old", mint: "o", at: 0, act: -30, flag: 50, why: "kol" }); // a v0.1.105 record (no notes): left out
  recs.push({ k: "b0~fx:kol1-50", mint: "t", at: 0, act: -30, flag: 0, why: "x", fl: { kol1: 90 } }); // a twin: left out
  const table = F.learnTable(recs);
  const k100 = table.find((s) => s.v === "kol1-100")!;
  const k50 = table.find((s) => s.v === "kol1-50")!;
  const e100 = table.find((s) => s.v === "e50-100")!;
  ok(k100.n === 40 && k100.fired === 20 && k100.uplift === 10 && k100.better === 20, `all out on a KOL exit: +20 pts on the 20 trips it fired, 0 on the rest: +10 a trip over 40 (${JSON.stringify(k100)})`);
  ok(k50.uplift === 5, `half out: half the gain (+5) (${k50.uplift})`);
  ok(e100.uplift < 0 && table[0].v === "kol1-100", "a trigger that cuts too late ranks last; the best variant first");
  const ch = F.chooseVariants(table);
  ok(ch.learned && ch.picks[0] === "kol1-100" && ch.picks[1] === "kol1-50", `the learner picks what held up: ${ch.picks.join(", ")}`);
  ok(F.chooseVariants(F.learnTable(recs.slice(0, 20))).learned === false && F.chooseVariants([]).picks[0] === F.FLOW_SEED, "under 30 trips on record: our starting suggestion (half out on a KOL exit)");
  const lucky = Array.from({ length: 40 }, (_, i) => ({ k: "b", mint: `l${i}`, at: i, act: -10, flag: 0, why: "x", fl: i < 2 ? { kol2: 500 } : i < 12 ? { kol2: -30 } : {} }));
  ok(!F.chooseVariants(F.learnTable(lucky)).picks.includes("kol2-100"), "a variant good only because of 2 trips is not picked");

  // ---- 3. GRID LIVE: positions note every trigger; twins run their variant for real
  const L = await import("../src/lib/gridlive");
  L.gridLiveReset();
  let flow: any = { kx: 0, e20: 0.1 };
  L.setFlowFeatures(() => flow);
  const base = { label: "test", filter: "bond", mode: "now", exit: { initials: 3, trail: 0.25, stop: 0.5, timeMin: 30, mig: "sell" }, since: 0, grid: { testN: 40, testAvg: 3, pass: false } };
  const key = "bond|now|3/0.25/0.5/30/sell";
  L._setBooks([{ ...base, key } as any, { ...base, key: `${key}~fx:kol1-100`, fv: "kol1-100", fxOf: key } as any, { ...base, key: `${key}~fx:e50-50`, fv: "e50-50", fxOf: key } as any]);
  const now = Date.now();
  const cv = (p: number, mc: number, t: number) => L.gridLiveCurve("F", { progress: p, mcapSol: mc, realSol: 20 }, now + t);
  cv(40, 60, 0);
  L.gridLiveCall({ mint: "F", symbol: "F", at: now, createdAt: now - 300_000, verdict: "BOND", score: 90, progress: 40, tp: {} } as any, now);
  cv(40, 60, 100);
  cv(40, 60, 2_500);
  cv(41, 61, 3_000);
  const pos = () => [...L.gridLiveState().pos.values()].filter((p) => p.mint === "F");
  ok(pos().length === 3, "the strategy and its two twins bought the same coin");
  flow = { kx: 0, e20: 0.55 };
  cv(45, 70, 60_000);
  const half = pos().find((p) => p.key.endsWith("e50-50"))!;
  ok(!!half && half.fd === true && half.tokens < pos().find((p) => p.key === key)!.tokens * 0.6, "the e50 twin sold half when half of the first 20 sold");
  ok(pos().find((p) => p.key === key)?.fl?.e50 != null && pos().find((p) => p.key === key)?.fl?.e30 != null, "the plain strategy noted e30 and e50 (both crossed), it did not sell");
  flow = { kx: 1, e20: 0.55 };
  cv(46, 72, 90_000);
  ok(!pos().some((p) => p.key.endsWith("kol1-100")) && L.gridLiveState().trips.some((t) => t.k.endsWith("kol1-100") && /FLOW EXIT: all out when a KOL that bought sells/.test(t.why)), "the kol1 twin sold all when a KOL sold");
  cv(20, 30, 120_000); // -50%: the stop for the rest
  const rec = (await R.lrange<any>(L.FLOWX_KEY, 0, 9)).find((x: any) => x.k === key);
  ok(!!rec && rec.fl.kol1 != null && rec.fl.e50 != null && rec.fl.e70 === undefined, "the plain strategy's record holds a note per trigger that fired");
  const all = await R.lrange<any>(L.FLOWX_KEY, 0, 9);
  ok(all.length === 3, "every flow-watched trip is kept (twins too; the learner leaves twins out)");

  // a coin whose flow is unknown (not seen from its create) is not recorded
  L.gridLiveReset();
  flow = { kx: null, e20: null };
  L._setBooks([{ ...base, key } as any]);
  L.gridLiveCurve("G", { progress: 40, mcapSol: 60, realSol: 20 }, now);
  L.gridLiveCall({ mint: "G", symbol: "G", at: now, createdAt: now - 300_000, verdict: "BOND", score: 90, progress: 40, tp: {} } as any, now);
  L.gridLiveCurve("G", { progress: 40, mcapSol: 60, realSol: 20 }, now + 2_500);
  L.gridLiveCurve("G", { progress: 40, mcapSol: 61, realSol: 20 }, now + 3_000);
  L.gridLiveCurve("G", { progress: 10, mcapSol: 25, realSol: 20 }, now + 60_000);
  ok((await R.lrange<any>(L.FLOWX_KEY, 0, 9)).length === 3, "a trip on a coin with unknown flow is left out of the record");

  // ---- 4. the twins follow the learner
  L.gridLiveReset();
  const trips = Array.from({ length: 12 }, (_, i) => ({ k: key, mint: `p${i}`, symbol: "P", openedAt: i, closedAt: i + 1, pnl: 0.01, pnlPct: 20, why: "trail" }));
  L._setBooks([{ ...base, key } as any]);
  L._setTrips(trips as any);
  const s1 = L.seedFlow(now);
  ok(s1.added.length === 1 && s1.added[0].fv === F.FLOW_SEED && s1.added[0].key === `${key}~fx:${F.FLOW_SEED}` && !L.flowPicks().learned, "before the record is big enough: one twin with our suggestion");
  ok(L.seedFlow(now).added.length === 0, "seeded once");
  const big = recs.slice(0, 40).map((x) => ({ ...x, k: key }));
  for (const x of big.reverse()) await R.lpush(L.FLOWX_KEY, x);
  (L as any)._flowxSet?.(big);
  const s2 = L.seedFlow(now);
  ok(L.flowPicks().learned && L.flowPicks().picks[0] === "kol1-100", `the learner took over: ${L.flowPicks().picks.join(", ")}`);
  ok(s2.added.some((b) => b.fv === "kol1-100") && s2.dropped.length === 0 && s2.changed, "a twin of the learned variant starts (the suggestion's twin stays: the learner still picks it second)");
  // the learner changes its mind: a young twin of a variant it no longer picks makes room
  L._flowxSet(big.map((x: any) => ({ ...x, fl: x.fl.kol1 != null ? { kol2: x.fl.kol1 } : x.fl })));
  const s3 = L.seedFlow(now);
  ok(L.flowPicks().picks[0] === "kol2-100" && s3.dropped.some((b) => b.fv === "kol1-100") && s3.added.some((b) => b.fv === "kol2-100"), `the record now favours kol2: the young kol1 twins leave, kol2 twins start (${L.flowPicks().picks.join(", ")})`);

  // ---- 5. the desk and the worker
  const dk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/if \(o\.fv\) pos\.gf = \{ v: o\.fv, f0: deskFlow\(o\.mint\) \}/.test(dk) && /if \(!g\.frac && p\.gf && !p\.gf\.done\)/.test(dk) && /g = \{ frac: fv\.share, why: `GRID: FLOW EXIT/.test(dk), "a followed twin's flow exit runs on live money (once, half or all)");
  const gl = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  ok(/fv: b\.fv \}\);/.test(gl) && /!b\.parent && !b\.by && !b\.back && !b\.fv/.test(gl), "the follow order carries the variant; twins have their own slots (not GRID's 16)");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/d\.setDeskFlow\(flowOf\)/.test(wk) && /setFlowFeatures\(flowOf\)/.test(wk), "GRID LIVE and the desk read the same flow");
  const rv = await import("../src/lib/review");
  const v: any = await rv.reviewView(Date.now());
  ok(v.flowLearn?.picks?.length >= 1 && /Flow exit learner/.test(rv.reviewText(v)), "the daily review shows the learner's picks and the best variant on record");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 108 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.108 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.108 checks pass");
  process.exit(fail ? 1 : 0);
})();
