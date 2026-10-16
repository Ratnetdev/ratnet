// v0.1.86: a coin with no readable curve is remembered for 30s (post picks re-read every copy every second and asked
// the chain again for each empty one: ~14K reads an hour on 16 Oct). Run: npx tsx sim/v086test.ts
import { Keypair } from "@solana/web3.js";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let reads = 0;
let accounts = 0;
(globalThis as any).__rnConn = { getMultipleAccountsInfo: async (ks: any[]) => (reads++, (accounts += ks.length), ks.map(() => null)) };
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const pk = () => Keypair.generate().publicKey.toBase58();
(async () => {
  const fs = await import("fs");
  const FC = await import("../src/lib/firecache");
  const S = await import("../src/lib/solana");
  FC._fcReset();
  FC.fcConnected();
  const none = pk();
  const r1 = await S.getCurves([none]);
  ok(r1[none] === null && reads === 1 && S.curveFire.missing === 1 && S.curveFire.missingSample[0] === none, "no curve on the chain: null, counted, an example kept");
  for (let i = 0; i < 20; i++) await S.getCurves([none]);
  ok(reads === 1, "20 more passes in the next seconds: no chain read (was 20)");
  // its first trade wins at once
  const cv = { progress: 3, mcapSol: 30, realSol: 0.5, complete: false, priceSol: 3e-8, supply: 1e9 };
  FC.fcCurveTrade(none, cv, 5);
  const r2 = await S.getCurves([none]);
  ok(r2[none]?.progress === 3 && reads === 1, "a trade on its curve: the firehose's curve, not the empty mark");
  // after 30s the chain is asked again
  const other = pk();
  await S.getCurves([other]);
  const t = Date.now() + 31_000;
  FC.fcBeat(t);
  ok(!FC.fcNoCurveYet(other, t) && FC.fcNoCurveYet(other, Date.now()), "the mark lasts 30 seconds");
  // only while the firehose is live (it is what would see the curve appear)
  FC._fcReset();
  const x = pk();
  reads = 0;
  await S.getCurves([x]);
  await S.getCurves([x]);
  ok(reads === 2, "firehose down: every pass reads the chain as before");
  // a reconnect forgets every mark
  FC.fcConnected();
  await S.getCurves([x]);
  FC.fcConnected();
  await S.getCurves([x]);
  ok(reads === 4, "a reconnect forgets the marks");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/console\.log\("curves missing", curveFire\.missing, curveFire\.missingSample\.join\(","\)\)/.test(wk) && /curveMissing: curveFire\.missing/.test(wk), "the worker logs the count and examples every minute");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const bld = fs.readFileSync(new URL("../src/config/build.ts", import.meta.url), "utf8");
  ok(pkg.version === bld.match(/"([0-9.]+)"/)![1], "build tag matches the package");
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
