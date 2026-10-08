// v0.1.42: the worker's shared launch records (one object per coin, never replaced by an empty read), a launch seen
// twice is never dug twice, the shared radar read, parked nano lessons, price reads that fail are retried instead of
// scored -95%, FLASH waiting for a migration to be confirmed, the X queue drained oldest first and only after the
// ingest, the regime's cold start, the new prune caps and HOUND reusing the webhook Helius already has.
// Run: npx tsx sim/v042test.ts
process.env.RATNET_WORKER = "1";
process.env.HELIUS_API_KEY = "test-key";
process.env.HELIUS_HOOK_SECRET = "hook-secret";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const realFetch = globalThis.fetch;

(async () => {
  const { K } = await import("../src/lib/redis");
  const L = await import("../src/lib/launches");
  const base: any = { mint: "MintA", sig: "s", creator: "c", name: "A", symbol: "A", uri: "", devBuySol: 1, createdAt: Date.now() - 60_000, image: "", description: "", twitter: "", telegram: "", website: "", devN: 0, devB: 0, dugAt: Date.now(), dugBy: "rat", p0: 5, mcap0: 30, pNow: 5, peak: 40, cp: { t5: { p: 40 } } };

  // 1. one record per coin in the worker: every lane holds the same object, a missing key never wipes it
  await L.putLaunch(R as any, base, { ex: 3600 });
  const a = await L.getLaunch("MintA");
  const b = (await L.getLaunches(["MintA"]))[0];
  ok(!!a && a === b, "two lanes asking for the same coin get the same object");
  a!.outcome = "BONDED" as any;
  ok((await L.getLaunch("MintA"))?.outcome === "BONDED", "a change one lane makes is seen by the next lane at once");
  await R.del(K.launch("MintA"));
  ok((await L.getLaunches(["MintA"], 0))[0]?.cp?.t5?.p === 40, "an empty read from Redis never replaces the record the worker holds");

  // 2. a launch that is already stored is not dug again (the stream and the chain path both see it)
  const dig = await import("../src/lib/digger");
  await L.putLaunch(R as any, { ...base, mint: "MintB" }, { ex: 3600 });
  const res = await dig.ingestStream([{ mint: "MintB", sig: "s2", creator: "c", name: "B", symbol: "B", uri: "", devBuySol: 1, createdAt: Date.now() }]);
  const after = await R.get<any>(K.launch("MintB"));
  ok(res.dug === 0 && after?.cp?.t5?.p === 40 && after?.peak === 40, "the second sighting leaves the stored record and its checkpoints alone");

  // 3. the radar's top: one read shared by every caller for 8 seconds
  const { radarTop } = await import("../src/lib/lcache");
  await R.zadd(K.radar, { score: 50, member: "M1" }, { score: 70, member: "M2" });
  let zr = 0;
  const origZr = R.zrange.bind(R);
  (R as any).zrange = (...x: any[]) => (zr++, origZr(...x));
  const t1 = await radarTop(100);
  await radarTop(50);
  await radarTop(10);
  (R as any).zrange = origZr;
  ok(zr === 1 && t1[0] === "M2", "three callers, one Redis read, hottest first");

  // 4. lessons that cannot get the trainer's lock are parked, and the next holder learns them
  const nano = await import("../src/lib/nano");
  const x = nano.NANO_FEATURES.map((_, i) => (i === 0 ? 1 : 0));
  await R.set("rn:lock:nano", "someone-else", { px: 60_000 } as any);
  await dig.applyNano([{ k: 0, x, y: true }, { k: 0, x, y: false }]);
  ok((await R.llen("rn:nano:pending")) === 2, "lock busy: the 2 lessons wait in the parking list (not lost, not trained without the lock)");
  await R.del("rn:lock:nano");
  const before = (await R.get<any>(K.nano))?.n || 0;
  await dig.applyNano([]);
  const m = await R.get<any>(K.nano);
  ok((await R.llen("rn:nano:pending")) === 0 && (m?.n || 0) >= before + 2, "the next pass with the lock learns the parked lessons, even with no new ones");

  // 5. a price read that fails is unknown, not a -95% loss
  const hound = await import("../src/lib/hound");
  (globalThis as any).fetch = async () => {
    throw new Error("network down");
  };
  const MX = "So11111111111111111111111111111111111111112";
  const MY = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const cp = await hound.copyPrices([MX, MY]);
  ok(cp.failed.has(MX) && cp.failed.has(MY) && !Object.keys(cp.px).length, "RPC and DexScreener down: both coins are marked failed, to be priced again in 10 minutes");
  (globalThis as any).__rnConn = { getMultipleAccountsInfo: async (k: unknown[]) => k.map(() => null) };
  (globalThis as any).fetch = async () => new Response("[]", { status: 200 });
  const cp2 = await hound.copyPrices([MX, MY]);
  ok(!cp2.failed.size, "every read answered and no market anywhere: that one does count as dead");
  (globalThis as any).fetch = realFetch;
  delete (globalThis as any).__rnConn;

  // 6. FLASH: a full curve without a confirmed migration waits before it is labelled
  const flash = await import("../src/lib/flash");
  const id = "MintF:15";
  const created = Date.now() - 70 * 60_000;
  await L.putLaunch(R as any, { ...base, outcome: undefined, mint: "MintF", createdAt: created, completeAt: created + 20 * 60_000 }, { ex: 3600 });
  await R.hset("rn:fl:s", { [id]: { id, mint: "MintF", sym: "F", stage: 15, at: created + 5000, createdAt: created, mcSol: 30, x: [1], p: 0.4, prior: 0 } });
  await R.zadd("rn:fl:due", { score: Date.now() - 1000, member: id });
  const fl: any = await flash.flashFollow();
  const due = await R.zscore("rn:fl:due", id);
  ok(fl.labelled === 0 && Number(due) > Date.now() && !!(await R.hget("rn:fl:s", id)), "curve full, no outcome yet: not labelled bonded, asked again in 5 minutes");

  // 7. the X queue: oldest first, removed only after the ingest, a bad batch dropped after 3 tries
  const wire = await import("../src/lib/wire");
  const tw = (n: number) => ({ id: `t${n}`, h: "someone", text: `post number ${n} about nothing`, at: Date.now() + n, kind: "post", f: 10 });
  for (let i = 1; i <= 3; i++) await R.lpush(wire.X_INQ, tw(i)); // t3 at the head, t1 at the tail
  await R.lpush(wire.X_INQ, tw(4));
  await R.ltrim(wire.X_INQ, 0, -1);
  const n1 = await wire.drainXQueue();
  const seen = ((await R.lrange<any>("rn:x:tw", 0, -1)) || []).map((t: any) => t.id);
  ok(n1 === 4 && (await R.llen(wire.X_INQ)) === 0 && seen[seen.length - 1] === "t1" && seen[0] === "t4", "4 posts ingested oldest first, then removed from the queue");
  await R.lpush(wire.X_INQ, tw(9));
  const origSet = R.set.bind(R);
  (R as any).set = async () => {
    throw new Error("redis hiccup");
  };
  for (let i = 0; i < 2; i++) await wire.drainXQueue().catch(() => null);
  const kept = await R.llen(wire.X_INQ);
  await wire.drainXQueue().catch(() => null);
  (R as any).set = origSet;
  ok(kept === 1 && (await R.llen(wire.X_INQ)) === 0, "a batch the ingest keeps failing stays for 2 tries and is dropped on the 3rd");

  // 8. regime: a reading with missing inputs is kept a minute, not the whole hour
  const rg = await import("../src/lib/regime");
  const now = Date.now();
  const g0 = await rg.regimeAt(now);
  const { hourKey } = await import("../src/lib/redis");
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  await R.hset("rn:solh", { [hourKey(now)]: 200, [hourKey(now - 24 * 3600_000)]: 180 });
  await R.hset("rn:sold", { [day(now - 7 * 86400_000)]: 150 });
  await R.hset("rn:lrate", { [hourKey(now)]: 900 });
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  const g1 = await rg.regimeAt(now);
  Date.now = realNow;
  ok(g0.sol24 == null && g1.sol24 != null && g1.lrate === 900, `cold start: empty at first, filled a minute later (SOL 24h ${g1.sol24}%)`);

  // 9. prune: the run board keeps its best 2,000
  const pr = await import("../src/lib/prune");
  for (let i = 0; i < 2600; i++) await R.zadd("rn:run:best", { score: i, member: `r${i}` });
  await R.del("rn:prune:at");
  const out: any = await pr.pruneRedis();
  ok((await R.zcard("rn:run:best")) === 2000 && (await R.zscore("rn:run:best", "r2599")) != null && out.prune.runBest === 600, "2,600 runs on the board: the 600 weakest go, the best stay");

  // 10. HOUND without a remembered webhook reuses the one Helius already has for this site
  const { SITE } = await import("../src/config/site");
  await R.hset("rn:hd:w", { W1: { w: "W1", cls: "kol", name: "k", conf: "confirmed", proof: [], src: [], at: 1 } });
  await R.del(hound.HOOK);
  const calls: string[] = [];
  (globalThis as any).fetch = async (u: string, o: any) => {
    calls.push(`${o?.method || "GET"} ${String(u).replace(/\?.*/, "")}`);
    if (!o?.method) return new Response(JSON.stringify([{ webhookID: "other", webhookURL: "https://elsewhere.xyz/hook" }, { webhookID: "exist-1", webhookURL: `${SITE.url}/api/hound/hook` }]), { status: 200 });
    return new Response(JSON.stringify({ webhookID: "exist-1" }), { status: 200 });
  };
  await hound.syncHook(true);
  (globalThis as any).fetch = realFetch;
  ok(calls.join() === "GET https://api.helius.xyz/v0/webhooks,PUT https://api.helius.xyz/v0/webhooks/exist-1" && (await R.get<any>(hound.HOOK))?.id === "exist-1", "no saved id: the existing webhook is found and updated, no second one is made");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.42 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
