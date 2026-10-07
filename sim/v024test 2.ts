// v0.1.24 checks: the RPC limiter never starves a lane, splits big batches, backs off on 429s; the exam counts
// closed positions only; a migration seen on the stream marks the curve complete. Run: npx tsx sim/v024test.ts
process.env.HELIUS_RPC_URL = "http://fake.rpc";
process.env.RPC_RPS = "20";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const hits: { t: number; n: number }[] = [];
const t0 = Date.now();
let throttle = 0;
(globalThis as any).fetch = async (_u: any, init: any) => {
  const body = JSON.parse(init.body);
  const arr = Array.isArray(body) ? body : [body];
  if (throttle > 0) {
    throttle--;
    return new Response("Too Many Requests", { status: 429 });
  }
  hits.push({ t: Date.now() - t0, n: arr.length });
  const out = arr.map((b: any) => ({ jsonrpc: "2.0", id: b.id, result: b.method === "getBalance" ? { context: { slot: 1 }, value: 5 } : null }));
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "content-type": "application/json" } });
};

async function main() {
  const { conn, lane, rpcView } = await import("../src/lib/solana");
  const { PublicKey } = await import("@solana/web3.js");
  const k = new PublicKey("So11111111111111111111111111111111111111112");

  // --- 1. the desk and the rats flood the plan; the agents and the historian still get through
  const done: Record<string, number> = {};
  const stop = Date.now() + 6000;
  const flood = (l: number) => (async () => {
    while (Date.now() < stop) await lane.run(l, () => conn().getBalance(k));
  })();
  const floods = [0, 0, 0, 1, 1, 1].map(flood);
  const t1 = Date.now();
  const few = [2, 3].map((l) => lane.run(l, async () => {
    for (let i = 0; i < 5; i++) await conn().getBalance(k);
    done[l] = Date.now() - t1;
  }));
  // a 42-call batch in the rats' lane (a tape read) while everyone floods
  const sigs = Array.from({ length: 42 }, (_, i) => "1".repeat(80 + (i % 5)) + i);
  const big = lane.run(1, async () => {
    const t = Date.now();
    await conn().getParsedTransactions(sigs, { maxSupportedTransactionVersion: 0 });
    done.big = Date.now() - t;
  });
  await Promise.all([...few, big]);
  await Promise.all(floods);
  ok(done[2] != null && done[2] < 6000, `agents finished 5 calls during the flood in ${done[2]}ms`);
  ok(done[3] != null && done[3] < 6000, `historian finished 5 calls during the flood in ${done[3]}ms`);
  ok(done.big != null && done.big < 6000, `a 42-call batch got through in ${done.big}ms`);
  const maxBatch = Math.max(...hits.map((h) => h.n));
  ok(maxBatch <= 10, `largest single request: ${maxBatch} calls (batches go out in slices of 10)`);
  const max1s = Math.max(...hits.map((h) => hits.filter((x) => x.t >= h.t && x.t < h.t + 1000).reduce((a, x) => a + x.n, 0)));
  ok(max1s <= 19, `never more than the plan in any second (max ${max1s}, cap 18)`);
  const v1 = rpcView();
  ok(v1.lanes.every((x) => x.perSec > 0), `every lane served: ${v1.lanes.map((x) => `${x.lane} ${x.perSec}/s`).join(", ")}`);

  // --- 2. 429s lower the ceiling
  throttle = 3;
  await conn().getBalance(k);
  const v2 = rpcView();
  ok(v2.capNow < v2.cap && v2.throttled1m >= 1, `after 429s the ceiling dropped to ${v2.capNow} of ${v2.cap} (${v2.throttled1m} rate-limited)`);

  // --- 3. the exam counts closed positions only
  const { K } = await import("../src/lib/redis");
  const { exam } = await import("../src/lib/desk");
  const now = Date.now();
  const T = (mint: string, side: string, at: number, pnlSol?: number) => ({ id: `${at}${mint}`, mint, symbol: mint, side, at, sol: 0.05, tokens: 1, px: 1, reason: "", live: false, ...(pnlSol != null ? { pnlSol } : {}) });
  const list = [
    T("A", "buy", now - 9000), T("A", "sell", now - 8000, 0.01), T("A", "sell", now - 7000, 0.02), // closed in two sells: 1
    T("B", "buy", now - 6000), T("B", "sell", now - 5000, 0.03), // initials sold, still open: 0
    T("C", "buy", now - 4000), T("C", "sell", now - 3500, -0.01), T("C", "buy", now - 3000), T("C", "sell", now - 2000, 0.02), // twice: 2
    T("D", "buy", now - 1000), // open, nothing sold: 0
    T("OLD", "buy", now - 99_000_000), T("OLD", "sell", now - 98_000_000, 0.5), // before this desk started: 0
  ].reverse();
  for (const t of list) await R.rpush(K.deskTrades, t);
  await R.hset(K.deskPos, { B: { mint: "B" }, D: { mint: "D" } });
  const ex = await exam({ live: false, cash: 1, start: 1, startedAt: now - 60_000_000, realized: 0, closed: 0, wins: 0, dayKey: "", dayStart: 1, peakEq: 1, maxDD: 0, liveStart: null, promotedAt: null, demotions: 0, lastEqAt: 0, equity: 1 } as any, 1);
  ok(ex.trades === 3, `exam round trips: ${ex.trades} (A once, C twice; B still open, D unsold, OLD before the start)`);
  ok(Math.round(ex.winRate) === 67, `win rate over closed trips: ${Math.round(ex.winRate)}%`);

  // --- 4. a migration on the stream marks the curve complete
  const { streamComplete } = await import("../src/lib/digger");
  await R.set(K.launch("M1"), { mint: "M1", symbol: "M", createdAt: now - 600_000 });
  const first = await streamComplete("M1", now);
  const again = await streamComplete("M1", now + 5);
  const rec: any = await R.get(K.launch("M1"));
  const migr = await R.zrange(K.migr, 0, -1);
  ok(first && !again && rec.completeAt === now && migr.includes("M1"), "stream migration: curve complete, queued for the pool check, once");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.24 checks passed");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
