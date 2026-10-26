// v0.1.144: ONE JUDGE (a GRID order is not stopped again by the class gate or SHIELD's soft checks) and the BOOST
// family. Run: npx tsx sim/v144test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const L = await import("../src/lib/gridlive");
  const G = await import("../src/lib/grid");
  const now = Date.now();
  const desk = fs.readFileSync("src/lib/desk.ts", "utf8");
  const ge = desk.slice(desk.indexOf("async function gridEntry("), desk.indexOf("async function gridEntry(") + 9000);
  ok(/const GRID_ONE_JUDGE = process\.env\.GRID_ONE_JUDGE !== "0"/.test(desk), "one judge is on by default (GRID_ONE_JUDGE=0 turns it off)");
  ok(/if \(state\.live && !GRID_ONE_JUDGE\) \{\s*const cg = classGate/.test(ge), "the class gate does not stop a GRID order");
  ok(/GRID_ONE_JUDGE \? sh\.hardFail : sh\.hardFail \|\| sh\.softFail/.test(ge), "SHIELD's hard checks still stop it, the soft ones only note it");
  ok(/if \(o\.rug\)/.test(ge) && /not chasing/.test(ge), "the rug guard and the chase guard stay");
  ok(!!G.PREDS.find((p) => p.id === "p90")?.ok({ progress: 92 } as any) && !G.PREDS.find((p) => p.id === "p90")!.ok({ progress: 80 } as any), "p90: curve 90%+");
  ok(L.BOOST_SEEDS.length === 4 && L.BOOST_SEEDS.every((k) => k.startsWith("any:") && !!L.bookFromKey(k.replace(/^any:/, ""), now)), "4 BOOST books, every launch, all parse");
  ok(L.BOOST_SEEDS.every((k) => /\|now\|/.test(k) && /\/hold$/.test(k)), "they buy on the curve and hold through the migration");
  L.gridLiveReset();
  L._setBooks([]);
  L._setTrips([]);
  const s = L._seedBoost(now);
  ok(s.length === 4 && s.every((b) => b.by === "boost" && b.any), "seeded as the boost family");
  ok(L._seedBoost(now).length === 0, "once");
  ok(/const boosts = seedBoost\(now\);/.test(fs.readFileSync("src/lib/gridlive.ts", "utf8")), "seeded on the tend");
  ok(JSON.parse(fs.readFileSync("package.json", "utf8")).version >= "0.1.144", "v0.1.144 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.144 checks pass");
  process.exit(fail ? 1 : 0);
})();
