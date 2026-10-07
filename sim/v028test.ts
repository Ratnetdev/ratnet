// v0.1.28 checks: stream-first tapes, the paced daily chain budget, graduation proof, Redis pruning and the monthly
// pace on /status. Run: npx tsx sim/v028test.ts
process.env.RPC_CALLS_PER_DAY = "100000";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
(globalThis as any).fetch = async () => new Response("{}");
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  let chainReads = 0;
  (globalThis as any).__rnConn = {
    getSignaturesForAddress: async () => {
      chainReads++;
      return [];
    },
    getBalance: async () => 0,
    getSlot: async () => 1,
  };

  // 1. a launch the stream saw from birth: its tape comes from the stream, no chain read
  const { logCreate, logTrade, streamQuote } = await import("../src/lib/streamlog");
  const { readTape } = await import("../src/lib/tape");
  const { Keypair } = await import("@solana/web3.js");
  const mint = Keypair.generate().publicKey.toBase58();
  const t0 = Date.now() - 60_000;
  logCreate(mint, "DEV", t0, 1, 30_000_000);
  for (let i = 0; i < 60; i++) logTrade({ mint, w: `W${i % 25}`, buy: i % 4 !== 3, sol: 0.3 + (i % 5) * 0.1, tok: 1_000_000, vSol: 31 + i * 0.2, mcSol: 30 + i * 0.3 });
  const tape: any = await readTape(mint, "DEV", t0);
  ok(!!tape && tape.src === "stream", `tape built from the stream (src=${tape?.src})`);
  ok(chainReads === 0, `no chain read for a streamed launch (${chainReads})`);
  ok(tape && tape.n === 61, `the tape counts every streamed trade plus the dev buy (n=${tape?.n})`);
  ok(tape && tape.uniq > 0 && tape.uniq <= 26, `unique wallets measured (${tape?.uniq})`);
  const q = streamQuote(mint);
  ok(!!q && q.px > 0, "a live quote is kept for the desk");
  const old: any = await readTape(Keypair.generate().publicKey.toBase58(), "X", t0);
  ok(chainReads >= 1 && old === null, "a launch the stream never saw falls back to the chain");
  const forced: any = await readTape(mint, "DEV", t0, undefined, { rpc: true });
  ok(chainReads >= 2 && forced === null, "rpc:true forces the chain read (insiders at buy time)");

  // 2. the daily budget: historian stops first, the desk last (and may go 15% over)
  const sol = await import("../src/lib/solana");
  const day = new Date().toISOString().slice(0, 10);
  const b0 = sol.budgetState();
  ok(b0.budget === 100000, `budget read from RPC_CALLS_PER_DAY (${b0.budget})`);
  sol.seedDayUsed(day, Math.round(b0.pace * 0.95));
  ok(!sol.laneOpen(3) && sol.laneOpen(2) && sol.laneOpen(1) && sol.laneOpen(0), "at 95% of pace only the historian pauses");
  sol.seedDayUsed(day, Math.round(b0.pace * 1.02));
  ok(!sol.laneOpen(3) && !sol.laneOpen(2) && sol.laneOpen(1) && sol.laneOpen(0), "past pace the agents pause too, the rats and desk still read");
  sol.seedDayUsed(day, 100_000);
  ok(!sol.laneOpen(1) && sol.laneOpen(0), "at the full day's budget only the desk reads");
  sol.seedDayUsed(day, 116_000);
  ok(!sol.laneOpen(0), "past 115% even the desk stops");
  sol.seedDayUsed("2000-01-01", 999_999);
  ok(sol.budgetState().used === 116_000, "a seed from another day is ignored");
  let threw = "";
  await sol.lane.run(3, () => sol.limitedFetch("https://rpc.example", { method: "POST", body: "{}" }).catch((e: any) => (threw = e?.constructor?.name || String(e))));
  ok(threw === "BudgetError", `a paused lane's call is refused before it is sent (${threw})`);

  // 3. the status page: monthly pace from the live rate, not from today's partial count
  const { rpcDayView } = await import("../src/lib/rpcday");
  const v = await rpcDayView(3.5);
  ok(v.perMonth === Math.round(3.5 * 86400 * 30), `monthly pace = live rate x a month (${v.perMonth})`);
  ok(v.budget === 100000 && v.pace > 0, "budget and pace shown");

  // 4. graduation proof: the canonical pool existing is enough, however much SOL is left in it
  const { migrated } = await import("../src/lib/pool");
  ok(migrated({ pool: "P", sol: 1.2, tok: 1, px: 1 }) && !migrated(null), "a dumped canonical pool still counts as migrated");

  // 5. Redis pruning: count tables drop their one-off entries (and the same fields from linked tables)
  const { K } = await import("../src/lib/redis");
  const { GK } = await import("../src/lib/graph");
  const { pruneRedis, PRUNE_CAPS } = await import("../src/lib/prune");
  Object.assign(PRUNE_CAPS, { dev: 3, wallet: 3, funder: 3, fof: 3, near: 3 });
  await R.hset(K.devN, { a: 1, b: 5, c: 1, d: 1, e: 2 });
  await R.hset(K.devB, { a: 1, b: 2 });
  await R.hset(GK.fof, { w1: "f", w2: "f", w3: "~", w4: "f", w5: "f" });
  await R.hset("rn:ct:last", { m1: { at: Date.now() - 3 * 86400_000 }, m2: { at: Date.now() } });
  await R.sadd(K.near, "n1", "n2", "n3", "n4", "n5", "n6");
  const pr: any = await pruneRedis();
  const devN: any = await R.hgetall(K.devN);
  const devB: any = await R.hgetall(K.devB);
  ok(devN.b === 5 && devN.e === 2 && !("c" in devN), `dev table kept repeat devs (${Object.keys(devN).join(",")})`);
  ok(!devB || !("a" in devB), "the same field left the bonded table");
  ok(Number(await R.hlen(GK.fof)) <= 3, "funder cache trimmed to its cap");
  const last: any = await R.hgetall("rn:ct:last");
  ok(last && last.m2 && !last.m1, "CATCH looks older than a day dropped");
  ok(Number(await R.scard(K.near)) <= 3, "near set trimmed");
  const again: any = await pruneRedis();
  ok(again.prune === "not due", "pruning runs at most once per 6 hours");
  void pr;

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.28 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
