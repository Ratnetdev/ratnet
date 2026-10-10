// v0.1.66: PROMOTE. The desk trades a strategy only through a proven ARENA variant. Run: npx tsx sim/v066test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const a = await import("../src/lib/arena");
  const g = await import("../src/lib/regimegate");
  ok(a.VARIANTS.length >= 20 && new Set(a.VARIANTS.map((v) => v.id)).size === a.VARIANTS.length, `${a.VARIANTS.length} ARENA variants, unique ids`);
  for (const p of ["king", "early", "momo", "wire"]) ok(a.VARIANTS.filter((v) => v.path === p).length >= 3, `${p}: ${a.VARIANTS.filter((v) => v.path === p).length} variants`);
  // entries
  const pass = [{ rule: "king_or_nano_bond", ok: true }, { rule: "nano_agrees", ok: false }, { rule: "open_slots", ok: false }];
  const rec: any = { call: { score: 60, verdict: "BOND", v0: { score: 55, verdict: "BOND" }, nano: { score: 10, verdict: "DUST" } } };
  const took = (curve: number) => a.VARIANTS.filter((v) => a.acceptKing(v, pass, rec, false, false, curve)).map((v) => v.id);
  ok(took(20).includes("nonano") && took(20).includes("k_lowcurve") && !took(20).includes("k_hicurve") && took(50).includes("k_hicurve"), `curve bands: at 20% ${took(20).join(",")}`);
  ok(!took(20).includes("strict") && took(20).includes("k_v0_50") && took(20).includes("k_scalp"), "strict needs nano; rules 50+ and scalp take it");
  const wireChecks = [{ rule: "wire_post", ok: true }, { rule: "wire_match", ok: true }];
  const wt = a.VARIANTS.filter((v) => a.acceptKing(v, wireChecks, { wire: { how: 'named "theatermouse"' } } as any, false, true, 5)).map((v) => v.id);
  ok(wt.includes("wire_any") && !wt.includes("wire_strong") && !wt.includes("nonano"), `WIRE pick by name: ${wt.join(",")}`);
  ok(a.VARIANTS.filter((v) => a.acceptMomo(v, [{ rule: "traction", ok: true }], { v5: 120_000, buyers5: 300, sellers5: 100 }, 15)).length === 6, "a strong MOMO signal is taken by every MOMO variant");
  ok(a.variantOf("k_scalp")?.xo?.initials === 30 && a.variantOf("momo_scalp")?.xo?.stop === -12, "scalp variants carry their own exits");
  // records and promotion
  const now = Date.now();
  const T = (v: string, n: number, pct: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ v, mint: `${v}${i}`, closedAt: now - i * 60_000, pnlPct: pct(i), pnl: pct(i) / 1000 }));
  let trips = [...T("nonano", 18, (i) => (i % 2 ? 25 : -15)), ...T("k_scalp", 16, (i) => (i % 3 ? 12 : -14)), ...T("momo_now", 40, () => -9), ...T("wire_any", 5, () => 30)];
  let recs = g.recordsOf(trips, now);
  ok(recs.nonano.n === 18 && recs.nonano.winRate === 50 && recs.nonano.avgPct === 5, `record: nonano ${recs.nonano.n} trips, ${recs.nonano.winRate}% won, avg ${recs.nonano.avgPct}%`);
  let p = g.promote(recs, null);
  ok(p.picks.king === "nonano", `king promotes the best proven variant: ${p.why.king}`);
  ok(p.picks.momo === null && /proving/.test(p.why.momo), `momo benched (losing): ${p.why.momo}`);
  ok(p.picks.wire === null && p.picks.early === null, "wire (5 trips) and early (none) not proven yet");
  // a challenger must beat the holder by 3 points
  trips = [...T("nonano", 18, (i) => (i % 2 ? 25 : -15)), ...T("k_scalp", 16, (i) => (i % 4 ? 12 : -10))];
  recs = g.recordsOf(trips, now);
  p = g.promote(recs, { king: "nonano" });
  ok(p.picks.king === "nonano", `holder keeps its place unless beaten by 3 points (scalp avg ${recs.k_scalp.avgPct}%)`);
  trips = [...T("nonano", 18, (i) => (i % 2 ? 6 : -10)), ...T("k_scalp", 16, (i) => (i % 4 ? 12 : -10))];
  recs = g.recordsOf(trips, now);
  p = g.promote(recs, { king: "nonano" });
  ok(p.picks.king === "k_scalp" && p.changes.length === 1, `the holder fell below holding: ${p.why.king}`);
  // old trips drop out of the 3-day window
  recs = g.recordsOf(T("nonano", 20, () => 10).map((t) => ({ ...t, closedAt: now - 4 * 86400_000 })), now);
  ok(recs.nonano.n === 0, "trips older than 3 days do not count");
  // the desk side
  for (let i = 0; i < 26; i++) await R.hset(`rn:hr:${new Date(now - i * 3600_000).toISOString().slice(0, 13)}`, { d: 1000, b: 10 });
  g.regimeForget();
  await g.regimeTick([...T("nonano", 18, (i) => (i % 2 ? 25 : -15)), ...T("momo_now", 40, () => -9)], now);
  const gk = await g.gateFor("direct" === "direct" ? "king" : "");
  ok(gk.w > 0 && gk.variant === "nonano", `desk King follows ${gk.variant}`);
  const gm = await g.gateFor("momo");
  ok(gm.w === 0 && /proving/.test(gm.why), `desk MOMO benched: ${gm.why}`);
  const gv = await g.gateFor("vamp");
  ok(gv.w === 0, "vamp follows the WIRE gate");
  ok((await g.gateFor("mind")).w === 1, "strategies without ARENA books are untouched");
  const ev: any[] = (await R.lrange("rn:desk:ev", 0, 20)) as any[];
  ok(ev.some((e) => /PROMOTE: the desk's king trades now follow "King, no nano rule"/.test(e.text)), "promotion written to the desk log");
  process.env.PROVING_MODE = "off";
  ok((await g.gateFor("momo")).variant === undefined, "PROVING_MODE=off: back to REGIME's market gate only");
  process.env.PROVING_MODE = "on";
  g.regimeForget();
  await R.del("rn:regime:view");
  const { memo } = await import("../src/lib/memo");
  void memo;
  // wiring
  const fs = await import("fs");
  const dk = fs.readFileSync(new URL("../src/lib/desk.ts", import.meta.url), "utf8");
  ok(/rgw\.variant && !acceptedBy\(rec\.mint\)\.includes\(rgw\.variant\)/.test(dk), "the desk enters only signals its promoted variant took");
  ok(/pos\.pv = pvar\.id;\n    if \(pvar\.xo\) pos\.xo = pvar\.xo;/.test(dk), "and runs that variant's exits");
  ok(/const initialsAt = xo\?\.initials \?\?/.test(dk) && /const trailK = xo\?\.trailK \?\?/.test(dk), "exit overrides read first");
  ok((dk.match(/noteAccepted\(m, took\.map/g) || []).length === 2, "King/WIRE/minute-1 and MOMO signals record which variants took them");
  const dg = fs.readFileSync(new URL("../src/lib/digger.ts", import.meta.url), "utf8");
  ok(/const worth = curveNow >= 4/.test(dg), "REPLAY paths for every call worth testing (curve 4%+ or a BOND/WATCH)");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version && BUILD === "0.1.66", `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
