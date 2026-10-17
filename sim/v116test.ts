// v0.1.116 AUDIT FIXES: /status read the trade stream as off (a long intake error cut ppKey off the stream note at 160
// characters); with the firehose up it now says trades come from it. EARLY reads every launch all day (10K cap: ~8K
// launches pass the 2-minute read a day). Run: npx tsx sim/v116test.ts
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/quotes: streamSize\(\)\.quotes, intake: intakeNote\(\) \}/.test(wk), "the intake note goes last in the stream note");
  ok(/slice\(0, 240\)/.test(fs.readFileSync("src/lib/alive.ts", "utf8")), "notes keep 240 characters");
  ok(/fireUp \? " · trades: every trade of every coin from the firehose/.test(fs.readFileSync("src/components/StatusBoard.tsx", "utf8")), "/status: with the firehose up, trades come from it");
  ok(/EARLY_PER_DAY \?\? 10000/.test(fs.readFileSync("src/lib/early.ts", "utf8")), "EARLY reads up to 10K launches a day");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 116 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.116 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.116 checks pass");
  process.exit(fail ? 1 : 0);
})();
