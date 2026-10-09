// v0.1.54: the PumpPortal trade stream follows a shortlist seeded by the minute-1 chain tape. Run: npx tsx sim/v054test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const sl = await import("../src/lib/streamlog");
  const { tapeFromStream } = await import("../src/lib/tape");
  const now = Date.now();
  const t0 = now - 60_000;
  // every launch gets a log at birth (dev buy only): never a stream tape on its own
  sl.logCreate("A", "dev", t0, 1, 1000);
  sl.logTrade({ mint: "Z", w: "x", buy: true, sol: 0.1, tok: 1 }); // trades flowing somewhere
  ok(tapeFromStream("A", "dev", t0) === null, "a launch we never followed gives no stream tape (it would read as dead)");

  // no PumpPortal key: no hook, nothing seeded
  ok(sl.seedLog("A", t0, "dev", [], 0) === false, "no key: the chain tape is not handed to the stream");

  // key, under the cap: the minute-1 chain read seeds the log and the coin is followed
  const followed: string[] = [];
  let capped = false;
  sl.setFollowHook((m) => (capped ? false : (followed.push(m), true)));
  const early = Array.from({ length: 30 }, (_, i) => ({ t: t0 + i * 400, w: `w${i}`, sol: 0.2, tok: 100, buy: true }));
  ok(sl.seedLog("A", t0, "dev", early, 55) === true && followed[0] === "A", "the minute-1 chain tape seeds the log and the coin's trades get subscribed");
  for (let i = 0; i < 20; i++) sl.logTrade({ mint: "A", w: `s${i}`, buy: i % 4 !== 0, sol: 0.3, tok: 50 });
  const tp: any = tapeFromStream("A", "dev", t0);
  ok(tp && tp.src === "stream", "the minute-5 tape comes from the stream (no second chain read)");
  ok(tp && tp.n === 75, `it counts the chain's trades plus every streamed one (${tp?.n})`);

  // the cap reached: nothing new is followed
  capped = true;
  sl.logCreate("B", "dev", t0, 1, 1000);
  ok(sl.seedLog("B", t0, "dev", early, 40) === false && tapeFromStream("B", "dev", t0) === null, "daily cap reached: no new coins, their tapes come from the chain");

  // too old to be worth following
  capped = false;
  ok(sl.seedLog("C", now - 6.5 * 60_000, "dev", early, 40) === false, "a coin past minute 6 is not followed (its call is already made)");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.54 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
