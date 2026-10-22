// v0.1.143: honest exam (only trips the live rug guard lets through), loss-streak bench, daily limit 30%, RIP & DIP
// books with a paper add (DCA). Run: npx tsx sim/v143test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const L = await import("../src/lib/gridlive");
  const G = await import("../src/lib/grid");
  const now = Date.now();

  // ---- DCA in the exit key
  const x = { initials: 2, trail: 0.5, stop: 0.5, timeMin: 120, mig: "hold" as const, keep: 0.5, hours: 24, dca: 0.35 };
  const key = G.keyOf("r30+age3", "now", x);
  ok(/\/k0\.5h24\/d0\.35$/.test(key), "the add is part of the key");
  const back = G.exitOfPart(key.split("|")[2])!;
  ok(back.dca === 0.35 && back.hours === 24 && back.keep === 0.5, "and parses back");
  ok(G.exitOfPart("2/0.5/0.35/60/hold/k0.3h24")!.dca === undefined, "older keys have no add");
  ok(/adds the same size once on a 35% pullback/.test(G.exitText(x)), "the label says it");

  // ---- RIP & DIP seeds
  ok(L.RIP_SEEDS.length === 6 && L.RIP_SEEDS.every((k) => k.startsWith("any:") && !!L.bookFromKey(k.replace(/^any:/, ""), now)), "6 RIP & DIP books, every launch, all parse");
  L.gridLiveReset();
  L._setBooks([]);
  L._setTrips([]);
  const seeded = L._seedRip(now);
  ok(seeded.length === 6 && seeded.every((b) => b.by === "rip" && b.any), "seeded as the rip family");
  ok(L._seedRip(now).length === 0, "once");

  // ---- a launch rips, pulls back 35% (add), then reaches 2x the average (half sold)
  const b = seeded.find((s) => s.key === L.RIP_SEEDS[0])!;
  L.gridLiveReset();
  L._setBooks([b]);
  L._setTrips([]);
  const T = now;
  L.gridLiveSymbol("RIPx", "RIP", T);
  const cv = (t: number, p: number, mc: number) => L.gridLiveCurve("RIPx", { progress: p, mcapSol: mc, realSol: Math.max(1, mc - 28), complete: false }, t);
  cv(T + 1_000, 5, 30);
  cv(T + 62_000, 40, 60); // +35 points in the minute, 62s old: the rip
  cv(T + 65_000, 41, 60); // the paper fill (2s after the signal)
  const st = L.gridLiveState();
  const pos = [...st.pos.values()][0];
  ok(!!pos && pos.key === b.key, "bought the rip");
  const f0 = pos.fillPx;
  cv(T + 90_000, 30, 38); // -37% from the fill: the add
  ok(pos.dcaDone === true && pos.fillPx < f0 && pos.cost > 0.06, "added once on the pullback, average price lower");
  const avg = pos.fillPx;
  cv(T + 95_000, 25, 30);
  ok([...st.pos.values()].length === 1 && !pos.initials, "a second pullback adds nothing more and is above the stop on the average");
  cv(T + 200_000, 80, (avg * 2.05 * 1e9)); // 2x the average
  ok(pos.initials === true, "half sold at 2x the average price");

  // ---- a book with the add is never followed live yet
  L._setBooks([b]);
  ok(!L.gridLeaders().some((x) => x.key === b.key), "a DCA book is not followed live");

  // ---- honest exam: trips the live rug guard skips do not count
  L._setRugLive(["bots_in"]);
  const mk = (i: number, pnl: number, bots: number) => ({ k: "x", mint: `m${i}`, symbol: "M", openedAt: now - i * 60_000, closedAt: now - i * 60_000 + 30_000, pnl, pnlPct: pnl * 2000, why: "t", ef: { bt: bots } as any });
  const good = Array.from({ length: 30 }, (_, i) => mk(i, i % 2 ? 0.02 : -0.005, 3)); // all would be skipped live
  ok(L.bookStat({ grid: { testN: 0, testAvg: 0, pass: false } }, good).n === 0, "a record made only of trips the guard skips counts as nothing");
  const mixed = [...good, ...Array.from({ length: 5 }, (_, i) => mk(100 + i, 0.01, 0))];
  ok(L.bookStat({ grid: { testN: 0, testAvg: 0, pass: false } }, mixed).n === 5, "only the trips live would take are judged");
  L._setRugLive([]);
  ok(L.bookStat({ grid: { testN: 0, testAvg: 0, pass: false } }, good).n === 30, "with no live rule, every trip counts");

  // ---- loss streak
  L._streakReset();
  let benched = false;
  for (let i = 0; i < 4; i++) benched = L.streakNote("bk", -10, now) || benched;
  ok(!benched && !L.streakBenched("bk", now), "4 losses in a row: still followed");
  L.streakNote("bk", 5, now);
  for (let i = 0; i < 4; i++) L.streakNote("bk", -10, now);
  ok(!L.streakBenched("bk", now), "a win resets the count");
  ok(L.streakNote("bk", -3, now) && L.streakBenched("bk", now + 3600_000), "the 5th loss in a row benches it");
  ok(!L.streakBenched("bk", now + 25 * 3600_000), "for 24 hours");
  ok(L.gridNoteLive({ mint: "zz", openedAt: now, pct: -50 }) === 0 && !L.streakBenched("", now), "past trades without a book (the boot backfill) never count");

  // ---- risk settings, name-free code
  const site = fs.readFileSync("src/config/site.ts", "utf8");
  ok(/dailyLoss: 30,/.test(site) && /lossPauseMin: 0,/.test(site), "daily loss limit 30%, stops buying for the rest of the day");
  const desk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/await riskOnce143\(\)/.test(desk) && /dailyLoss: 30, lossPauseMin: 0/.test(desk), "saved settings move to it once");
  ok(!/\bStan\b/.test(desk + site + fs.readFileSync("src/lib/gridlive.ts", "utf8") + fs.readFileSync("src/lib/pm.ts", "utf8") + fs.readFileSync("src/lib/j7.ts", "utf8")), "no personal name in the code");
  ok(JSON.parse(fs.readFileSync("package.json", "utf8")).version >= "0.1.143", "v0.1.143 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.143 checks pass");
  process.exit(fail ? 1 : 0);
})();
