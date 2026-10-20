// v0.1.131: the live record is live trades only, measured against what was put into the live wallet; the equity line
// never shows broken paper bookkeeping. Run: npx tsx sim/v131test.ts
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const { DEFAULT_SETTINGS } = await import("../src/config/site");
  ok((DEFAULT_SETTINGS.desk as any).liveFundedSol === 2, "liveFundedSol defaults to the 2 SOL put into the live wallet");
  const dk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/const lc = closed\.filter\(\(t\) => t\.live\);/.test(dk) && /start: r4\(funded\),/.test(dk) && /returnPct: eqNow != null \? Math\.round\(\(eqNow \/ funded - 1\) \* 1000\) \/ 10 : null,/.test(dk), "live record: live trades only, return against the funded amount (was the balance at the last restart: +9.1% while down 1.26 SOL)");
  ok(/sessionPct:/.test(dk) && /since last restart/.test(fs.readFileSync("src/components/TrackRecord.tsx", "utf8")), "the change since the last restart is shown next to it, labelled");
  ok(/if \(eq2\.value > 0 && \(state\.live \|\| !state\.liveWallet\)\) await r\.rpush\(K\.deskEq/.test(dk) && /const ok = xs\.filter\(\(x\) => x && x\.eq > 0\);/.test(dk) && /x\.eq > 0\)/.test(fs.readFileSync("src/app/api/desk/equity/route.ts", "utf8")), "the equity line: no paper points after the live switch, no points at or under 0 (101 of them showed -0.73)");
  ok(/state\.live && walletSol != null && walletSol > 0 && \(state\.start < 0 \|\| state\.cash < 0\)/.test(dk), "negative paper leftovers follow the wallet while live");
  ok(/liveFunded \|\| st\?\.liveStart/.test(fs.readFileSync("src/components/DeskBoard.tsx", "utf8")) && !/drawdown is under 40%/.test(fs.readFileSync("src/components/DeskNow.tsx", "utf8")), "the desk page uses the funded amount; the 40% text is gone");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 131 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.131 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.131 checks pass");
  process.exit(fail ? 1 : 0);
})();
