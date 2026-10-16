// v0.1.88: a refused chain call is not counted as a read, and the historian stops when its lane closes instead of
// skipping launches on refused reads. Run: npx tsx sim/v088test.ts
process.env.RPC_CALLS_PER_DAY = "1000";
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const S = await import("../src/lib/solana");
  S.seedDayUsed(new Date().toISOString().slice(0, 10), 5000, [0, 1000, 1000, 3000]);
  let threw = "";
  await S.lane.run(3, () => S.limitedFetch("https://rpc.example", { method: "POST", body: JSON.stringify({ method: "getTransaction" }) }).catch((e: any) => (threw = e?.constructor?.name || String(e))));
  ok(threw === "BudgetError", "the closed historian lane refuses the call");
  ok(!S.methodsView().top.some(([k]) => k.startsWith("historian:getTransaction")), "a refused call is not counted as a read");
  const h = fs.readFileSync(new URL("../src/lib/historian.ts", import.meta.url), "utf8");
  ok(/if \(!laneOpen\(3\)\) break;/.test(h), "the historian checks its lane every round");
  ok(/if \(e instanceof BudgetError\) refused = true;/.test(h) && /st\.pos -= chunk\.length;\s*break;/.test(h), "a chunk with refused reads is read again next session, not skipped");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const bld = fs.readFileSync(new URL("../src/config/build.ts", import.meta.url), "utf8");
  ok(pkg.version === "0.1.88" && bld.includes('"0.1.88"'), "v0.1.88");
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
