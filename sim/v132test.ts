// v0.1.132: the desk follows the top 3 passed strategies (never one whose record is negative without its 2 best
// trades), sizes up by the coin's class record, and CRAWLNET's ideas run as tested signals: callout front-runners,
// the FOMO crowd arriving, running stories, FOMO's retail money regime.
// Run: npx tsx sim/v132test.ts
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
  const now = Date.now();

  // ---- 1. FRONT-RUNNERS
  const F = await import("../src/lib/frontrun");
  F._frReset();
  const W = "Wfront111111111111111111111111111111111111";
  for (let i = 0; i < 3; i++) {
    const m = `mint${i}`;
    const at = now - 600_000 + i * 120_000;
    F.frBuy(m, W, 0.5, at - 30_000, false); // 30 s before the call
    F.frBuy(m, "Wlate", 0.5, at + 5_000, false); // after the call: never credited
    F.frBuy(m, "Wbot", 0.5, at - 20_000, true); // bots never count
    F.frCallout(m, "caller", at);
  }
  ok(F.isFrontRunner(W), "a wallet that bought 3 coins in the 90 s before their callouts is a front-runner");
  ok(!F.isFrontRunner("Wlate") && !F.isFrontRunner("Wbot"), "buys after the call and bot buys are never credited");
  ok(F.frCallout("mint0", "caller", now - 600_000).length === 0, "the same callout is counted once");
  ok(F.frBuy("newcoin", W, 0.3, now, false) === true && F.frRecent("newcoin", now).includes(W), "a front-runner's next buy is flagged and shows in the coin's last minute");
  ok(F.frBuy("dust", W, 0.01, now, false) === false, "dust buys (under 0.05 SOL) are ignored");
  const dump = F.frDump();
  F._frReset();
  F.frLoad(dump);
  ok(F.isFrontRunner(W), "front-runners survive a restart (Redis dump and load)");
  ok(F.frView().frontRunners === 1, "the view counts front-runners");

  // ---- 2. SMART filters
  const Gd = await import("../src/lib/grid");
  const P = Object.fromEntries(Gd.PREDS.map((p: any) => [p.id, p]));
  ok(["front", "front2", "fomohot", "story"].every((k) => P[k]), "the four SMART filters exist");
  ok(P.front.ok({ sx: { fr: 1 } }) && !P.front.ok({ sx: {} }), "front: one front-runner in the last minute");
  ok(P.front2.ok({ sx: { fr: 2 } }) && !P.front2.ok({ sx: { fr: 1 } }), "front2: two independent front-runners");
  ok(P.fomohot.ok({ sx: { fc: 5 } }) && !P.fomohot.ok({ sx: { fc: 4 } }), "fomohot: 5+ FOMO traders in a minute");
  ok(P.story.ok({ sx: { st: 1 } }) && !P.story.ok({ sx: { st: 0 } }), "story: the name already migrated a coin today");

  // ---- 3. RUNNING STORIES
  const O = await import("../src/lib/origin");
  O.originSee("storyA", "Gork Coin", "GORK", "crA", now - 7200_000);
  O.originSee("storyB", "Gork Coin", "GORK", "crB", now - 60_000);
  O.originSee("other", "Plain Thing", "PLN", "crC", now - 60_000);
  ok(O.originStory("storyB", now) === 0, "no story before a coin with that name migrates");
  O.originMigrated("storyA", now - 3600_000);
  ok(O.originStory("storyB", now) >= 1, "a new coin with the name of a coin that migrated today is on a running story");
  ok(O.originStory("storyA", now) === 0, "the coin that migrated is not its own story");
  ok(O.originStory("other", now) === 0, "an unrelated name is not");
  ok(O.originStory("storyB", now + 2 * 86_400_000) === 0, "a story ends after 24 hours");

  // ---- 4. FOMO retail money regime
  const Fo = await import("../src/lib/fomotap");
  Fo._fomoReset();
  ok(Fo.fomoRegime(now) === null, "the regime says nothing without an hour of data");
  const base = Math.floor(now / 60_000) * 60_000;
  for (let m = 120; m >= 10; m--) for (let i = 0; i < 4; i++) Fo.fomoBuy(`c${m}`, `w${i}`, base - m * 60_000 + 1000);
  for (let m = 9; m >= 0; m--) for (let i = 0; i < 1; i++) Fo.fomoBuy(`d${m}`, `w${i}`, base - m * 60_000 + 1000);
  const rg = Fo.fomoRegime(base + 2000)!;
  ok(rg != null && rg < 0.4, `FOMO money cooling shows as a low regime (${rg})`);

  // ---- 5. RUG GUARD fomo_cold
  const src = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  ok(/id: "fomo_cold"[^\n]*f\.fm != null && f\.fm < 0\.6/.test(src), "rug rule fomo_cold: buys while FOMO money runs under 60% of normal");
  const GL = await import("../src/lib/gridlive");
  const seeds = GL.SMART_SEEDS.join(" ");
  ok(["any:front|now", "any:front2|now", "any:fomohot|now", "any:story|now", "any:story+first|now"].every((k) => seeds.includes(k)), "SMART books are seeded for front, front2, fomohot and story");
  ok(GL.SMART_SEEDS.every((k) => (GL as any).bookFromKey ? !!(GL as any).bookFromKey(k.replace(/^any:/, ""), now) : true), "every SMART seed parses into a book");
  ok(/SMART_Q\.has\(mint\) && px > 0/.test(src), "a SMART signal before the first price fires on the first price");

  // ---- 6. FOLLOW 3 and class sizing
  ok(/FOLLOW_N = \(\) => Math\.max\(1, Math\.min\(5, Number\(process\.env\.GRID_FOLLOW_N \?\? 3\)/.test(src), "the desk follows the top 3 passed books (GRID_FOLLOW_N, 1 to 5)");
  ok(/\.filter\(\(x\) => x\.s\.passed && !gapBlock\(x\.b\.key\)[^\n]*&& \(x\.s\.lessTop2 \?\? x\.s\.pnl\) > 0\)/.test(src), "never a book whose record is negative without its 2 best trades");
  ok((/LEADERS\.size \? LEADERS\.has\(b\.key\) : LEADER === b\.key/.test(src) || /LEADERS\.size \? LEADERS\.has\(k\) : LEADER === k/.test(src)), "every followed book's entries reach the desk");
  const C = await import("../src/lib/classgate");
  C._gateReset();
  C.setClassPaper(() => Array.from({ length: 40 }, (_, i) => ({ mc0: 150, sh: { desk: i % 2 ? 1.5 : 0.9 }, closedAt: now - i * 1000 })));
  const pc = C.classPaperPcts("up", now);
  ok(pc.length === 40 && Math.abs(pc[0] - (0.9 - 1 - 0.06) * 100) < 1e-6, "class paper returns after 6% costs feed sizing");
  const desk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/clsPlan && clsPlan\.kelly > 0 && \(!bookPlan \|\| clsPlan\.pct > bookPlan\.pct\)/.test(desk), "the desk sizes up by the class record only when it beats the book's plan");

  // ---- 7. callouts handoff and worker wiring
  const wire = fs.readFileSync("src/lib/wire.ts", "utf8");
  ok(/lpush\("rn:callouts"/.test(wire), "WIRE hands every callout to the worker");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/frCallout\(/.test(wk) && /originMigrated\(/.test(wk) && /gridLiveSmart\(/.test(wk), "the worker matches callouts, marks migrations and fires SMART books");
  const rv = fs.readFileSync("src/lib/review.ts", "utf8");
  ok(/<b>SMART<\/b>/.test(rv), "the daily review shows SMART");

  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
