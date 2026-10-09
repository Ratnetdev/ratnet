// v0.1.58: ARENA entry rules and scoring. Run: npx tsx sim/v058test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const a = await import("../src/lib/arena");
  const V = Object.fromEntries(a.VARIANTS.map((v) => [v.id, v]));
  const all = (fails: string[] = []) => ["king_or_nano_bond", "nano_agrees", "curve_window", "curve_not_late", "bundle_ok", "open_slots", "daily_loss_ok"].map((rule) => ({ rule, ok: !fails.includes(rule) }));
  const call = (k: number, nv: string, ns: number) => ({ call: { score: k, verdict: "BOND", nano: { score: ns, verdict: nv } } });
  ok(a.acceptKing(V.nonano, all(["nano_agrees"]), call(84, "DUST", 0), false, false), "no-nano takes a King call nano disagreed with");
  ok(!a.acceptKing(V.nonano, all(["nano_agrees", "curve_not_late"]), call(84, "DUST", 0), false, false), "no-nano still respects the late-curve rule");
  ok(a.acceptKing(V.nonano_late, all(["nano_agrees", "curve_not_late"]), call(84, "DUST", 0), false, false), "no-nano-late takes it");
  ok(!a.acceptKing(V.nonano, all(["nano_agrees", "bundle_ok"]), call(84, "DUST", 0), false, false), "every coin check still applies (bundle)");
  ok(a.acceptKing(V.nonano, all(["open_slots", "daily_loss_ok"]), call(84, "BOND", 90), false, false), "the desk's own slots and loss limit do not block a book");
  ok(a.acceptKing(V.strict, all(), call(75, "BOND", 65), false, false) && !a.acceptKing(V.strict, all(), call(75, "BOND", 40), false, false), "strict needs King 70+ and nano 60+");
  ok(a.acceptKing(V.early1, all(), { early: { score: 80, verdict: "BOND" } }, true, false) && !a.acceptKing(V.nonano, all(), call(84, "BOND", 90), true, false), "minute-1 reads go to the early book only");
  ok(!a.acceptKing(V.nonano, all(), call(84, "BOND", 90), false, true), "tweet coins are not King-path variants");
  const mc = [{ rule: "traction", ok: true }, { rule: "open_slots", ok: false }];
  ok(a.acceptMomo(V.momo_now, mc, { v5: 30_000, buyers5: 50, sellers5: 40 }, 30), "MOMO now takes a clean MOMO signal");
  ok(!a.acceptMomo(V.momo_strict, mc, { v5: 30_000, buyers5: 50, sellers5: 40 }, 30) && a.acceptMomo(V.momo_strict, mc, { v5: 60_000, buyers5: 100, sellers5: 60 }, 20), "MOMO strict needs twice the volume and buyers");
  // scoring: 30 trips, 18 wins of +0.02, 12 losses of -0.01 -> +0.24 SOL on 1.25 = +19.2%
  const t0 = Date.now();
  const trips = Array.from({ length: 30 }, (_, i) => ({ v: "momo_now", mint: `M${i}`, symbol: "X", openedAt: t0 + i, closedAt: t0 + i + 1, cost: 0.1, back: 0.1, pnl: i < 18 ? 0.02 : -0.01, pnlPct: i < 18 ? 20 : -10, reason: "x", peakX: 1 }));
  const sc = a.arenaScore(trips);
  ok(sc.momo_now.n === 30 && Math.round(sc.momo_now.winRate) === 60 && Math.abs(sc.momo_now.pnlPct - 19.2) < 0.01, `score: 60% win, +19.2% (${sc.momo_now.pnlPct.toFixed(1)}%)`);
  ok(sc.momo_now.passed && !sc.nonano.passed, "a book that meets every check passes its exam; an empty one does not");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.58 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
