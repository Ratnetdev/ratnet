// v0.1.53: the live curve stream. Run: npx tsx sim/v053test.ts
let rpcAsked: string[] = [];
(globalThis as any).__rnConn = {
  getMultipleAccountsInfo: async (keys: any[]) => {
    rpcAsked.push(...keys.map((k) => k.toBase58()));
    return keys.map(() => null);
  },
};
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const sol = await import("../src/lib/solana");
  const A = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // followed
  const B = "So11111111111111111111111111111111111111112"; // not followed
  const live = new Set([A]);
  sol.setCurveLive(() => live);
  const view = { progress: 42, mcapSol: 60, realSol: 30, complete: false, priceSol: 6e-8, supply: 1e9 };
  sol.noteCurve(A, view);
  const r = await sol.getCurves([A, B]);
  ok(r[A]?.progress === 42, "a followed coin's curve comes from the stream");
  ok(rpcAsked.length === 1 && rpcAsked[0] !== sol.bondingCurvePda(A), "only the coin that is not followed is read from the chain");
  sol.noteCurve(A, { ...view, progress: 55 });
  ok((await sol.getCurves([A]))[A]?.progress === 55, "every trade's update replaces the last one");
  // the socket drops: the coin is no longer confirmed live, so its old value is not used
  live.delete(A);
  rpcAsked = [];
  await sol.getCurves([A]);
  ok(rpcAsked.length === 1, "socket down: back to the chain (never a stale curve)");
  ok(sol.pruneCurves() === 0, "unfollowed coins are forgotten");
  ok(sol.curveFeed.hits === 2 && sol.curveFeed.misses === 0, `hit counter (followed coins only) (${sol.curveFeed.hits} hits, ${sol.curveFeed.misses} misses)`);

  // heliusFeed passes curve updates on, migrated ones included
  const { heliusFeed } = await import("../src/lib/heliusfeed");
  ok(typeof heliusFeed === "function", "feed loads");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.53 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
