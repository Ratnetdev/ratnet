// v0.1.121 DESK SCALE: limits grow with the bank, nothing changes at the starting bank. Run: npx tsx sim/v121test.ts
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const S = await import("../src/lib/scale");
  const { DEFAULT_SETTINGS } = await import("../src/config/site");
  const cfg: any = DEFAULT_SETTINGS.desk;

  // ---- 1. the starting desk is unchanged
  const at2 = S.scaleOf(2, cfg);
  ok(at2.on && at2.maxSol === cfg.maxSol && at2.maxOpen === cfg.maxOpen && at2.momoMaxOpen === (cfg.momoMaxOpen ?? 3) && at2.maxBags === (cfg.maxBags ?? 12), `at 2 SOL: maxSol ${at2.maxSol}, ${at2.maxOpen} slots, ${at2.momoMaxOpen} MOMO, ${at2.maxBags} bags (as configured)`);
  const small = S.scaleOf(1.2, cfg);
  ok(small.maxSol === cfg.maxSol && small.maxOpen === cfg.maxOpen && small.deployMax >= 5 * cfg.minSol, "below the base bank: never under the configured limits");
  ok(S.roomLeft([], "x", at2)!.room >= 0.5 && S.roomLeft([1, 2, 3, 4].map(() => ({ costSol: 0.1, gk: "x" })), "x", at2)!.room >= 0.1 - 1e-9, "at 2 SOL, five 0.1 SOL trades of one strategy still fit (as today)");

  // ---- 2. the ladder
  const L = (b: number) => S.scaleOf(b, cfg);
  ok(L(20).maxSol === 2 && L(100).maxSol === 10 && L(1000).maxSol === 25, `size cap: ${S.LADDER.map((b) => `${b}:${L(b).maxSol}`).join(" ")}`);
  ok(L(20).maxOpen === 16 && L(100).maxOpen === 35 && L(1000).maxOpen === 100, `slots: ${S.LADDER.map((b) => `${b}:${L(b).maxOpen}`).join(" ")}`);
  ok(L(100).deployMax === 60 && L(100).bookMax === 25, "at 100 SOL: 60 SOL at risk at most, 25 SOL in one strategy");
  ok(S.LADDER.every((b, i) => i === 0 || (L(b).maxSol >= L(S.LADDER[i - 1]).maxSol && L(b).maxOpen >= L(S.LADDER[i - 1]).maxOpen)), "every limit only grows with the bank");

  // ---- 3. exposure and per-strategy caps
  const sc = L(100);
  const open = [...Array.from({ length: 3 }, () => ({ costSol: 8, gk: "A" })), { costSol: 10, soldSol: 6, gk: "B" }];
  const ra = S.roomLeft(open, "A", sc)!;
  ok(Math.abs(ra.room - 1) < 1e-9 && /this strategy/.test(ra.why), `strategy A holds 24 of 25 SOL: 1 SOL left for it (${ra.why})`);
  const rb = S.roomLeft(open, "C", sc)!;
  ok(Math.abs(rb.room - 25) < 1e-9, `a new strategy: 28 SOL at risk overall (B sold 6 back), its own 25 SOL cap binds (${rb.why})`);
  const full = Array.from({ length: 10 }, (_, i) => ({ costSol: 5, gk: `K${i}` }));
  const rc = S.roomLeft(full, "Z", sc)!;
  ok(Math.abs(rc.room - 10) < 1e-9 && /across the desk/.test(rc.why), `50 SOL at risk across ten strategies: 10 SOL left overall (${rc.why})`);
  ok(S.bookOf({ how: "momo" }) === "lane:momo" && S.bookOf({ gk: "k", how: "direct" }) === "k", "a GRID position counts in its book, others in their lane");

  // ---- 4. liquidity still caps every buy
  ok(Math.abs(S.poolCap(85, 6) - 2.52) < 0.01 && Math.abs(S.poolCap(1000, 6) - 29.6) < 0.1 && S.poolCap(0, 6) === 0, `migrated pool cap at 6% impact: 85 SOL pool ${S.poolCap(85, 6).toFixed(2)}, 1000 SOL pool ${S.poolCap(1000, 6).toFixed(1)}`);

  // ---- 5. off switch
  const off = S.scaleOf(500, { ...cfg, scale: false });
  ok(!off.on && off.maxSol === cfg.maxSol && off.maxOpen === cfg.maxOpen && S.roomLeft([], "x", off) === null, "scale: false: the fixed caps, no exposure caps");

  // ---- 6. wiring
  const d = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok((d.match(/scaleOf\(/g) || []).length >= 5, "the desk reads the scaled limits (slots, King VET, MOMO, King buys, GRID buys)");
  ok(/Math\.min\(sc\.maxSol, want, liqCap, avail \* 0\.95, rl \? rl\.room : Infinity\)/.test(d) && /Math\.min\(sc\.maxSol, Math\.max\(cfg\.minSol, \(eqValue \* pct\) \/ 100\), liqCap, avail \* 0\.95, room\)/.test(d), "every buy: min(scaled cap, Kelly size, liquidity, free cash, exposure room)");
  ok(/poolCap\(fresh\.real/.test(d) && /poolMark\(rec\.mint, q\)/.test(d), "migrated coins: capped by their pool's SOL, not a fixed number");
  ok(fs.existsSync("src/app/api/desk/scale/route.ts"), "/api/desk/scale");
  const { BOUNDS } = await import("../src/lib/deskbounds");
  ok(!!BOUNDS.scaleSolMax && BOUNDS.scaleSolMax[1] <= 100 && !!BOUNDS.deployPct, "admin bounds on the new settings");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 121 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.121 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.121 checks pass");
  process.exit(fail ? 1 : 0);
})();
