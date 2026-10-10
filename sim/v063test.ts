// v0.1.63: REGIME switches the desk's strategies with the market. Run: npx tsx sim/v063test.ts
import { MockRedis } from "./mockredis";
process.env.PROVING_MODE = "off"; // v0.1.66: this suite tests REGIME's market gate alone
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const { K, hourKey } = await import("../src/lib/redis");
  const g = await import("../src/lib/regimegate");
  const now = Date.UTC(2026, 9, 9, 14, 20);
  const day = (d: number, b: number) => Array.from({ length: 26 }, () => ({ d, b, g: 20 }));

  // ---- market state
  let m = g.classify(day(1000, 10), 0.5, 1);
  ok(m.state === "normal", `steady day (1% graduate all day): ${m.state}`);
  let rows = day(1000, 10);
  for (let i = 2; i < 5; i++) rows[i] = { d: 1000, b: 4, g: 5 };
  m = g.classify(rows, 0, 0);
  ok(m.state === "dead", `graduations fall to 0.4% vs ~1% over the day: ${m.state}`);
  rows = day(1000, 10);
  for (let i = 2; i < 5; i++) rows[i] = { d: 1000, b: 6, g: 8 };
  ok(g.classify(rows, 0, 0).state === "cold", "graduations at ~60% of the day: cold");
  ok(g.classify(day(1000, 10), 0, -6).state === "cold", "SOL -6% in 24h: cold");
  ok(g.classify(day(1000, 10), 0, -12).state === "dead", "SOL -12% in 24h: dead");
  rows = day(1000, 10);
  for (let i = 1; i < 5; i++) rows[i] = { d: 1000, b: 16, g: 20 };
  ok(g.classify(rows, 1, 2).state === "hot", "graduations 1.5x the day: hot");
  m = g.classify(Array.from({ length: 26 }, () => ({ d: 0, b: 0, g: null })), null, null);
  ok(m.state === "normal" && m.gradNow == null, "no data (fresh counters): normal, never blocks");

  // ---- hit rates from ARENA
  const T = (v: string, mint: string, pnlPct: number, ago = 60_000) => ({ v, mint, closedAt: now - ago, pnlPct });
  const trips = [
    // the same coin in 3 King books counts once (averaged)
    T("nonano", "A", -40), T("nonano_late", "A", -40), T("strict", "A", -40),
    ...Array.from({ length: 9 }, (_, i) => T("nonano", `K${i}`, i < 1 ? 30 : -30)),
    T("momo_now", "M1", 50), T("momo_strict", "M1", 40), T("momo_now", "M2", 20), T("momo_now", "M3", -10), T("momo_now", "M4", 15), T("momo_now", "M5", 30), T("momo_now", "M6", 5),
    T("early1", "E1", -20, 9 * 3600_000), // older than 8 hours: ignored
  ];
  const hits = g.hitsOf(trips, now);
  ok(hits.king.n === 10, `King: 10 coins (3 books on one coin count once): ${hits.king.n}`);
  ok(hits.king.winRate === 10 && hits.king.avgPct < -10, `King: ${hits.king.winRate}% wins, avg ${hits.king.avgPct}%`);
  ok(hits.momo.n === 6 && hits.momo.winRate === 83, `MOMO: ${hits.momo.n} coins, ${hits.momo.winRate}% wins`);
  ok(hits.early.n === 0, "a trip older than 8 hours is not counted");

  // ---- decisions
  const normal = g.classify(day(1000, 10), 0, 0);
  let d = g.decide(normal, hits, null, now);
  ok(d.gates.king.level === "off" && /not working/.test(d.gates.king.why), `King on a cold streak in ARENA: off (${d.gates.king.why})`);
  ok(d.gates.momo.level === "on" && d.gates.early.level === "on", "MOMO winning and minute-1 without data: on");
  ok(d.switches.length === 1 && d.switches[0].sleeve === "king" && d.switches[0].to === "off", "one switch logged");
  const dead = g.classify(day(1000, 10), 0, -12);
  d = g.decide(dead, hits, null, now);
  ok(d.gates.momo.level === "on" && /kept on/.test(d.gates.momo.why), "SOL dumping, but MOMO still winning in ARENA: kept on");
  ok(d.gates.early.level === "off", "no ARENA data and a dead market: minute-1 off");
  const coldHits = { ...hits, king: { n: 3, wins: 1, winRate: 33, avgPct: -5 } };
  const cold = g.classify(day(1000, 10), 0, -6);
  d = g.decide(cold, coldHits, null, now);
  ok(d.gates.king.level === "half", `cold market, too few King coins to judge: half size (${d.gates.king.why})`);
  const weak = { ...hits, king: { n: 7, wins: 2, winRate: 29, avgPct: -4 } };
  ok(g.decide(normal, weak, null, now).gates.king.level === "half", "a weak run (7 coins, 29% wins, avg -4%): half size");

  // ---- hysteresis: worse at once, better after 2 readings and 30 minutes
  const good = { king: { n: 8, wins: 5, winRate: 62, avgPct: 20 }, early: { n: 0, wins: 0, winRate: 0, avgPct: 0 }, momo: { n: 0, wins: 0, winRate: 0, avgPct: 0 } };
  const off = g.decide(normal, hits, null, now).gates;
  let s1 = g.decide(normal, good, off, now + 5 * 60_000);
  ok(s1.gates.king.level === "off" && s1.gates.king.up === 1, "first good reading: still off");
  let s2 = g.decide(normal, good, s1.gates, now + 10 * 60_000);
  ok(s2.gates.king.level === "off", "second good reading 10 minutes after the switch: still off (30-minute hold)");
  let s3 = g.decide(normal, good, s2.gates, now + 31 * 60_000);
  ok(s3.gates.king.level === "on" && s3.switches.length === 1, "after 30 minutes and 2+ good readings: back on");
  const flap = g.decide(normal, good, { ...off, king: { ...off.king, up: 0 } }, now + 40 * 60_000);
  ok(flap.gates.king.level === "off", "one good reading alone does not switch back (no flapping)");

  // ---- the desk side: modes and stale data
  await R.set(g.REGIME_VIEW, { at: Date.now(), gates: off });
  process.env.REGIME_MODE = "on";
  g.regimeForget();
  let gate = await g.gateFor("king");
  ok(gate.w === 0 && gate.level === "off", "desk reads King off (mode on)");
  ok((await g.gateFor("wire")).w === 1, "strategies REGIME does not measure (WIRE) are untouched");
  process.env.REGIME_MODE = "shadow";
  ok((await g.gateFor("king")).w === 1, "shadow mode: shown, never applied");
  process.env.REGIME_MODE = "off";
  ok((await g.gateFor("king")).w === 1, "off: never applied");
  process.env.REGIME_MODE = "on";

  // ---- one tick end to end (worker): market counters + ARENA trips → view, gates, desk log
  const at = Date.now();
  for (let i = 0; i < 26; i++) await R.hset(K.hr(hourKey(at - i * 3600_000)), { d: 1000, b: 10, g: 12 });
  await R.hset("rn:solh", { [hourKey(at)]: 150, [hourKey(at - 6 * 3600_000)]: 151, [hourKey(at - 24 * 3600_000)]: 152 });
  g.regimeForget();
  await R.del(g.REGIME_VIEW);
  const tr = trips.map((t) => ({ ...t, closedAt: at - (now - t.closedAt) }));
  const t = await g.regimeTick(tr, at);
  const view: any = await R.get(g.REGIME_VIEW);
  ok(t.market.state === "normal" && view?.gates?.king?.level === "off" && view.market.migrationsHour === 12, `tick: market ${t.market.state}, King off, ${view?.market?.migrationsHour} migrations last hour`);
  ok(Math.abs(view.market.sol24 - (150 / 152 - 1) * 100) < 0.1, `SOL 24h from the hourly prices: ${view.market.sol24}%`);
  const ev: any[] = (await R.lrange(K.deskEv, 0, 10)) as any[];
  ok(ev.some((e) => e.agent === "REGIME" && /king on → off/.test(e.text)), "the switch is written to the desk log");
  gate = await g.gateFor("king");
  ok(gate.w === 0, "the desk sees the worker's reading at once (same process)");

  // ---- what the switch saved
  await g.regimeSaved(-0.03);
  await g.regimeSaved(0.01);
  const sv: any = await R.hgetall("rn:regime:saved");
  ok(Number(sv.n) === 2 && Number(sv.w) === 1 && Number(sv.p) === -200, "blocked ghost trades are summed (2 closed, 1 won, -0.02 SOL)");

  // ---- wiring
  const fs = await import("fs");
  const desk = fs.readFileSync(new URL("../src/lib/desk.ts", import.meta.url), "utf8");
  ok(/const rgw: [^=]*= await gateFor\(sl\)/.test(desk) && /REGIME off: \$\{rgw\.why\}/.test(desk), "the desk asks REGIME before every buy and sends a blocked signal to the ghost desk");
  ok(/pmw\.w \* wmul \* rgw\.w/.test(desk), "half size applies to the buy size");
  ok(/startsWith\("REGIME"\)\) await regimeSaved/.test(desk), "a blocked ghost trade's result is counted when it closes");
  const w = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/regimeTick\(await arenaRecentTrips\(\)\)/.test(w) && /5 \* 60_000/.test(w), "the worker reads REGIME every 5 minutes");
  const dg = fs.readFileSync(new URL("../src/lib/digger.ts", import.meta.url), "utf8");
  ok(/hrInc\(c, at, "g"\)/.test(dg), "graduations are counted by the hour they happened");
  const arena = fs.readFileSync(new URL("../src/lib/arena.ts", import.meta.url), "utf8");
  ok(!/gateFor/.test(arena), "ARENA itself is never switched (it is the measurement)");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);

  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
