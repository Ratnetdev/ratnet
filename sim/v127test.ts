// v0.1.127 TP LADDER: a live GRID follow takes profit in fixed steps as the coin climbs; every paper trip runs a set of
// ladders as shadows on its own ticks, so the review shows which one makes the most on the same coins.
// Run: npx tsx sim/v127test.ts
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
  const Ld = await import("../src/lib/ladder");
  const D = await import("../src/lib/desk");
  const { DEFAULT_SETTINGS: SITE } = await import("../src/config/site");

  // ---- 1. the setting
  const def = Ld.parseLadder((SITE as any).desk.tpLadder);
  ok(JSON.stringify(def) === JSON.stringify([[1.5, 0.4], [2, 0.3], [3, 0.2], [5, 0.1]]), `default: ${Ld.ladderText(def)}`);
  ok(Ld.parseLadder("off") === null && Ld.parseLadder("") === null && Ld.parseLadder("2:60,3:60") === null && Ld.parseLadder("1:50") === null && Ld.parseLadder("2x:50%, 4x:50%") !== null, "off, empty, over 100% and a step at 1x are refused; 2x:50% is read");
  const adm = fs.readFileSync("src/app/api/admin/route.ts", "utf8");
  ok(/k === "tpLadder"/.test(adm) && /parseLadder\(t\)/.test(adm), "Admin > desk JSON takes tpLadder (checked before it saves)");

  // ---- 2. the desk: the 19 Oct Gas trade (bought, 5.1x peak in 11 s) under the ladder
  const gx = { initials: 2, trail: 0.5, stop: 0.35, timeMin: 60, mig: "hold" as const, keep: 0.3, hours: 24 };
  const now = Date.now();
  const p: any = { gx, entryPx: 1, peakPx: 1, tp1Done: false, openedAt: now, tokens: 1000, tokens0: 1000, ld: def, li: 0 };
  const run = (px: number) => {
    p.peakPx = Math.max(p.peakPx, px);
    const g = D.gridExit(p, { px, grad: false }, now + 5000);
    if (g.frac > 0) {
      const amt = g.frac >= 1 ? p.tokens : p.tokens * g.frac;
      p.back = (p.back || 0) + amt * px;
      p.tokens -= amt;
      if (g.li != null) p.li = g.li;
      if (g.frac < 1) p.tp1Done = true;
    }
    return g;
  };
  const a = run(1.3);
  const b1 = run(1.62);
  ok(!a.frac && b1.frac > 0.399 && b1.frac < 0.401 && /take profit 40% at 1.62x \(step 1.5x\)/.test(b1.why), `1.62x: ${b1.why}`);
  const b2 = run(3.4);
  ok(Math.abs(p.tokens - 100) < 1e-6 && /take profit 50% at 3.40x \(step 2x\+3x\)/.test(b2.why), `a jump to 3.4x sells the 2x and 3x steps at once (${b2.why}), 10% left`);
  const b3 = run(5.1);
  ok(p.tokens <= 1e-9 && b3.frac === 1, "5.1x: the last 10% sells, the trade is closed");
  ok(Math.abs(p.back - (400 * 1.62 + 500 * 3.4 + 100 * 5.1)) < 1e-6, `got ${(p.back / 1000).toFixed(2)}x on the Gas path (it made 1.64x with 70% at 2x and the trail)`);

  // a spike and a dump: the stop still guards the rest
  const q: any = { gx, entryPx: 1, peakPx: 1, tp1Done: false, openedAt: now, tokens: 1000, tokens0: 1000, ld: def, li: 0 };
  const s1 = D.gridExit({ ...q, peakPx: 1.55 }, { px: 1.55, grad: false }, now);
  ok(s1.frac > 0 && s1.li === 1, "1.55x: 40% out");
  Object.assign(q, { tokens: 600, li: 1, tp1Done: true, peakPx: 1.55 });
  const s2 = D.gridExit(q, { px: 0.7, grad: false }, now);
  ok(s2.frac === 1 && /trail/.test(s2.why), `then back to 0.7x: the rest out on the trail (${s2.why})`);
  // a position bought before the ladder keeps its old exits
  const old: any = { gx, entryPx: 1, peakPx: 2.1, tp1Done: false, openedAt: now, tokens: 1000, tokens0: 1000 };
  ok(/70% at 2.10x/.test(D.gridExit(old, { px: 2.1, grad: false }, now).why), "a position from before the ladder: 70% at 2x as before");
  const dk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/const ld = parseLadder\(cfg\.tpLadder\);\s*if \(ld\) \(pos\.ld = ld\), \(pos\.li = 0\);/.test(dk) || /const ld = bag \? bagLadder\(ld0, bag\) : ld0;\s*if \(ld\) \(pos\.ld = ld\), \(pos\.li = 0\);/.test(dk) && /if \(ok && li != null\) p\.li = li;/.test(dk), "set at the buy; a step only counts once its sell landed");

  // ---- 3. shadows on paper
  const sh = Ld.newShadows();
  const path = [1, 1.2, 1.6, 2.2, 3.1, 5.2, 2.0];
  let pk = 1;
  for (const xr of path) {
    pk = Math.max(pk, xr);
    Ld.shadowTick(sh, gx, 0.7, xr, pk);
  }
  const res = Ld.shadowClose(sh, 2.0);
  ok(Math.abs(res.book - (0.7 * 2.2 + 0.3 * 2.0)) < 1e-3, `book (70% at 2x, trail): ${res.book}x`);
  ok(Math.abs(res.lad15 - (0.4 * 1.6 + 0.3 * 2.2 + 0.2 * 3.1 + 0.1 * 5.2)) < 1e-3 && Math.abs(res.all2 - 2.2) < 1e-3, `lad15 ${res.lad15}x, all at 2x ${res.all2}x`);
  ok(Math.abs(res.lad2b - (0.4 * 2.2 + 0.2 * 3.1 + 0.2 * 5.2 + 0.2 * 2.0)) < 1e-3, `lad2b keeps a 20% bag to the end: ${res.lad2b}x`);
  const sr = Ld.newShadows();
  for (const xr of [1, 0.8, 0.6]) Ld.shadowTick(sr, gx, 0.7, xr, 1);
  const rr = Ld.shadowClose(sr, 0.6);
  ok(Object.values(rr).every((v) => Math.abs(v - 0.6) < 1e-6), "a rug: every ladder stops out at the same price");

  // ---- 4. the study
  const trips = Array.from({ length: 100 }, (_, i) => ({ k: i % 2 ? "lead" : "x", closedAt: i, mc0: i % 3 ? 0.6 : 30, sh: { book: 1.0, desk: 1.1, all2: 0.9, all15: 1.05, lad13: 1.0, lad15: 1.1, lad2: 1.2, lad2b: 0.95 } }));
  const st = Ld.ladderStudy(trips, "lead");
  ok(st.all.n === 100 && st.low.n === 66 && st.leader.n === 50 && st.all.best === "lad2", `study: all ${st.all.n}, under 5 SOL ${st.low.n}, the followed strategy ${st.leader.n}; best on both halves: ${st.all.best}`);
  const gs = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  ok(/shadowTick\(pos\.sh, x, firstSell\(x\), xr, pos\.peak \/ pos\.fillPx\)/.test(gs) && /t\.sh = shadowClose\(/.test(gs) && /rn:ladder:view/.test(gs), "GRID LIVE runs the shadows on every tick, keeps them with the trip, publishes the study every 10 minutes");
  ok(/TP LADDER/.test(fs.readFileSync("src/lib/review.ts", "utf8")), "the daily review shows it");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 127 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.127 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.127 checks pass");
  process.exit(fail ? 1 : 0);
})();
