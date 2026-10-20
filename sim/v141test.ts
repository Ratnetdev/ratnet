// v0.1.141 KING HOLD: the King's BOND calls entered later (migration, 30% dip, 2 min in) and held for the migration.
// Run: npx tsx sim/v141test.ts
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
  ok(L.KING_SEEDS.length === 12, "12 KING HOLD books: 3 King filters x 3 later entries with the hold exit, plus 3 at the migration with a runner exit");
  ok(L.KING_SEEDS.every((k) => !!L.bookFromKey(k, now)), "every one parses into a book");
  ok(G.isRunner(L.KING_HOLD) && G.firstSell(L.KING_HOLD) === 0.5 && L.KING_HOLD.hours === 24 && L.KING_HOLD.stop === 0.5, "the hold exit: half at 2x, half rides a 50% trail up to 24h, stop -50%");
  ok(L.KING_SEEDS.some((k) => k.startsWith("bond+pw1|mig|")) && L.KING_SEEDS.some((k) => k.startsWith("bond|d30|")) && L.KING_SEEDS.some((k) => k.startsWith("bond+p70|h2|")), "entries at the migration, on a 30% dip, and 2 minutes in");
  ok(!L.KING_SEEDS.some((k) => /\|now\|/.test(k)), "none buys at the call (that lost on paper)");
  L.gridLiveReset();
  L._setBooks([]);
  L._setTrips([]);
  const seeded = L._seedKing(now);
  ok(seeded.length === 12 && seeded.every((b) => b.by === "king" && !b.any), "seeded as the king family, on the King's calls (not every launch)");
  ok(L._seedKing(now).length === 0, "seeded once");
  const src = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  ok(/const kings = seedKing\(now\);/.test(src), "GRID LIVE seeds them on its tend");
  ok(JSON.parse(fs.readFileSync("package.json", "utf8")).version >= "0.1.141", "v0.1.141 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.141 checks pass");
  process.exit(fail ? 1 : 0);
})();
