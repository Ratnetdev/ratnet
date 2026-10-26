// v0.1.130: class gate, FOMO pinned to its own account, crews capped, bots out of earners and crews, the desk keeps
// trading (no demotion by default, the daily loss limit is a pause), paper cash from the real wallet.
// Run: npx tsx sim/v130test.ts
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
  const G = await import("../src/lib/classgate");
  const now = Date.now();

  // ---- 1. CLASS GATE: the 19 to 20 Oct live record
  G._gateReset();
  const live: any[] = [];
  const add = (mc: number, n: number, total: number) => {
    for (let i = 0; i < n; i++) live.push({ c: G.classOf(mc), pnl: total / n, at: now - i * 60_000 });
  };
  add(1, 72, -0.439);
  add(15, 9, -0.063);
  add(29, 19, -0.123);
  add(50, 28, -0.277);
  add(150, 12, 0.03);
  G.loadLiveClass(live);
  const v = Object.fromEntries(G.gateView(now).map((c) => [c.c, c]));
  ok(!v.sub.on && !v.low.on && !v.launch.on && !v.early.on && v.up.on, `live buys off under 96 SOL (lost live), on at 96 SOL+ (${v.up.why})`);
  ok(G.classOf(28.1) === "launch" && G.classOf(0.6) === "sub" && G.classOf(120) === "up", "a coin at launch price is the launch class; 0.6 SOL is sub; 120 SOL is up");
  // paper brings a class back once the strategies the desk follows make 5%+ a trade there after costs
  G.setClassPaper(() => Array.from({ length: 40 }, (_, i) => ({ mc0: 50, sh: { desk: 1.2 }, closedAt: now - i })));
  ok(G.classGate("early", now).on && /paper makes/.test(G.classGate("early", now).why), `early is back on: ${G.classGate("early", now).why}`);
  G.setClassPaper(() => Array.from({ length: 40 }, (_, i) => ({ mc0: 50, sh: { desk: 1.08 }, closedAt: now - i })));
  ok(!G.classGate("early", now).on, "paper +8% gross (+2% after costs) is not enough");
  ok(G.classGate("sub", now + 8 * 86_400_000).on, "a week later the old live record no longer counts");
  const dk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/if \(state\.live && !GRID_ONE_JUDGE\) \{\s*const cg = classGate\(classOf\(fresh\.px \* 1e9\)\);/.test(dk) && /CLASS GATE, \$\{cg\.why\}\. skipped live/.test(dk), "the desk checks the gate on the fresh price before a live GRID buy (off on GRID orders since v0.1.144 ONE JUDGE)");
  ok(/noteLiveClass\(p\.entryPx \* 1e9, p\.soldSol - p\.costSol\)/.test(dk) && /export async function classBoot/.test(dk), "every closed live trip counts for its class; the record is rebuilt from the desk's own trips at boot");

  // ---- 2. FOMO pinned
  const F = await import("../src/lib/fomotap");
  F._fomoReset();
  F.fomoLearn();
  ok(F.fomoView().print.length === 1 && F.fomoView().print[0] === "jitodontfront1111111111111111111TradeonFomo" && F.fomoView().printBy === "seed", "the FOMO print is only FOMO's own account");
  process.env.FOMO_PRINT = "11111111111111111111111111111112";
  F.fomoLearn();
  ok(F.fomoView().printBy === "env", "FOMO_PRINT still overrides");
  delete process.env.FOMO_PRINT;

  // ---- 3. crews capped
  const C = await import("../src/lib/crews");
  C._crewReset();
  const ws = Array.from({ length: 60 }, (_, i) => `w${i}`);
  for (let k = 0; k < 4; k++) ws.forEach((w, i) => C.crewBuy(`M${k}`, w, now + k * 100_000 + i)); // everyone co-buys 4 coins
  const sizes = C.crewView().biggest;
  ok(Math.max(...sizes) <= C.CREW_MAX, `60 wallets that co-buy everything: biggest crew ${Math.max(...sizes)} (max ${C.CREW_MAX})`);

  // ---- 4. bots
  const E = await import("../src/lib/earners");
  E._earnReset();
  for (let i = 0; i < 40; i++) {
    E.earnTrade({ mint: `B${i}`, user: "bot", isBuy: true, sol: 0.1, tokens: 1000, at: now + i });
    E.earnTrade({ mint: `B${i}`, user: "bot", isBuy: false, sol: 0.15, tokens: 1000, at: now + i + 1 });
  }
  ok(E.isBot("bot") && !E.isEarner("bot"), "40 profitable round trips in a day: a bot, not an earner");
  E.earnTrade({ mint: "X", user: "whale", isBuy: true, sol: 60, tokens: 1000, at: now });
  E.earnTrade({ mint: "X", user: "whale", isBuy: false, sol: 200, tokens: 1000, at: now + 1 });
  ok(!E.earnRec("whale")!.n, `a round trip over ${E.TRIP_MAX} SOL is not counted (misread)`);
  E.earnLoad({ odd: { n: 18, w: 18, pnl: 2232, gw: 2232, gl: 0, at: now } });
  ok(!E.earnRec("odd"), "a saved record of 18 wins at 124 SOL each is not loaded");
  const S = await import("../src/lib/smartbuy");
  S._smartReset();
  S.smartTrade({ mint: "Q", user: "bot", isBuy: true, at: now });
  ok(S.smartFeatures("Q", now + 10).bt === 1 && S.smartFeatures("Q", now + 10).ea === 0, "a bot's buy counts as a bot, never as an earner or crew member");
  const L = await import("../src/lib/gridlive");
  ok(L.RUG_RULES.some((r) => r.id === "bots_in") && L.RUG_RULES.filter((r) => r.sig).every((r) => !r.known!({ age: 1, dev: 1, u60: 1, bs60: 1, wh: 0, ds: false, og: 1, fc: 1, ea: 1, pwi: 1 } as any)), "new rule bots_in; the who-is-buying rules only count trips from this build on");

  // ---- 5. keep trading
  const { DEFAULT_SETTINGS } = await import("../src/config/site");
  const d: any = DEFAULT_SETTINGS.desk;
  ok(d.liveMaxDD === 0 && d.lossPauseMin === 0, "defaults: never back to paper on drawdown; the daily loss limit stops new buys for the rest of the day (v0.1.143)");
  ok(/liveMaxDD > 0 && state\.live && state\.liveStart/.test(dk), "the drawdown rule only acts when liveMaxDD is set above 0");
  ok(/state\.lossPauseUntil = now \+ pauseMin \* 60_000/.test(dk) && /state\.dayStart = eq\.value;\s*log\(b, "RISK", `the loss pause is over/.test(dk) && /the daily loss limit paused new buys until/.test(dk), "loss limit: a pause, then a fresh baseline");
  ok(/!state\.live && state\.demotedAt && kp && walletSol != null && walletSol >= EXAM\.minWallet && Number\(\(cfg as any\)\.liveMaxDD \?\? 0\) <= 0/.test(dk), "a desk the old rule put on paper goes back live by itself");
  ok(/const base = walletSol != null && walletSol > 0 \? walletSol : Math\.max\(0, state\.start\);/.test(dk), "paper cash after a demotion comes from the real wallet (it was -0.73)");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/rn:v130:purged/.test(wk) && /classBoot\(\)/.test(wk) && /bt: sm\.bt/.test(wk), "worker: old books purged once, class gate loaded at boot, bot count in the state");
  ok(/CLASS GATE/.test(fs.readFileSync("src/lib/review.ts", "utf8")), "the review shows the gate per class");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 130 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.130 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.130 checks pass");
  process.exit(fail ? 1 : 0);
})();
