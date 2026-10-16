// v0.1.97: LEARNING. LIVE BENCH (a family that fails its exam with real money goes to the ghost desk and earns its way
// back), RESEARCHER reads the desk's live records, and the daily review. Run: npx tsx sim/v097test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const L = (pct: number) => Math.log(1 + pct / 100);
(async () => {
  const fs = await import("fs");
  const pm = await import("../src/lib/pm");
  // exam
  ok(pm.examOf([L(20), L(-10), L(15), L(-5), L(30)]).pass, "a winning record passes");
  ok(pm.benchWhy(Array(9).fill(L(-30)), []) === null, "9 live trips: too early to judge");
  ok(/live trips lose/.test(pm.benchWhy([...Array(8).fill(L(-30)), L(20), L(10)], []) || ""), "10 live trips losing: benched");
  ok(pm.benchWhy(Array(10).fill(L(-30)), Array(5).fill(-10)) !== null && pm.benchWhy(Array(10).fill(L(15)), Array(10).fill(-5))?.includes("worse than paper") === true, "execution gap over 3% on 10 sells: benched");
  ok(pm.benchWhy(Array(10).fill(L(15)), Array(10).fill(-1)) === null, "a winning family with a small gap trades on");
  // paper trips never bench
  for (let i = 0; i < 12; i++) await pm.onClose("flash", L(-30), false);
  ok(!(await pm.sleeveWeight("flash")).hasOwnProperty("bench"), "paper losses do not bench (the 2h brake still can)");
  // live trips bench
  let note: string | null = null;
  for (let i = 0; i < 10; i++) note = (await pm.onClose("momo", L(i < 8 ? -25 : 10), true, -1)) || note;
  const w: any = await pm.sleeveWeight("momo");
  ok(w.paused && /live trips lose/.test(w.bench || "") && /benched from live money/.test(note || ""), `momo benched: ${w.bench}`);
  // ghosts bring it back after 20 passing trips
  let back: string | null = null;
  for (let i = 0; i < 19; i++) back = (await pm.onGhost("momo", L(i % 3 === 0 ? -10 : 25))) || back;
  ok(!back && (await pm.sleeveWeight("momo") as any).bench, "19 ghost trips: still benched");
  back = await pm.onGhost("momo", L(25));
  const w2: any = await pm.sleeveWeight("momo");
  ok(/back on live money/.test(back || "") && !w2.bench && !w2.paused, "20 passing ghost trips: back, fresh live record");
  const v: any = (await pm.pmView()).find((x: any) => x.sleeve === "momo");
  ok(v.live.trips === 0 && v.bench === null, "the view shows the fresh record");
  // desk wiring
  const desk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/!!p\.live && !p\.gk, par\?\.out \?\? null\)/.test(desk), "live desk trips feed the bench (GRID follows answer to GRID LIVE)");
  ok(/is benched from live money/.test(desk), "a benched family's signals go to the ghost desk, with the reason");
  // RESEARCHER
  const rs = await import("../src/lib/researcher");
  const txt = rs.brief(null, { books: [{ key: "k", live: { runner: true, totalPnl: 0.2, lessTop2: -0.1, n: 30 } }] }, {}, 1, [{ family: "flash", live: { trips: 12, avg: -9 }, bench: "x" }]);
  ok(/DESK, REAL MONEY/.test(txt) && /"family":"flash"/.test(txt) && /"lessTop2":-0.1/.test(txt), "RESEARCHER sees live money per family and the runners' records");
  // review
  const rv = await import("../src/lib/review");
  const now = Date.UTC(2026, 9, 17, 6, 55);
  await R.lpush("rn:desk:trades", { live: true, side: "sell", at: now - 3600_000, pnlSol: -0.01, par: { out: -1 } }, { live: true, side: "buy", at: now - 3700_000, par: { tok: 1 } });
  await R.set("rn:rpc", { day: { used: 500000, pace: 520000, budget: 650000 }, loop: { p99: 8 }, exec: { sender: { ok: 3, err: 0, http: 0, last: "" }, liveFee: { prioritySol: 0.0008, n: 12 } } });
  const view = await rv.reviewView(now);
  const t = rv.reviewText(view);
  ok(view.live.roundTrips === 1 && view.live.feeSol === 0.0008 && view.live.sender.ok === 3, "the review reads the worker's counters");
  ok(/daily review/.test(t) && !/—/.test(t) && t.length < 4000, "the message fits Telegram and has no em dash");
  const sent: string[] = [];
  ok((await rv.dailyReview(async (x) => sent.push(x), Date.UTC(2026, 9, 17, 6, 40))).wait === true, "before 06:50 UTC: waits");
  await rv.dailyReview(async (x) => sent.push(x), now);
  await rv.dailyReview(async (x) => sent.push(x), now + 600_000);
  ok(sent.length === 1, "sent once a day");
  ok(/dailyReview\(\(t\) => criticalSend\(t\)\)/.test(fs.readFileSync("worker/index.ts", "utf8")) && fs.existsSync("src/app/api/review/route.ts"), "the worker sends it; /api/review shows it");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 97 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.97 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.97 checks pass");
  process.exit(fail ? 1 : 0);
})();
