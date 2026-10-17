// v0.1.115 EARLY + WIN SCORE: every launch read at 2 minutes (before any call), archived with its path; the EARLY search
// (GRID on those reads, its own scores and checks) and EARLY books on live launches; the WIN SCORE (fitted on how much
// a trade made, capped). Run: npx tsx sim/v115test.ts
import type { GCoin } from "../src/lib/grid";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
let seed = 33;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function coin(i: number, steps: number[], f: Partial<GCoin> = {}): GCoin {
  const n = steps.length + 1;
  const t = new Int32Array(n), mc = new Float32Array(n), real = new Float32Array(n), prog = new Float32Array(n), done = new Uint8Array(n);
  let px = 30;
  for (let k = 0; k < n; k++) {
    if (k) px *= 1 + steps[k - 1];
    t[k] = k * 60_000;
    mc[k] = px;
    real[k] = Math.max(1, px - 25);
    prog[k] = Math.min(99, Math.max(0, (px - 28) * 1.2));
  }
  return { mint: `M${i}`, symbol: `S${i}`, at: 1_790_000_000_000 + i * 60_000, createdAt: 1_790_000_000_000 + i * 60_000 - 90_000, verdict: "WATCH", score: 50, nano: 40, progress: prog[0], rise60: 2, uniq: 15, spb: 0.2, bs: 0.3, sn: 5, sm: 0, ds: false, soc: 0, t, mc, real, prog, done, ...f };
}
const walk = () => Array.from({ length: 80 }, () => (rnd() - 0.52) * 0.08);
const small = () => [...Array.from({ length: 8 }, () => 0.035), ...Array.from({ length: 70 }, () => -0.012)]; // +30%, then bleeds
const moon = () => [...Array.from({ length: 30 }, () => 0.09 + rnd() * 0.04), ...Array.from({ length: 40 }, () => (rnd() - 0.5) * 0.02)]; // 10x+

(async () => {
  const fs = await import("fs");
  const g = await import("../src/lib/grid");

  // ---- 1. WIN SCORE: many small wins (sm) vs rarer big ones (soc). "Paid" likes sm; the size of the win likes soc
  ok(Math.abs(g.fitRidge([Uint8Array.from([1, 1, 0, 0, 1, 0, 1, 0])], Float64Array.from([1, 1, 0, 0, 1, 0, 1, 0]), 8, 0).w[0] - 1) < 1e-9, "ridge regression recovers a clean weight");
  const world: GCoin[] = [];
  for (let i = 0; i < 3000; i++) {
    const a = rnd() < 0.2, b = rnd() < 0.15;
    const path = a ? (rnd() < 0.8 ? small() : walk()) : b ? (rnd() < 0.3 ? moon() : walk()) : walk();
    world.push(coin(i, path, { sm: a ? 1 : 0, soc: b ? 1 : 0 }));
  }
  g.setScoreModel(null), g.setProfitModel(null), g.setWinModel(null);
  const v = await g.runGrid(world, { nulls: 0, fitScore: false });
  ok(!g.scoreModel() && !g.profitModel() && !g.winModel(), "a search with fitScore off leaves the live calls' scores alone (the EARLY search)");
  ok(!!v.wscore.model && v.wscore.model.ids.includes("soc"), "the WIN SCORE is fitted");
  const ww = (id: string) => v.wscore.model!.w[v.wscore.model!.ids.indexOf(id)];
  ok(ww("soc") > ww("sm"), `it weighs the big wins over the small ones (social ${ww("soc").toFixed(2)} vs smart wallet ${ww("sm").toFixed(2)})`);
  ok((v.wscore.test?.edge ?? 0) > 5, `on the newer calls its top 20% beat the average trade by ${v.wscore.test?.edge} pts`);
  const whit = g.withScoreModels({ mig: null, pft: null, win: v.wscore.model }, () => g.PREDS.find((p) => p.id === "wscore20")!.ok(world.find((c) => c.soc === 1)!));
  ok(whit && !g.PREDS.find((p) => p.id === "wscore20")!.ok(world.find((c) => c.soc === 1)!), "a score rule reads the scores it is given (EARLY's), and none outside them");

  // ---- 2. the 2-minute read
  const E = await import("../src/lib/early");
  process.env.EARLY_CHECKS = "120"; // v0.1.117 reads at several ages (v117test); this test is about the 2-minute one
  E._earlyReset();
  const t0 = 1_790_000_000_000;
  E.earlyCreate("LIVE", t0, "LIV");
  E.earlyCreate("DEAD", t0, "DED");
  E.earlyCreate("YOUNG", t0 + 60_000, "YNG");
  E.earlyCurve("LIVE", { progress: 6, mcapSol: 33, realSol: 3 }, t0 + 61_000);
  E.earlyCurve("LIVE", { progress: 14, mcapSol: 38, realSol: 6 }, t0 + 110_000);
  E.earlyCurve("DEAD", { progress: 2, mcapSol: 29, realSol: 1 }, t0 + 100_000);
  const feat = () => ({ pw: 1, u60: 30, bs60: 0.8, wh: 1, ds: false, kf: 2, kmu: 4000, kx: 0, e20: 0.1, og: { rank: 1, cr: 0, alpha: null, beta: null }, dx: { paid: 1 as const, boost: 0 } });
  const reads = E.earlySweep(feat, t0 + 121_000);
  ok(reads.length === 1 && reads[0].mint === "LIVE" && E.earlyStats.skipped === 1, "at 2 minutes: a launch 5%+ up its curve is read; one under 5% is not; one younger waits");
  ok(reads[0].f.p === 14 && reads[0].f.r60 === 8 && reads[0].f.kf === 2 && reads[0].f.og?.rank === 1 && reads[0].f.dx?.paid === 1, "the read: curve, its last minute, wallets, KOL flow, origin and DexScreener");
  const c0 = E.earlyCoin("LIVE", reads[0].at, t0, reads[0].f) as GCoin;
  const P = (id: string) => g.PREDS.find((p) => p.id === id)!.ok(c0);
  ok(!P("bond") && !P("s60") && P("first") && P("dexpaid") && P("kolsmall") && P("hold20") && P("pw1"), "as a GRID coin: no King call (call rules never pass), every firehose rule reads it");
  process.env.EARLY_PER_DAY = "0";
  E.earlyCreate("CAP", t0 + 200_000);
  E.earlyCurve("CAP", { progress: 20, mcapSol: 40, realSol: 8 }, t0 + 300_000);
  ok(E.earlySweep(feat, t0 + 321_000).length === 0 && E.earlyStats.capped === 1, "a daily cap (EARLY_PER_DAY) keeps the archive in bounds");
  delete process.env.EARLY_PER_DAY;

  // ---- 3. the EARLY search loads every read with its path; a coin nobody traded after its read counts as flat
  const at = Date.now() - 3 * 3600_000;
  const pool = {
    async query(sql: string) {
      if (/from early_reads/.test(sql))
        return {
          rows: [
            { mint: "A", at: new Date(at).toISOString(), created_at: new Date(at - 120_000).toISOString(), f: { ...feat(), p: 10, mc: 35, real: 5, r60: 3, sym: "A" }, outcome: "BONDED", bond_secs: 900 },
            { mint: "Z", at: new Date(at).toISOString(), created_at: new Date(at - 120_000).toISOString(), f: { ...feat(), p: 8, mc: 33, real: 4, r60: 1, sym: "Z" }, outcome: null, bond_secs: null },
          ],
        };
      if (/from ticks/.test(sql)) return { rows: [10_000, 20_000, 70_000].map((d, k) => ({ mint: "A", at: new Date(at + d).toISOString(), progress: 10 + k * 5, mc_sol: 35 + k * 5, real_sol: 5 + k, complete: false, pool: false })) };
      return { rows: [] };
    },
  };
  const ec = await E.loadEarly(pool, 10);
  const A = ec.find((c) => c.mint === "A")!, Z = ec.find((c) => c.mint === "Z")!;
  ok(ec.length === 2 && A.bonded && A.t[0] === 0 && A.t.length === 4 && A.verdict === "EARLY", "every read loads, its path from the read on (the read is its first price)");
  ok(!!Z && Z.t.length === 3 && Z.mc[2] === Z.mc[0] && g.entryIndex(Z, g.MODES[0]) === 1, "a coin nobody traded after its read is kept: flat, a trade that pays only the costs (no survivors-only bias)");
  const zp = g.tradeFrom(Z, 1, g.RUNNER_EXITS[0])!;
  ok(zp < 0 && zp > -0.01, `that flat trade loses the costs only (${zp.toFixed(4)} SOL)`);

  // ---- 4. EARLY books on live launches
  const L = await import("../src/lib/gridlive");
  L.gridLiveReset();
  const ex = { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15, mig: "sell" as const };
  const row: any = { key: g.keyOf("dexpaid", "now", ex), filter: "dexpaid", filterLabel: "a DexScreener profile was paid", mode: "now", modeLabel: "at the call", exit: ex, exitLabel: "", train: {}, test: { n: 30, avgPct: 6 }, pass: false, senders: 0 };
  const eb = await L.gridLiveEarlyBooks([row], []);
  ok(eb.length === 1 && eb[0].key === `early:${row.key}` && eb[0].early && eb[0].by === "early", `the EARLY search's rows in profit on its test become EARLY books (${eb[0]?.key})`);
  L.gridLiveCurve("LIVE", { progress: 14, mcapSol: 38, realSol: 6 }, t0 + 120_000);
  L.gridLiveCall({ mint: "LIVE", symbol: "LIV", at: t0 + 120_000, createdAt: t0, verdict: "BOND", score: 90, progress: 14, tp: {}, sx: { dx: { paid: 1, boost: 0 } } }, t0 + 120_000);
  ok(![...L.gridLiveState().pend.keys()].some((k) => k.startsWith("early:")), "a King call never triggers an EARLY book");
  ok(L.gridLiveEarly("LIVE", c0, t0 + 121_000) === 1 && [...L.gridLiveState().pend.keys()].some((k) => k.startsWith("early:") && k.endsWith("#LIVE")), "the 2-minute read does: it starts its entry (2 seconds later, like GRID tested it)");
  ok((await L.gridLiveEarlyBooks([row], [])).length === 0, "seeded once");

  // ---- 5. the SCORE family's WIN SCORE gate
  L.gridLiveReset();
  g.setScoreModel(null), g.setProfitModel(null);
  g.setWinModel({ ...v.wscore.model!, edge: 2 });
  ok(L.seedScore(Date.now()).length === 0, "a WIN SCORE whose top 20% beat the average by under 5 pts: not traded");
  g.setWinModel({ ...v.wscore.model!, edge: 12 });
  const sb = L.seedScore(Date.now());
  ok(sb.length === 2 && sb[0].key.startsWith("wscore10"), `5+ pts: its bands trade first (${sb.map((b) => b.key.split("|")[0]).join(", ")})`);

  // ---- 6. wiring
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/earlyCreate\(c\.mint/.test(wk) && /earlyCurve\(mint/.test(wk) && /earlyPool\(mint/.test(wk) && /earlySweep\(/.test(wk) && /gridLiveEarly\(r\.mint/.test(wk), "the worker reads every launch at 2 minutes from the firehose and hands the reads to the EARLY books");
  ok(/archiveEarlyGrid\(10/.test(wk) && /rn:grid:early/.test(wk) && /gridLiveEarlyBooks\(er\.rows, er\.explore/.test(wk) && /setEarlyModels\(\{ mig: v\?\.score\?\.model/.test(wk), "the EARLY search runs with GRID (hourly), its books and scores follow it, the scores load at boot");
  ok(/early_reads/.test(fs.readFileSync("src/lib/archive.ts", "utf8")) && fs.existsSync("src/app/api/desk/gridearly/route.ts"), "the reads are archived (early_reads, 21 days) and the search is on /api/desk/gridearly");
  ok(/EARLY/.test(fs.readFileSync("src/lib/review.ts", "utf8")) && /WIN SCORE/.test(fs.readFileSync("src/lib/review.ts", "utf8")), "the daily review shows both");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 115 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.115 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.115 checks pass");
  process.exit(fail ? 1 : 0);
})();
