// v0.1.145 NO SNIPING: no entry under the market-cap floor (launch price), paper or live. Run: npx tsx sim/v145test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const C = await import("../src/lib/classgate");
  const L = await import("../src/lib/gridlive");
  delete process.env.ENTRY_MIN_MC_SOL;
  ok(C.ENTRY_MIN_MC_SOL() === 31.5, "the floor is the top of the launch price (31.5 SOL) by default");
  ok(!!C.belowFloor(28) && !!C.belowFloor(0.15) && !C.belowFloor(31.5) && !C.belowFloor(500), "28 SOL (no dev buy) and a broken 0.15 SOL price are refused; 31.5 SOL and up are not");
  ok(C.belowFloor(null) === null && C.belowFloor(0) === null, "an unknown market cap is not a reason");
  process.env.ENTRY_MIN_MC_SOL = "96";
  ok(!!C.belowFloor(60) && !C.belowFloor(120), "ENTRY_MIN_MC_SOL moves it (96)");
  process.env.ENTRY_MIN_MC_SOL = "0";
  ok(C.belowFloor(1) === null, "0 turns it off");
  delete process.env.ENTRY_MIN_MC_SOL;

  // a paper book: a rip at the launch price is not bought, the same rip higher up is
  const now = Date.now();
  L.gridLiveReset();
  L._setTrips([]);
  const b = L._seedRip(now).find((x) => x.key === L.RIP_SEEDS[1])!;
  L._setBooks([b]);
  const run = (mint: string, mc0: number, mc1: number) => {
    L.gridLiveSymbol(mint, mint, now);
    const cv = (t: number, p: number, mc: number) => L.gridLiveCurve(mint, { progress: p, mcapSol: mc, realSol: Math.max(1, mc - 28), complete: false }, t);
    cv(now + 1_000, 1, mc0);
    cv(now + 62_000, 40, mc1);
    cv(now + 65_000, 41, mc1);
  };
  run("LOWx", 20, 29);
  ok(![...L.gridLiveState().pos.values()].some((p) => p.mint === "LOWx"), "no paper buy at 29 SOL");
  run("UPx", 35, 70);
  ok([...L.gridLiveState().pos.values()].some((p) => p.mint === "UPx"), "the same rip at 70 SOL is bought");

  const desk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/async function buy\([^\n]*\n[^\n]*\n[^\n]*NO SNIPING[^\n]*\n\s*const fl = belowFloor\(px \* 1e9\);/.test(desk), "every desk buy checks the floor first");
  ok(/async function ghostEnter\([^\n]*\n\s*if \(belowFloor\(px \* 1e9\)\) return;/.test(desk), "the ghost desk too");
  ok(JSON.parse(fs.readFileSync("package.json", "utf8")).version >= "0.1.145", "v0.1.145 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.145 checks pass");
  process.exit(fail ? 1 : 0);
})();
