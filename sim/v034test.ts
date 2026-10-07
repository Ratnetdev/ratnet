// v0.1.34 checks (fit the Helius plan). Run: npx tsx sim/v034test.ts
process.env.HELIUS_RPC_URL = "https://rpc.example/?api-key=x";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  // 1. feed quotes: priced, but never "trades flowing"; good while the feed follows the coin, stale otherwise
  const sl = await import("../src/lib/streamlog");
  const now = Date.now();
  sl.setQuote({ mint: "A", px: 1e-7, real: 12, mcSol: 100, curve: true });
  ok(!sl.tradesFlowing(), "a feed price does not make stream tapes look complete");
  ok(!!sl.streamQuote("A"), "a fresh feed price is used");
  ok(!sl.streamQuote("A", 3_000, now + 20_000), "20s later without the feed confirming the coin: stale");
  sl.markFeedLive(new Set(["A"]), now + 19_000);
  ok(!!sl.streamQuote("A", 3_000, now + 20_000), "20s later with the account followed: still good (no change = same price)");
  ok(!sl.streamQuote("A", 3_000, now + 70_000), "never older than a minute");

  // 2. version 1 transactions asked for directly (no refused v0 call first)
  const bodies: any[] = [];
  (globalThis as any).fetch = async (_u: string, init: any) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    return new Response(JSON.stringify(b.map((x: any) => ({ jsonrpc: "2.0", id: x.id, result: null }))), { status: 200 });
  };
  const so = await import("../src/lib/solana");
  await so.parsedTx("sig1");
  ok(bodies.length === 1 && bodies[0][0].params[1].maxSupportedTransactionVersion === 1, "one call, version 1 included");
  await so.parsedTxsAny(["a", "b", "c"]);
  ok(bodies.length === 2 && bodies[1].length === 3, "many transactions: one batch, no retries");
  (globalThis as any).fetch = async () => new Response("bad", { status: 500 });
  let threw = false;
  try {
    await so.parsedTx("sig2");
  } catch {
    threw = true;
  }
  ok(threw, "a failed read throws (callers retry), it is never taken as 'no transaction'");

  // 3. tape floors: at least 8% / 5% whatever settings were saved
  const { tapeFloor } = await import("../src/lib/digger");
  const f = tapeFloor({ tapeMinCurve: 5, earlyMinCurve: 3 });
  ok(f.t5 === 8 && f.t1 === 5, "old saved settings (5/3) are lifted to 8/5");
  ok(tapeFloor({ tapeMinCurve: 12, earlyMinCurve: 6 }).t5 === 12, "a higher saved floor is kept");

  // 4. desk: a position is read from the chain at most every 2s
  const cb = Buffer.alloc(150);
  cb.writeBigUInt64LE(1_000_000_000n * 1_000_000n, 8);
  cb.writeBigUInt64LE(40n * 1_000_000_000n, 16);
  cb.writeBigUInt64LE(700_000_000n * 1_000_000n, 24);
  cb.writeBigUInt64LE(10n * 1_000_000_000n, 32);
  cb.writeBigUInt64LE(1_000_000_000n * 1_000_000n, 40);
  let reads = 0;
  (globalThis as any).__rnConn = {
    getMultipleAccountsInfo: async (keys: any[]) => {
      reads++;
      return keys.map(() => ({ data: cb }));
    },
  };
  (globalThis as any).fetch = async () => new Response("{}");
  const d = await import("../src/lib/desk");
  const M = "So11111111111111111111111111111111111111112";
  const p1 = await d.priceOf([M]);
  const r1 = reads;
  const p2 = await d.priceOf([M]);
  ok(!!p1[M] && r1 >= 1, `the first price comes from the chain (${r1} call)`);
  ok(!!p2[M] && reads === r1, "the next beat within 2s reuses it (no chain call)");
  await d.priceOf([M], true);
  ok(reads > r1, "right before a buy the chain is always read");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.34 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
