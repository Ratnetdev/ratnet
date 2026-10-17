// v0.1.71: GRID, the big strategy search. Run: npx tsx sim/v071test.ts
import type { GCoin } from "../src/lib/grid";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
// a seeded random, so the test is the same every run
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/** A coin whose price goes from mc0 by the steps given (one tick every 10s from the call). */
function coin(i: number, steps: number[], f: Partial<GCoin> = {}): GCoin {
  const n = steps.length + 1;
  const t = new Int32Array(n), mc = new Float32Array(n), real = new Float32Array(n), prog = new Float32Array(n), done = new Uint8Array(n);
  let px = 30;
  for (let k = 0; k < n; k++) {
    if (k) px *= 1 + steps[k - 1];
    t[k] = k * 10_000;
    mc[k] = px * 1e9 / 1e9; // mcSol
    real[k] = Math.max(1, px - 25);
    prog[k] = Math.min(99, Math.max(0, (px - 28) * 1.2));
  }
  return { mint: `M${i}`, symbol: `S${i}`, at: 1_790_000_000_000 + i * 60_000, createdAt: 1_790_000_000_000 + i * 60_000 - 90_000, verdict: "WATCH", score: 50, nano: 40, progress: prog[0], rise60: 2, uniq: 15, spb: 0.2, bs: 0.3, sn: 5, sm: 0, ds: false, soc: 0, t, mc, real, prog, done, ...f };
}
const dump = () => Array.from({ length: 60 }, () => -0.02 + (rnd() - 0.55) * 0.04); // drifts down
const walk = () => Array.from({ length: 60 }, () => (rnd() - 0.5) * 0.08); // no drift, no memory: unpredictable
const pump = () => [...Array.from({ length: 12 }, () => 0.06 + rnd() * 0.04), ...Array.from({ length: 40 }, () => (rnd() - 0.5) * 0.03)]; // ~2.5x then chops

(async () => {
  const g = await import("../src/lib/grid");

  // ---- one trade: costs are paid, exits work
  const flat = coin(0, Array(80).fill(0));
  const j = g.entryIndex(flat, g.MODES[0]);
  ok(j === 1, `at the call: fills at the first price 2+ seconds after the signal (tick ${j})`);
  const p0 = g.tradeFrom(flat, j, { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15 })!;
  ok(p0 < 0 && p0 > -0.01, `a flat coin loses only the costs (${p0.toFixed(4)} SOL on ${g.GRID_SOL})`);
  const up = coin(1, pump());
  const pu = g.tradeFrom(up, g.entryIndex(up, g.MODES[0]), { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15 })!;
  ok(pu > 0.02, `a coin that runs ~2.5x: half at 2x, the rest on the trail (+${pu.toFixed(4)} SOL)`);
  const dn = coin(2, dump());
  const pd = g.tradeFrom(dn, g.entryIndex(dn, g.MODES[0]), { initials: 2, trail: 0.25, stop: 0.25, timeMin: 60 })!;
  ok(pd < -0.01 && pd > -0.02, `a dump hits the 25% stop (${pd.toFixed(4)} SOL)`);
  ok(g.entryIndex(dn, g.MODES.find((m) => m.id === "c10")!) === -1, "no climb, no confirmation entry");
  ok(g.entryIndex(up, g.MODES.find((m) => m.id === "c10")!) > 1, "a climbing curve triggers the confirmation entry later");
  ok(g.entryIndex(dn, g.MODES.find((m) => m.id === "h2")!) === -1 && g.entryIndex(up, g.MODES.find((m) => m.id === "h2")!) > 0, "2 minutes later: only if still above the call price");

  // ---- a world with a real edge: a smart wallet + 50 buyers runs 70% of the time; every other coin is a random walk
  const world: GCoin[] = [];
  for (let i = 0; i < 3000; i++) {
    const edge = rnd() < 0.12;
    world.push(coin(i, edge ? (rnd() < 0.7 ? pump() : dump()) : walk(), edge ? { sm: 2, uniq: 60 } : { sm: rnd() < 0.08 ? 1 : 0, uniq: Math.floor(rnd() * 70) }));
  }
  const v = await g.runGrid(world);
  ok(v.coins === 3000 && v.trainN === 2100 && v.testN === 900, "70/30 split by call time");
  ok(v.tried >= 1000, `${v.tried} combinations tried`);
  const top = v.rows[0];
  ok(!!top && /smart wallet|50\+ unique|PROFIT SCORE/.test(top.filterLabel), `the edge is found: "${top?.filterLabel}"`);
  ok(v.passed >= 1 && v.rows.some((r) => r.pass && /smart wallet/.test(r.filterLabel)), `and it passes on the unseen test calls (${v.passed} candidates)`);
  const sigs = v.rows.map((r) => `${r.mode}:${r.train.n}:${r.train.pnl}`);
  ok(new Set(sigs).size === sigs.length, "rules that pick the same trades are listed once (the simplest)");
  ok(!!g.gridMessage(v) && /GRID found/.test(g.gridMessage(v)!), "a pass makes a Telegram note");


  // ---- learning across runs
  let hist = g.gridHistory(null, v);
  hist = g.gridHistory(hist, v);
  g.withSeen(v, hist);
  ok(v.rows[0].seen?.runs === 2 && v.rows[0].seen?.ranked === 2, `a strategy's record across runs is kept (${JSON.stringify(v.rows[0].seen)})`);
  const cands = g.liveCandidates(v);
  ok(cands.length > 0 && cands.length <= 8 && cands[0].pass, `up to 8 go live, passed ones first (${cands.length})`);

  // ---- the senders study
  const st = v.senders;
  ok(st.senders === 0, "no migrations in this synthetic world: none counted");
  const sw = world.map((c, i) => ({ ...c, bonded: c.sm >= 2 ? i % 3 !== 0 : i % 40 === 0, bondSecs: 1800 }));
  const sv = await g.runGrid(sw);
  ok(sv.senders.senders > 100 && sv.senders.lifts[0] && /smart wallet|50\+ unique/.test(sv.senders.lifts[0].label) && sv.senders.lifts[0].lift > 2, `what senders had at the call: ${sv.senders.lifts[0]?.label} ${sv.senders.lifts[0]?.lift}x`);
  ok(sv.senders.fast === sv.senders.senders, "migrations within the hour counted");
  ok(sv.rows.some((r) => r.senders > 0), "each strategy shows how many migrated coins it caught");

  // ---- GRID LIVE: the strategies trade live coins exactly as tested
  const L = await import("../src/lib/gridlive");
  L.gridLiveReset();
  const mkRow = (filter: string, mode: string, exit = { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15 }) => ({ ...v.rows[0], key: g.keyOf(filter, mode, exit), filter, mode, exit, filterLabel: filter, modeLabel: mode });
  await L.gridLiveSetBooks([mkRow("sm", "now"), mkRow("all", "c10"), mkRow("all", "h2"), mkRow("u50+sm", "now")] as any);
  let T = 1_800_000_000_000;
  const cv = (m: string, mc: number, p: number, done = false) => L.gridLiveCurve(m, { progress: p, mcapSol: mc, realSol: Math.max(1, mc - 25), complete: done }, T);
  cv("A", 30, 10);
  L.gridLiveCall({ mint: "A", symbol: "A", createdAt: T - 90_000, verdict: "WATCH", score: 50, progress: 10, tp: { sm: 1, uniq: 20 } }, T);
  const st0 = L.gridLiveState();
  ok(st0.pend.size === 3, `a call with a smart wallet: 3 books start watching (not the 50-buyer one): ${st0.pend.size}`);
  T += 1_000; cv("A", 31, 11);
  ok(st0.pos.size === 0, "no fill within 2 seconds of the signal");
  T += 9_000; cv("A", 31, 11);
  ok([...st0.pos.values()].some((p) => p.key.startsWith("sm|now")), "filled on the first update 2+ seconds after the call");
  T += 10_000; cv("A", 40, 22);
  ok([...st0.pos.values()].filter((p) => p.mint === "A").length === 1, "the climb book waits for the fill after its +10 points trigger");
  T += 10_000; cv("A", 45, 26);
  ok([...st0.pos.values()].filter((p) => p.mint === "A").length === 2, "and fills on the next update");
  T += 10_000; cv("A", 70, 50);
  const smPos = [...st0.pos.values()].find((p) => p.key.startsWith("sm|now"))!;
  ok(smPos.initials, "half sold at 2x");
  T += 10_000; cv("A", 50, 35);
  ok(!st0.pos.has(`${smPos.key}#A`), "the rest sold on the 25% trail");
  const tr0 = L.gridLiveState().trips[0];
  ok(!!tr0 && tr0.pnl > 0 && tr0.why === "trail", `a winning trip recorded (${tr0?.pnlPct}%)`);
  T += 2 * 60_000; L.gridLiveSweep(T);
  ok(![...st0.pend.keys()].some((k) => k.includes("h2")), "the 2-minute book: entered or dropped at 2 minutes");
  T += 20 * 60_000; L.gridLiveSweep(T);
  ok([...L.gridLiveState().pos.values()].every((p) => p.mint !== "A") && L.gridLiveState().trips.some((t) => t.why === "time"), "a coin that stopped trading is sold on the time exit");
  // the exam on live trips: 30 trips, 40%+ won, +0.1 SOL, PF 1.2+
  const trips = Array.from({ length: 30 }, (_, i) => ({ k: "x", mint: `m${i}`, symbol: "s", openedAt: 0, closedAt: i, pnl: i % 2 ? 0.02 : -0.008, pnlPct: i % 2 ? 40 : -16, why: "t" }));
  const ls = L.liveStat(trips);
  ok(ls.passed && ls.winRate === 50, `the desk's exam on a live record: passed (${ls.pnl} SOL, PF ${ls.pfLessBest})`);
  ok(!L.liveStat(trips.slice(0, 20)).passed, "fewer than 30 trips never pass");
  let sent = "";
  const lv = await L.gridLivePublish(async (t) => (sent = t));
  ok(lv.books.length === 4 && (await R.get(L.LIVE_VIEW)) != null, "the live books are published for /desk");
  ok(sent === "", "no Telegram before a live pass");

  // ---- a world with no edge at all: nothing may pass (the search must not fool us)
  const noise: GCoin[] = [];
  for (let i = 0; i < 3000; i++) noise.push(coin(i, walk(), { sm: rnd() < 0.15 ? 1 : 0, uniq: Math.floor(rnd() * 70), spb: rnd(), bs: rnd() * 0.5, sn: Math.floor(rnd() * 8), soc: rnd() < 0.5 ? 1 : 0, score: Math.floor(rnd() * 100), nano: Math.floor(rnd() * 100), verdict: rnd() < 0.2 ? "BOND" : "WATCH" }));
  const nv = await g.runGrid(noise);
  ok(nv.passed === 0, `pure noise: ${nv.passed} pass (the test split catches lucky picks)`);
  ok(g.gridMessage(nv) === null, "no pass, no Telegram");

  // ---- speed: the worker runs it every 3 hours next to everything else
  const big: GCoin[] = [];
  for (let i = 0; i < 8000; i++) big.push(coin(i, rnd() < 0.15 ? pump() : dump()));
  const t0 = Date.now();
  await g.runGrid(big);
  const ms = Date.now() - t0;
  ok(ms < 90_000, `8,000 calls searched in ${(ms / 1000).toFixed(1)}s`);

  // ---- wiring
  const fs = await import("fs");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/archiveGrid\(/.test(wk) && /3 \* 3600_000/.test(wk) && /if \(gridding \|\| replaying\) return/.test(wk), "the worker runs GRID every 3 hours, never next to REPLAY");
  const ar = fs.readFileSync(new URL("../src/lib/archive.ts", import.meta.url), "utf8");
  ok(/export async function archiveGrid/.test(ar), "GRID reads the archive");
  const rp = fs.readFileSync(new URL("../src/lib/replay.ts", import.meta.url), "utf8");
  ok(/order by created_at desc limit 5000/.test(rp), "REPLAY reads the newest 5,000 calls (it was stuck on 11 Oct)");
  const db = fs.readFileSync(new URL("../src/components/DeskBoard.tsx", import.meta.url), "utf8");
  ok(/<GridBoard \/>/.test(db) && /<GridLiveBoard embedded/.test(fs.readFileSync(new URL("../src/components/TrackRecord.tsx", import.meta.url), "utf8")), "GRID on /desk, GRID LIVE inside the records (v0.1.77)");
  ok(/gridLiveCurve\(mint, v as any\)/.test(wk) && /setCallHook\(\(call\) => \{\s*gridLiveCall\(call\)/.test(wk) && /gridLiveSetBooks\(liveCandidates\(res, 16\)\)/.test(wk) && /gridHistory\(/.test(wk), "the worker feeds GRID LIVE every curve update and call, refills it after each run, and keeps the record across runs");
  const dg = fs.readFileSync(new URL("../src/lib/digger.ts", import.meta.url), "utf8");
  ok(/CALL_HOOK\?\.\(rec\.call\)/.test(dg), "every on-time call reaches GRID LIVE");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
