// v0.1.129: EARNERS only book curve trades and the coin's own SOL pool; misread amounts are refused.
// Run: npx tsx sim/v129test.ts
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const E = await import("../src/lib/earners");
  E._earnReset();
  const now = Date.now();
  E.earnTrade({ mint: "U", user: "w1", isBuy: true, sol: 0.5, tokens: 1000, at: now });
  E.earnTrade({ mint: "U", user: "w1", isBuy: false, sol: 192_989, tokens: 1000, at: now + 1 });
  ok(!E.earnRec("w1")!.n, "a sell reported as 192,989 SOL is refused (the trip stays open)");
  E.earnLoad({ w2: { n: 10, w: 7, pnl: 1_296_311, gw: 1, gl: 0, at: now } });
  ok(!E.earnRec("w2"), "a saved record with +1.3M SOL is not loaded");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/if \(t\.venue === "curve" \|\| t\.mcSol != null\) earnTrade\(t\);/.test(wk), "the worker books curve trades and the canonical SOL pool only");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 129 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.129 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.129 checks pass");
  process.exit(fail ? 1 : 0);
})();
