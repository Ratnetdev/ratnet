// v0.1.96: PARITY. Paper pays the priority fee live transactions paid; the sell parity no longer counts the account
// rent against live; Sender gets the Helius key and its answers are counted. Run: npx tsx sim/v096test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const L = await import("../src/lib/livecost");
  const C = await import("../src/lib/costs");
  ok(L.medianFee([0.001, 0.002]) === null, "under 10 live transactions: the setting applies");
  // the 11 fees the live wallet paid on 16 Oct (SOL)
  const oct16 = [0.00041, 0.00186, 0.00177, 0.00038, 0.00191, 0.00069, 0.00145, 0.00081, 0.00101, 0.00035, 0.00021];
  const m = L.medianFee(oct16)!;
  ok(Math.abs(m - 0.00081) < 1e-9, `16 Oct median: ${m} SOL (paper charged 0.0003)`);
  ok(L.medianFee(Array(12).fill(0.05)) === 0.003 && L.medianFee(Array(12).fill(0.00001)) === 0.0001, "bounded 0.0001 to 0.003");
  ok(L.paperPriority(0.0003) === 0.0003, "no live record yet: the setting");
  for (const f of oct16) await L.noteLiveFee(Math.round(f * 1e9));
  ok(L.LIVE_FEE.prioritySol === m && L.LIVE_FEE.n === 11, `after 11 live transactions paper pays ${L.LIVE_FEE.prioritySol}`);
  const cost: any = { jitoTipMinSol: 0.0001, jitoTipMaxSol: 0.002, get paperPrioritySol() { return L.paperPriority(0.0003); } };
  ok(Math.abs(C.txCost(0.05, cost) - (0.0002 + m + 0.000005)) < 1e-9, "txCost reads the live fee through the getter");
  // sell parity: SOLCAT 16 Oct, proceeds 0.04096 (wallet delta), triggered at 4.025e-8 on 1,055,064 tokens
  const model = C.sellProceeds(1055064, 4.025e-8, false, 10, { jitoTipMinSol: 0.0001, jitoTipMaxSol: 0.002, paperPrioritySol: 0.0003 }, false);
  const parNow = (0.04096 / model - 1) * 100;
  ok(Math.abs(parNow) < 2, `SOLCAT sell parity without the rent: ${parNow.toFixed(1)}% (was booked -4.7%)`);
  // wiring
  const desk = fs.readFileSync("src/lib/desk.ts", "utf8");
  const exec = fs.readFileSync("src/lib/exec.ts", "utf8");
  ok(/COST, false\);\n\s*if \(model > 0\) par = \{ out:/.test(desk), "the sell model leaves the rent out (it comes back in its own tx)");
  ok((desk.match(/if \(real\?\.fee\) await noteLiveFee\(real\.fee\)/g) || []).length === 2, "every live buy and sell records its fee");
  ok(/fee: Number\(tx\.meta\.fee\)/.test(exec), "realDelta reads the fee from the chain");
  for (const f of ["src/lib/grid.ts", "src/lib/gridlive.ts"]) ok(/get paperPrioritySol\(\) \{ return paperPriority\(D\.paperPrioritySol\); \}/.test(fs.readFileSync(f, "utf8")), `${f} pays the live fee`);
  process.env.HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=TESTKEY";
  const E = await import("../src/lib/exec");
  ok(E._senderUrl() === "https://sender.helius-rpc.com/fast?api-key=TESTKEY", "Sender gets the Helius key");
  ok(/senderStats\.ok\+\+/.test(exec) && /replace\(\/api-key=\\S\+\/gi, ""\)/.test(exec), "Sender answers are counted, never with the key");
  ok(/exec: \{ sender: senderStats, liveFee: LIVE_FEE \}/.test(fs.readFileSync("worker/index.ts", "utf8")), "/status gets the Sender and live fee numbers");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 96 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.96 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.96 checks pass");
  process.exit(fail ? 1 : 0);
})();
