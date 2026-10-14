// v0.1.72: AFTER (pool prices for 6 hours after a migration) and GRID holding through the migration.
// Run: npx tsx sim/v072test.ts
import { MockRedis } from "./mockredis";
import type { GCoin } from "../src/lib/grid";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};

/** A coin: curve ticks (mc, progress) every 10s from the call, then the migration, then pool ticks every 15s. */
function coin(curve: [number, number][], pool: number[], f: Partial<GCoin> = {}): GCoin {
  const rows: { t: number; mc: number; real: number; p: number; d: number }[] = [];
  curve.forEach(([mc, p], i) => rows.push({ t: i * 10_000, mc, real: Math.max(1, mc - 25), p, d: 0 }));
  let t = curve.length * 10_000;
  if (pool.length) {
    rows.push({ t, mc: curve[curve.length - 1][0], real: 85, p: 100, d: 1 });
    pool.forEach((mc, i) => rows.push({ t: t + 5_000 + i * 15_000, mc, real: 85 + i * 0.1, p: 100, d: 2 }));
  }
  const n = rows.length;
  const c: GCoin = { mint: "M", symbol: "M", at: 1_790_000_000_000, createdAt: 1_790_000_000_000 - 300_000, verdict: "BOND", score: 70, nano: 60, progress: curve[0][1], rise60: 10, uniq: 40, spb: 0.4, bs: 0.1, sn: 2, sm: 1, ds: false, soc: 1, t: new Int32Array(n), mc: new Float32Array(n), real: new Float32Array(n), prog: new Float32Array(n), done: new Uint8Array(n), ...f };
  rows.forEach((r, i) => ((c.t[i] = r.t), (c.mc[i] = r.mc), (c.real[i] = r.real), (c.prog[i] = r.p), (c.done[i] = r.d)));
  return c;
}

(async () => {
  const g = await import("../src/lib/grid");
  const sell = { initials: 3, trail: 0.25, stop: 0.25, timeMin: 60, mig: "sell" as const };
  const hold = { ...sell, mig: "hold" as const };
  // called at 80% curve (like the median sender), migrates, then runs 4x in the pool and gives some back
  const curve: [number, number][] = [[300, 80], [310, 83], [330, 88], [350, 93], [370, 97], [380, 99]];
  const run = [390, 420, 500, 650, 800, 1000, 1300, 1600, 1500, 1400, 1150, 1000];
  const c = coin(curve, run);
  const j = g.entryIndex(c, g.MODES.find((m) => m.id === "now")!);
  const ps = g.tradeFrom(c, j, sell)!;
  const ph = g.tradeFrom(c, j, hold)!;
  ok(ps > -0.01 && ps < 0.01, `sell at the migration: the curve's last 20% only (${ps.toFixed(4)} SOL)`);
  ok(ph > 0.05, `hold through the migration: half at 3x in the pool, the rest on the trail (+${ph.toFixed(4)} SOL)`);
  const jm = g.entryIndex(c, g.MODES.find((m) => m.id === "mig")!);
  ok(jm > 0 && c.done[jm] === 2, "the migration entry fills on the first pool price 2+ s after it");
  ok(g.tradeFrom(c, jm, sell) === null, "a migration entry never sells at the migration (no trade)");
  const pm = g.tradeFrom(c, jm, hold)!;
  ok(pm > 0.03, `buying the migration and holding: +${pm.toFixed(4)} SOL (pool fees)`);
  // a migration that dumps: the stop works on pool prices
  const dump = coin(curve, [390, 360, 320, 280, 250, 230]);
  ok(g.tradeFrom(dump, g.entryIndex(dump, g.MODES.find((m) => m.id === "mig")!), hold)! < -0.01, "a migration that dumps hits the stop in the pool");
  ok(g.keyOf("bond", "mig", hold).endsWith("/hold") && g.GEXITS.length === 48 && g.MODES.length === 8, "48 exits (sell or hold at the migration), 8 entry timings");
  ok(g.PREDS.some((p) => p.id === "p70"), "a filter for calls near migration (70%+ curve)");

  // the search finds it: senders bought near migration and held
  const cs: GCoin[] = [];
  for (let i = 0; i < 1600; i++) {
    const sender = i % 5 === 0;
    const x = sender ? coin(curve, i % 3 ? run : run.map((v) => v * 0.7)) : coin([[100, 20], [95, 19], [90, 17], [80, 15], [75, 14], [70, 12], [66, 10]], []);
    x.at += i * 60_000;
    x.mint = `M${i}`;
    if (!sender) (x.verdict = "WATCH"), (x.progress = 20), (x.score = 40);
    else x.progress = 80;
    cs.push(x);
  }
  const v = await g.runGrid(cs);
  ok(v.pooled === 320, `${v.pooled} coins with pool prices`);
  const top = v.rows[0];
  ok(!!top && top.exit.mig === "hold" && top.pass, `the best strategy holds through the migration and passes: ${top?.filterLabel}, ${top?.modeLabel}, ${top?.exitLabel}`);
  ok(v.rows.filter((r) => r.pass).every((r) => r.exit.mig === "hold"), "every passing strategy holds through the migration (selling at it loses here)");

  // ---- AFTER: migrations, pool lookups, 6 hours
  const A = await import("../src/lib/after");
  A.afterReset();
  let T = 1_800_000_000_000;
  ok(A.afterNoteMigration("P", T) && !A.afterNoteMigration("P", T + 1000), "a migration is noted once");
  ok(A.afterWant(T).size === 0, "not followed before its pool is found");
  let reads = 0;
  const reader = async (ms: string[]) => (reads++, Object.fromEntries(ms.map((m) => [m, reads >= 2 ? { px: 1, sol: 85 } : null])));
  await A.afterResolve(reader, T + 1000);
  ok(A.afterWant(T + 1000).size === 0, "pool not there yet (seconds after the migration)");
  await A.afterResolve(reader, T + 5000);
  ok(reads === 1, "looked up again only after 20 seconds");
  await A.afterResolve(reader, T + 25_000);
  ok(A.afterWant(T + 25_000).has("P"), "pool found: followed");
  ok(!A.afterWant(T + 6 * 3600_000 + 1).has("P"), "dropped after 6 hours");

  // ---- GRID LIVE: a hold book rides into the pool, a migration book buys it
  const L = await import("../src/lib/gridlive");
  L.gridLiveReset();
  const rowOf = (filter: string, mode: string, exit: any) => ({ key: g.keyOf(filter, mode, exit), filter, mode, exit, filterLabel: filter, modeLabel: mode, train: v.rows[0].train, test: v.rows[0].test, pass: true, senders: 0 });
  await L.gridLiveSetBooks([rowOf("all", "now", hold), rowOf("all", "mig", hold), rowOf("all", "now", sell)] as any);
  const cv = (mc: number, p: number, done = false) => L.gridLiveCurve("Q", { progress: p, mcapSol: mc, realSol: mc - 25, complete: done }, T);
  T = 1_900_000_000_000;
  cv(300, 80);
  L.gridLiveCall({ mint: "Q", symbol: "Q", createdAt: T - 300_000, verdict: "BOND", score: 70, progress: 80, tp: {} }, T);
  T += 10_000; cv(320, 85);
  const st = () => L.gridLiveState();
  ok(st().pos.size === 2, `the two "at the call" books bought (${st().pos.size})`);
  T += 30_000; cv(380, 100, true);
  ok(st().pos.size === 1 && st().trips[0]?.why === "migrated", "at the migration: the sell book sold, the hold book held");
  for (const mc of [390, 420, 500, 700, 1000, 1300]) {
    T += 15_000;
    L.gridLiveQuote("Q", { mcSol: mc, real: 85 }, T);
  }
  const keys = [...st().pos.keys()];
  ok(keys.some((k) => k.includes("|mig|")), "the migration book bought on a pool price");
  ok([...st().pos.values()].some((p) => p.key.includes("|now|") && p.initials && p.pool), "the hold book took half at 3x in the pool");
  T += 15_000; L.gridLiveQuote("Q", { mcSol: 900, real: 85 }, T);
  ok(st().trips.some((t) => t.why === "trail" && t.pnl > 0), `the rest sold on the trail, in profit (${st().trips.find((t) => t.why === "trail")?.pnlPct}%)`);

  // ---- wiring
  const fs = await import("fs");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/afterNoteMigration\(mint\)/.test(wk) && /archivePoolTick\(/.test(wk) && /gridLiveQuote\(q\.mint/.test(wk) && /afterResolve\(\(ms\) => readPools\(ms\)/.test(wk), "the worker notes migrations, finds the pools, archives the pool prices and feeds GRID LIVE");
  const ar = fs.readFileSync(new URL("../src/lib/archive.ts", import.meta.url), "utf8");
  ok(/alter table ticks add column if not exists pool boolean/.test(ar) && /"complete", "pool"\]/.test(ar), "pool prices are archived as ticks marked pool");
  const gr = fs.readFileSync(new URL("../src/lib/grid.ts", import.meta.url), "utf8");
  ok(/complete, pool from ticks/.test(gr) && /HOLD_MS \+ 30 \* 60_000/.test(gr), "GRID reads 6 hours of pool prices after a call");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
