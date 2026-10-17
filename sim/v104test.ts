// v0.1.104 ATTENTION: DexScreener paid profiles and boosts, read live (every 10s) and as the truth (each called coin's
// order history with payment times, read as of the call). GRID rules dexpaid and boosted. Run: npx tsx sim/v104test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const A = await import("../src/lib/attention");
  const g = await import("../src/lib/grid");
  const T = Date.parse("2026-10-17T01:00:00Z");
  const M = "DFMt2FyLpB6ekPNAzVErLXgpSnJ9CRf1VnxBAkTLpump";

  // ---- 1. the truth: FTR's real order history (read from DexScreener on 17 Oct): paid 2.5h after launch, 2 cancelled
  const ftr = { orders: [{ type: "tokenProfile", status: "approved", paymentTimestamp: 1792038677517 }, { type: "tokenProfile", status: "cancelled", paymentTimestamp: 1792037474612 }, { type: "tokenProfile", status: "cancelled", paymentTimestamp: 1792037123450 }], boosts: [] };
  const o = A.dxParse(ftr, T);
  ok(o.p === 1792038677517 && o.b.length === 0, "the first paid profile counts; cancelled orders were never paid");
  const created = Date.parse("2026-10-15T01:59:28Z");
  ok(A.dxAt(o, created + 5 * 60_000)?.paid === 0 && A.dxAt(o, 1792038677517 + 1)?.paid === 1, "FTR at its minute-5 call: not paid yet (no look ahead); paid from 2.5h on");
  const bo = A.dxParse({ orders: [{ type: "tokenProfile", status: "approved", paymentTimestamp: T - 1000 }], boosts: [{ amount: 10, paymentTimestamp: T - 500 }, { amount: 30, paymentTimestamp: T + 60_000 }] }, T);
  ok(A.dxAt(bo, T)?.boost === 10 && A.dxAt(bo, T + 61_000)?.boost === 40, "boosts add up by payment time");
  ok(A.dxAt(null, T) === null, "no history: unknown");

  // ---- 2. the live read
  A._dxReset();
  ok(A.dxLive(M, T, T) === null, "before the first poll: unknown");
  let profiles: any[] = [];
  let boosts: any[] = [];
  const get = async (p: string) => (p.includes("profiles") ? profiles : boosts);
  await A.dxPoll(T, get);
  profiles = [{ chainId: "solana", tokenAddress: "NEWpump" }, { chainId: "bsc", tokenAddress: "0xabc" }, { chainId: "solana", tokenAddress: "SoMeTokenNotPump" }];
  boosts = [{ chainId: "solana", tokenAddress: "NEWpump", totalAmount: 10 }];
  await A.dxPoll(T + 10_000, get);
  boosts = [{ chainId: "solana", tokenAddress: "NEWpump", totalAmount: 40 }];
  await A.dxPoll(T + 20_000, get);
  await A.dxPoll(T + 30_000, get); // the same lists again
  ok(A.dxLive("NEWpump", T + 1, T + 15_000)?.paid === 1 && A.dxLive("NEWpump", T + 1, T + 15_000)?.boost === 10 && A.dxLive("NEWpump", T + 1, T + 25_000)?.boost === 40, "paid profile and boosts as first seen; a repeat list adds nothing");
  ok(A.dxLive("NEWpump", T + 1, T + 5_000)?.paid === 0, "read as of the call time");
  ok(A.dxLive("OTHERpump", T + 1, T + 25_000)?.paid === 0 && A.dxLive("OLDpump", T - 1, T + 25_000) === null, "a coin not in the lists: 0; a coin created before the poller ran: unknown");
  ok(A.dxStats.seenProfiles === 1 && A.dxStats.seenBoosts === 2, "only pump.fun coins on Solana");
  await A.dxPoll(T, async () => {
    throw new Error("503");
  });
  ok(A.dxStats.pollErr === "503", "a failed poll is recorded, nothing breaks");

  // ---- 3. the queue: after the call, 1 every 2s; the live read checked against the truth
  await R.set(`rn:call:${M}`, { at: T, sx: { dx: { paid: 0, boost: 0 } } });
  A.dxQueue(M);
  A.dxQueue(M);
  ok(A.dxStats.queue === 1, "a coin is queued once");
  const got = await A.dxDrain(async () => ({ orders: [{ type: "tokenProfile", status: "approved", paymentTimestamp: T - 60_000 }], boosts: [] }), T + 100);
  ok(got?.p === T - 60_000 && (await A.dxHistAll())[M]?.p === T - 60_000, "the order history is stored for GRID");
  ok(A.dxStats.live.paidTruth === 1 && A.dxStats.live.paidLive === 0, "the live read's miss is counted (paid before the call, the poller did not see it)");
  A.dxQueue("X429");
  await A.dxDrain(async () => {
    throw new Error("429");
  });
  ok(A.dxStats.queue === 1, "rate limited: tried again later");
  A._dxReset();
  ok((await A.dxDrain()) === null, "an empty queue does nothing");

  // ---- 4. backfill: the calls GRID tests, without a history yet
  A._dxReset();
  const pool = { query: async () => ({ rows: [{ mint: M, call: { progress: 50, verdict: "BOND" } }, { mint: "dust", call: { progress: 1, verdict: "DUST" } }, { mint: "farm", call: { progress: 50, verdict: "BOND", farm: "x" } }, { mint: "new", call: JSON.stringify({ progress: 9, verdict: "DUST" }) }] }) };
  ok((await A.dxBackfill(pool)) === 1 && A.dxStats.queue === 1, "only calls worth testing, not farms, not ones already fetched");

  // ---- 5. GRID
  const ids = g.PREDS.map((p) => p.id);
  ok(ids.includes("dexpaid") && ids.includes("boosted") && ids.indexOf("dexpaid") > ids.indexOf("serial"), "2 ATTENTION rules on GRID's menu, appended");
  const pred = (id: string) => g.PREDS.find((p) => p.id === id)!;
  ok(pred("dexpaid").ok({ sx: { dx: { paid: 1, boost: 0 } } } as any) && !pred("boosted").ok({ sx: { dx: { paid: 1, boost: 0 } } } as any) && pred("boosted").ok({ sx: { dx: { paid: 0, boost: 10 } } } as any), "each rule reads its field");
  ok(!pred("dexpaid").ok({ sx: null } as any) && !pred("dexpaid").ok({ sx: { dx: { paid: null, boost: null } } } as any), "unknown never passes");
  const s1 = g.sxOf({ at: 1, sx: { post: 1, dx: { paid: 0, boost: 0 } } }, null, null, null, { paid: 1, boost: 0 });
  ok(s1?.dx?.paid === 1 && s1.post === 1, "the order history (truth) wins over the call's live read");
  ok(g.sxOf({ at: 1 }, undefined, undefined, null, { paid: 0, boost: 0 })?.dx?.paid === 0, "an older call gets its order history");
  const gs = fs.readFileSync("src/lib/grid.ts", "utf8");
  ok(/dxAt\(dxh\[r\.mint\], Number\(c\.at\)\)/.test(gs) && /const dxh = await dxHistAll\(\)/.test(gs), "GRID reads every call's history as of its call time");

  // ---- 6. wiring
  const ds = fs.readFileSync("src/lib/digger.ts", "utf8");
  ok(/dx: dxLive\(rec\.mint, rec\.createdAt, Date\.now\(\)\)/.test(ds) && /if \(counted && !farm && worth\) dxQueue\(rec\.mint\)/.test(ds), "the call carries the live read and queues its history (never waits on it)");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/setInterval\(\(\) => dxPoll\(\)\.catch\(\(\) => null\), 10_000\)/.test(wk) && /dxDrain\(\)/.test(wk) && /\}, 2_000\);/.test(wk) && /dxBackfill\(archivePool\(\)\)/.test(wk), "poll every 10s, one history every 2s, 14 days backfilled");
  ok(/dx: dxStats/.test(wk) && /attention: rpc\?\.dx/.test(fs.readFileSync("src/lib/review.ts", "utf8")), "the counts show in the worker status and the review");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 104 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.104 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.104 checks pass");
  process.exit(fail ? 1 : 0);
})();
