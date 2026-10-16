// v0.1.93: launches are logged 30 minutes (post picks read copies up to 30 min old: past 7 minutes their tapes came
// from the chain every pass, ~108K reads an hour); a chain tape of an older coin is reused 3 minutes, never for the
// minute-1 and minute-5 reads. Run: npx tsx sim/v093test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const SL = await import("../src/lib/streamlog");
  const T = await import("../src/lib/tape");
  const realNow = Date.now;
  const t0 = realNow();
  SL.logCreate("C", "dev", t0, 0, 0, true);
  (Date as any).now = () => t0 + 20 * 60_000;
  SL.logTrade({ mint: "C", w: "late", buy: true, sol: 1, tok: 1 });
  ok(SL.streamLog("C", t0)?.trades.some((x) => x.w === "late") === true, "a trade 20 minutes in is still logged (was cut at 7)");
  const tp = T.tapeFromStream("C", "dev", t0, undefined, t0 + 20 * 60_000);
  ok(tp?.src === "stream", "the copy's tape comes from the stream at 20 minutes");
  for (let i = 0; i < 3100; i++) SL.logTrade({ mint: "C", w: `w${i}`, buy: true, sol: 0.1, tok: 1 });
  const l = SL.streamLog("C", t0)!;
  ok(l.trades.length === 3000 && l.trades[0].w === "late" && l.trades[l.trades.length - 1].w === "w3099", "a full log keeps its first trades and the newest (recent stays recent)");
  (Date as any).now = realNow;
  ok(SL.streamLogWhy("GONE", t0 - 31 * 60_000, t0) === "old", "older than 30 minutes: old");
  let reads = 0;
  (globalThis as any).__rnConn = { getSignaturesForAddress: async () => ((reads++), []) };
  const oldMint = "So11111111111111111111111111111111111111112";
  const youngMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  // a non-null chain tape is needed for caching: getSignatures returns [] -> null, so count reads only
  await T.readTape(oldMint, "c", t0 - 40 * 60_000);
  await T.readTape(oldMint, "c", t0 - 40 * 60_000);
  ok(reads === 2, "an empty chain read is not kept (read again)");
  (globalThis as any).__rnConn = { getSignaturesForAddress: async () => ((reads++), [{ signature: "s1", slot: 1, err: null }]), getParsedTransactions: async () => [null] };
  reads = 0;
  const S = await import("../src/lib/solana");
  await T.readTape(oldMint, "c", t0 - 40 * 60_000);
  await T.readTape(oldMint, "c", t0 - 40 * 60_000);
  ok(reads === 1 && T.tapeStats.cached >= 1, `a 40-minute-old coin's chain tape is reused (${reads} read)`);
  reads = 0;
  await T.readTape(youngMint, "c", t0 - 60_000);
  await T.readTape(youngMint, "c", t0 - 60_000);
  ok(reads === 2, "a coin in its first minutes is always read fresh (minute-1 and minute-5 reads)");
  void S;
  const st = fs.readFileSync(new URL("../src/components/StatusBoard.tsx", import.meta.url), "utf8");
  ok(/reused/.test(st) && /older than 30 min/.test(st), "/status shows reused tapes");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const bld = fs.readFileSync(new URL("../src/config/build.ts", import.meta.url), "utf8");
  ok(pkg.version === "0.1.93" && bld.includes('"0.1.93"'), "v0.1.93");
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
