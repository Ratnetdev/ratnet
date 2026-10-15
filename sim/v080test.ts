// v0.1.80: MOMO trend hold (the time stop no longer throws out live runners) and the chop guard with its breakout
// kill switch, both scored by COACH. Run: npx tsx sim/v080test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const D = await import("../src/lib/desk");
  const fs = await import("fs");
  const empty = () => ({ timeBy: {}, chopBy: {} }) as any;

  // ---- switches
  ok(D.trendHoldOn({}, empty(), "momo") === true, "trend hold is on for MOMO by default (auto)");
  ok(D.trendHoldOn({}, empty(), "king") === false, "only MOMO (the data behind it is MOMO's)");
  ok(D.trendHoldOn({ momoTrendHold: "off" }, empty(), "momo") === false, "admin can switch it off");
  ok(D.chopGuardOn({}, empty()) === false, "chop guard starts off in auto (repeat entries were not worse on 127 trades)");
  ok(D.chopGuardOn({ momoChopGuard: "on" }, empty()) === true, "admin can force the guard on");

  // COACH: the time stop comes back only when selling there clearly beats the hold
  const l1 = empty();
  for (let i = 0; i < 9; i++) D._cases.timeCase(l1, "momo", true);
  ok(D.trendHoldOn({}, l1, "momo"), "9 cases are not enough to switch");
  for (let i = 0; i < 6; i++) D._cases.timeCase(l1, "momo", true);
  ok(!D.trendHoldOn({}, l1, "momo"), "15 of 15 cases favour selling: time stop back on by itself");
  for (let i = 0; i < 40; i++) D._cases.timeCase(l1, "momo", false);
  ok(D.trendHoldOn({}, l1, "momo"), "holding clearly better again: trend hold back on");
  const l2 = empty();
  for (let i = 0; i < 14; i++) D._cases.chopCase(l2, "momo", true);
  ok(D.chopGuardOn({}, l2), "chop re-entries clearly lose (14 of 14): the guard switches itself on");

  // ---- the trend hold's exit
  const c = {};
  const t0 = 1_900_000_000_000;
  const tr = { at: t0, px0: 1, gain0: 16, hi: 1, hiAt: t0 };
  ok(D.trendExit(tr, 1.3, 1.3, t0 + 10 * 60_000, c) === null && tr.hi === 1.3, "a new high moves the trail up");
  ok(D.trendExit(tr, 1.3 * 0.8, 1.04, t0 + 20 * 60_000, c) === null, "a 20% dip from the high is held");
  ok(/trend over: 25% off/.test(String(D.trendExit(tr, 1.3 * 0.74, 0.96, t0 + 25 * 60_000, c))), "26% off the high: out");
  const tr2 = { at: t0, px0: 1, gain0: 0, hi: 1.1, hiAt: t0 };
  ok(D.trendExit(tr2, 1.05, 1.05, t0 + 61 * 60_000, c) === null, "an hour without a new high is not enough");
  ok(/trend faded: no new high in 121m/.test(String(D.trendExit(tr2, 1.05, 1.05, t0 + 121 * 60_000, c))), "2 hours without a new high and no progress since the hold began: out");
  const trS = { at: t0, px0: 1, gain0: 0, hi: 1.6, hiAt: t0 };
  ok(D.trendExit(trS, 1.45, 1.45, t0 + 300 * 60_000, c) === null, "sideways in profit for 5 hours (inside the trail): held");
  const tr3 = { at: t0, px0: 1, gain0: 0, hi: 1, hiAt: t0 };
  let last = "";
  for (let m = 1; m <= 25 * 60; m += 5) {
    const r = D.trendExit(tr3, 1 + m / 1000, 1 + m / 1000, t0 + m * 60_000, c);
    if (r) {
      last = r;
      break;
    }
  }
  ok(/ended after 24h/.test(last), "24 hours at most");

  // ---- $STREAM, 15 Oct: what the trend hold does on a run like it (a climb from $2.06M with pullbacks up to 20%)
  // [minutes after 03:58 UTC, market cap $M]: the 16 prices the desk saw that day (8 entries, 8 exits)
  const path: [number, number][] = [[11, 2.4], [560, 7.01], [571, 6.99], [608, 9.64], [619, 9.25], [674, 7.98], [685, 7.74], [722, 9.36], [733, 11.03], [784, 19.41], [794, 18.12], [829, 24.65], [839, 23.72], [893, 23.72], [903, 28.1]];
  const tS = { at: t0, px0: 2.4, gain0: 16, hi: 2.4, hiAt: t0 };
  let out: string | null = null;
  for (const [m, px] of path) out ||= D.trendExit(tS, px, px / 2.06, t0 + m * 60_000, c);
  ok(out === null && tS.hi === 28.1, `on the prices the desk saw, one trend hold from $2.06M is still in at $28.1M (${(28.1 / 2.06).toFixed(1)}x) instead of 8 trades netting +0.001 SOL`);

  // ---- the chop guard on $STREAM's real sequence, and the breakout kill switch
  const led = (n: number, streak: number, hi: number) => ({ n, streak, hi, first: 2.06, at: 0, pnl: 0 });
  ok(!D.isChop(null, 5), "first trade on a coin is never chop");
  ok(!D.isChop(led(3, 1, 9.6), 8), "one loss is not chop");
  ok(D.isChop(led(3, 2, 9.9), 7.98), "two losses in a row and below its high: chop ($7.98M after the $9.6M loss)");
  ok(!D.isChop(led(5, 2, 11.1), 19.4), "a new high is never chop: the breakout kill switch ($19.4M)");
  ok(!D.isChop(led(6, 3, 20.0), 24.6), "however many losses before ($24.6M breakout)");

  // the coin's own record
  const p = (soldSol: number, peakPx: number) => ({ mint: "STREAMmint", entryPx: 1, peakPx, soldSol, costSol: 0.05 }) as any;
  await D.noteCoinTrade(p(0.055, 1.1));
  let L = await D.coinLed("STREAMmint");
  ok(!!L && L.n === 1 && L.streak === 0 && L.hi === 1.1, "a win: streak 0, high noted");
  await D.noteCoinTrade(p(0.048, 1.4));
  await D.noteCoinTrade(p(0.046, 1.6));
  L = await D.coinLed("STREAMmint");
  ok(L!.streak === 2 && L!.hi === 1.6 && L!.n === 3, "two losses: streak 2, highest price kept");
  await D.noteCoinTrade(p(0.06, 2));
  ok((await D.coinLed("STREAMmint"))!.streak === 0, "a win resets the streak");

  // ---- wiring
  const dk = fs.readFileSync(new URL("../src/lib/desk.ts", import.meta.url), "utf8");
  ok(/trendHoldOn\(c2, learnS, sl\) && xo\?\.time == null && gain >= \(c2\.momoTrendMinGain \?\? -5\)/.test(dk), "time stop: alive (within 5% of entry or better) becomes a trend hold");
  ok(/if \(!gt\) caseAdds\.push\(\{ kind: "trend"/.test(dk), "every desk trend hold is a COACH case (2 hours on)");
  ok(/const horizon = c\.kind === "trend" \? 120 \* 60_000 : 30 \* 60_000;/.test(dk), "trend cases judged at 2h, chop at 30m");
  ok(/const takesSlot = \(p: Pos\) => !p\.tp1Done && !\(p\.trend && p\.lastPx >= p\.entryPx \* 1\.05\);/.test(dk), "a trend hold in profit frees its MOMO slot");
  ok(/rule: "chop_guard",\n\s+ok: !\(chop && guard\)/.test(dk) && /"chop_guard"\]\); \/\/ v0\.1\.80: chop guard blocks go to the ghost desk/.test(dk), "chop guard is a desk check; blocked entries go to the ghost desk");
  ok(/if \(chop\) await r\.hset\(CASES/.test(dk), "every chop entry is scored, taken or skipped");
  ok(/p\.how === "momo"\) await noteCoinTrade\(p, now\)/.test(dk), "every closed desk MOMO trade updates the coin's record");
  ok(/const trendWhy = p\.trend \? trendExit\(p\.trend, q\.px, mult, now, c2\) : null;/.test(dk) && /!p\.trend && quiet >= staleMin/.test(dk) && /!p\.trend && q\.px <= p\.peakPx \* \(1 - width/.test(dk), "after the initials a trend hold keeps its own trail (not MOMO's tight house-money trail)");
  // ARENA's quick-scalp variant sets its own time stop: it keeps scalping, so ARENA keeps the old behaviour as a live comparison
  const ar = fs.readFileSync(new URL("../src/lib/arena.ts", import.meta.url), "utf8");
  ok(/DESK_ONLY = new Set\(\["open_slots", "daily_loss_ok", "chop_guard"\]\)/.test(ar), "ARENA keeps taking chop entries (evidence for the guard)");

  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
