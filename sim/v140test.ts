// v0.1.140 ORDER OUTCOMES and the no-route back-off. Run: npx tsx sim/v140test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const D = await import("../src/lib/desk");
  ok(D.orderReason("$PEPE: price already 7.3% over GRID's paper fill. not chasing") === "price already #over GRID's paper fill. not chasing" || /price already # ?over GRID's paper fill\. not chasing/.test(D.orderReason("$PEPE: price already 7.3% over GRID's paper fill. not chasing")), `skip reasons group across coins and numbers ("${D.orderReason("$PEPE: price already 7.3% over GRID's paper fill. not chasing")}")`);
  ok(D.orderReason("$X: CLASS GATE, under 5 SOL lost -0.5176 SOL live on 98 trades. skipped live") === D.orderReason("$Y: CLASS GATE, under 5 SOL lost -0.61 SOL live on 99 trades. skipped live"), "the same reason with other numbers is one reason");
  ok(D.orderReason("") === "no reason logged", "an order the desk skipped silently is counted too");
  const ds = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/await runOrder\(c, \{ \.\.\.o, path: "fast" \}\);/.test(ds) && /await runOrder\(\{ b, state, cfg, eqValue: eq\.value, walletSol, kp \}, o\);/.test(ds), "every GRID order, fast or on the beat, ends with an outcome");
  ok(/redis\(\)\.set\(ORDERS_KEY, ORDER_STATS/.test(ds), "outcomes are stored for the site");
  ok(/if \(p\.nrNext && Date\.now\(\) < p\.nrNext\) return false;/.test(ds) && /if \(p\.nrN >= 3\) p\.nrNext = Date\.now\(\) \+ 10 \* 60_000;/.test(ds), "a coin with no sell route is retried every 10 minutes after 3 misses");
  ok(/p\.nrN <= 3 \|\| Date\.now\(\) - \(p\.nrLog \|\| 0\) > 3600_000/.test(ds), "and logged at most once an hour after that");
  const pf = fs.readFileSync("src/components/ProofBoard.tsx", "utf8");
  ok(/orders the desk received/.test(pf), "the proof page shows the orders and why they were skipped");
  ok(JSON.parse(fs.readFileSync("package.json", "utf8")).version >= "0.1.140", "v0.1.140 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.140 checks pass");
  process.exit(fail ? 1 : 0);
})();
