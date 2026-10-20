// v0.1.137 BAG STUDY: does keeping a bag pay? The desk's ladder with a 10/20/30% bag riding a 50% trail up to 24h,
// measured past the strategy's own close on every followed strategy's paper trip; the desk keeps a bag only on proof.
// Run: npx tsx sim/v137test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const Ld = await import("../src/lib/ladder");
  const L = await import("../src/lib/gridlive");
  const D = await import("../src/lib/desk");
  const now = Date.now();
  const desk = Ld.parseLadder("1.5:40,2:30,3:20,5:10")!;
  Ld.setDeskLadder(desk);

  // ---- 1. the ladder side
  const b20 = Ld.bagLadder(desk, 0.2)!;
  ok(Math.abs(b20.reduce((a, x) => a + x[1], 0) - 0.8) < 1e-9 && b20[0][0] === 1.5, "bag20 = the desk's ladder on 80% of the position");
  const x = { initials: 2, trail: 0.25, stop: 0.35 };
  const sh = Ld.newShadows();
  for (const xr of [1.2, 1.6, 2.1, 3.2, 5.5, 8]) Ld.shadowTick(sh, x, 0.7, xr, Math.max(xr, 1));
  ok(sh.desk.d === 1 && Math.abs(sh.desk.s - 1) < 1e-9, "the desk's ladder has sold everything by 5x");
  ok(!sh.bag20.d && Math.abs(sh.bag20.s - 0.8) < 1e-9 && Ld.ridingBag("bag20", sh.bag20), "bag20 sold 80% and its bag rides");
  Ld.shadowTick(sh, x, 0.7, 6.5, 8); // 19% off the peak: the book's 25% trail is not used for the bag
  ok(!sh.bag20.d, "the bag ignores the strategy's tight trail");
  const out = Ld.shadowClose(sh, 6.5, true);
  ok(typeof out.desk === "number" && out.bag20 === undefined && out.bag10 === undefined, "at the strategy's close, riding bags are left to their ride");
  const out2 = Ld.shadowClose(sh, 6.5);
  ok(typeof out2.bag20 === "number", "without keepRiding they settle at the close (as before)");

  // ---- 2. rides after the close
  L._bagReset();
  const K = "any:pw1|c5|2/0.5/0.35/60/hold/k0.3h24";
  L._setEver([K]);
  const M = "BagCoin111111111111111111111111111111pump";
  const fill = 30 / 1e9; // token price at 30 SOL market cap
  const pos: any = { key: K, mint: M, symbol: "BAG", openedAt: now - 600_000, fillPx: fill, tokens: 1, cost: 0.05, back: 0, peak: fill * 8, initials: true, tEnd: now, lastPx: fill * 6.5, lastReal: 0, sh };
  const t: any = { k: K, mint: M, symbol: "BAG", openedAt: pos.openedAt, closedAt: now, pnl: 0, pnlPct: 0, why: "trail", sh: Ld.shadowClose(sh, 6.5, true), mc0: 30 };
  L._bagStart(pos, t, now);
  ok(L._bagState().rides.size === 1, "a trip with riding bags opens a ride");
  L.gridLiveCurve(M, { progress: 90, mcapSol: 30 * 20, realSol: 70 }, now + 60_000); // runs to 20x
  L.gridLiveCurve(M, { progress: 80, mcapSol: 30 * 12, realSol: 60 }, now + 120_000); // 40% off the 20x peak: holds
  ok(L._bagState().rides.size === 1, "the bag rides the coin to 20x and holds a 40% pullback");
  L.gridLiveCurve(M, { progress: 60, mcapSol: 30 * 9, realSol: 50 }, now + 180_000); // 55% off: sold
  ok(L._bagState().rides.size === 0 && L._bagState().trips.length === 1, "55% off the peak: the bag is sold and the trip recorded");
  const bt = L._bagState().trips[0];
  ok(bt.bags.bag20 > bt.desk && bt.bags.bag30 > bt.bags.bag20, `on a runner the bag wins (desk ${bt.desk}x, bag20 ${bt.bags.bag20}x, bag30 ${bt.bags.bag30}x)`);
  // a trip whose bags never ride is recorded at once (the losers count too)
  const sh2 = Ld.newShadows();
  Ld.shadowTick(sh2, x, 0.7, 0.6, 1); // stopped out
  L._bagStart({ ...pos, mint: "Loser", sh: sh2, peak: fill, lastPx: fill * 0.6 } as any, { ...t, mint: "Loser", sh: Ld.shadowClose(sh2, 0.6, true) }, now);
  ok(L._bagState().trips.length === 2 && L._bagState().rides.size === 0, "a stopped-out trip is recorded straight away: losers count");
  // a ride past 24h is settled at its last price
  const sh3 = Ld.newShadows();
  for (const xr of [1.6, 2.1, 3.2, 5.5]) Ld.shadowTick(sh3, x, 0.7, xr, xr);
  L._bagStart({ ...pos, mint: "Old", sh: sh3, openedAt: now - 25 * 3600_000, peak: fill * 5.5, lastPx: fill * 5 } as any, { ...t, mint: "Old", sh: Ld.shadowClose(sh3, 5, true) }, now);
  L.rideSweep(now);
  ok(L._bagState().rides.size === 0 && L._bagState().trips.length === 3, "a ride past 24 hours is sold at its last price");

  // ---- 3. the study and the pick
  const mk = (i: number, d: number, b: number) => ({ k: K, mint: `s${i}`, closedAt: now - (100 - i) * 60_000, desk: d, bags: { bag10: d * 0.9 + b * 0.1, bag20: d * 0.8 + b * 0.2, bag30: d * 0.7 + b * 0.3 } });
  L._setBagTrips(Array.from({ length: 70 }, (_, i) => mk(i, 1.1, i % 10 === 0 ? 8 : 0.5)));
  const st = L.bagStudy();
  ok(st.n === 70 && st.best === "bag30", `bags beat the ladder on both halves when 1 in 10 runs to 8x (best ${st.best}: ${st.rows.map((r) => `${r.id} ${r.all}%`).join(", ")} vs desk ${st.desk.all}%)`);
  delete process.env.BAG_MODE;
  ok(L.bagPick() === 0.3, "auto: the desk keeps the proven bag");
  L._setBagTrips(Array.from({ length: 70 }, (_, i) => mk(i, 1.1, 0.4)));
  ok(L.bagStudy().best === null && L.bagPick() === null, "when bags don't pay, the desk keeps none");
  L._setBagTrips(Array.from({ length: 30 }, (_, i) => mk(i, 1.1, 8)));
  ok(L.bagStudy().best === null, "under 60 trips nothing is picked");
  process.env.BAG_MODE = "20";
  ok(L.bagPick() === 0.2, "BAG_MODE=20 forces a 20% bag");
  process.env.BAG_MODE = "off";
  ok(L.bagPick() === null, "BAG_MODE=off keeps none");
  delete process.env.BAG_MODE;

  // ---- 3b. EXIT PICK: a runner whose own exit beats the ladder runs its own exit
  const RK = "any:pw1+bs70|now|2/0.5/0.35/60/hold/k0.3h24";
  const LK = "early60:r15|now|2/0.25/0.45/60/sell";
  const tr: any[] = [];
  for (let i = 0; i < 40; i++) {
    tr.push({ k: RK, mint: `r${i}`, symbol: "R", openedAt: now - (i + 1) * 60_000, closedAt: now - i * 60_000, pnl: 0, pnlPct: 0, why: "trail", sh: { book: i % 5 === 0 ? 4 : 0.9, desk: i % 5 === 0 ? 2.2 : 0.9 } });
    tr.push({ k: LK, mint: `l${i}`, symbol: "L", openedAt: now - (i + 1) * 60_000, closedAt: now - i * 60_000, pnl: 0, pnlPct: 0, why: "tp", sh: { book: 1.05, desk: 1.2 } });
  }
  L._setTrips(tr);
  const xr1 = L.exitPick(RK);
  ok(xr1.pick === "book" && xr1.book! > xr1.desk!, `a runner whose own exit made ${xr1.book}% vs the ladder's ${xr1.desk}% on both halves runs its own exit`);
  ok(L.exitPick(LK).pick === "desk", "a strategy the ladder beats keeps the ladder");
  ok(L.exitPick("none").pick === "desk" && L.exitPick("none").n === 0, "no record: the ladder (as before)");
  L._pairsReset();
  for (let i = 1; i < 10; i++) L.gridNoteLive({ k: RK, mint: `r${i}`, openedAt: now - (i + 1) * 60_000 + 3_000, pct: -20 });
  const ea = L.edgeAdj(RK);
  ok(ea.exit === "book" && ea.gap != null && Math.abs(ea.adj(tr[0]) - (300 + ea.gap)) < 1e-6, `its edge is judged on its own exit's result plus the real gap (${ea.adj(tr[0])}% on a 4x trip, gap ${ea.gap})`);
  const gl0 = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  ok(/xp: exitPick\(b\.key\)\.pick/.test(gl0), "each follow order carries the exit pick");
  const ds0 = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/const ld0 = o\.xp === "book" \? null : parseLadder\(cfg\.tpLadder\);/.test(ds0), "the desk runs the strategy's own exit (no ladder, no bag) when it was picked");

  // ---- 4. the live desk's bag
  const ld = Ld.bagLadder(desk, 0.2)!;
  const p: any = { gx: { initials: 2, trail: 0.25, stop: 0.35, timeMin: 60, mig: "sell" }, entryPx: 1, peakPx: 10, tp1Done: true, openedAt: now - 2 * 3600_000, ld, li: ld.length, tokens: 0.2, tokens0: 1, bag: 0.2 };
  ok(D.gridExit(p, { px: 6, grad: true }, now).frac === 0, "the bag holds through the migration, past the hour and a 40% pullback");
  ok(D.gridExit(p, { px: 4.9, grad: false }, now).frac === 1, "51% off the peak: the bag is sold");
  ok(D.gridExit({ ...p, openedAt: now - 25 * 3600_000 }, { px: 9, grad: false }, now).frac === 1, "after 24 hours the bag is sold");
  ok(D.gridExit({ ...p, bag: undefined, li: ld.length }, { px: 6, grad: false }, now).frac === 1, "without a bag the old rules apply (the hour is over)");
  const ds = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/bag = ld0 && BAG_PICK \? BAG_PICK\(\) : null;/.test(ds) && /if \(ld && bag\) pos\.bag = bag;/.test(ds), "the desk asks for the pick at every buy");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/setBagPick\(\(\) => bagPick\(\)\)/.test(wk) && /bagLoad\(\)/.test(wk), "the worker wires the pick and loads rides");
  const gl = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  ok(/bags: \{ \.\.\.bagStudy\(\), live: bagPick\(\) \}, ladder: LADDER_VIEW/.test(gl), "the bag study and the ladder study are on /api/desk/gridlive");
  ok(JSON.parse(fs.readFileSync("package.json", "utf8")).version >= "0.1.137", "v0.1.137 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.137 checks pass");
  process.exit(fail ? 1 : 0);
})();
