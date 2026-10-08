// v0.1.41: the bandwidth governor's hourly test and level 3, Node zlib on the wire with an inflate cap, list
// counters that jump on a reset, the nano history flag and live-lesson gate, CATCH's capped inputs, the memory rate
// limiter, the price cache as one value, and a deleted Helius webhook being recreated.
// Run: npx tsx sim/v041test.ts
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

(async () => {
  // 1. governor: the hour's rate catches a burst the day test misses
  const gov = await import("../src/lib/bwgov");
  const at = Date.UTC(2026, 9, 8, 13, 30, 0); // 13:30 UTC, 30 minutes into the hour
  const hourly = 2.8e9 / 24;
  ok(gov.levelFor(0.264e9, 0, at) === 0, "day test alone: 264MB by 13:30 looks fine (the 8 Oct blind spot)");
  ok(gov.levelFor(0.264e9, 0.175e9, at) === 3, "the same afternoon at 350MB an hour: saving mode 3 from the hourly test");
  ok(gov.levelFor(0.264e9, hourly * 0.5 * 1.3, at) === 1, "1.3x the hourly allowance: mode 1");
  ok(gov.levelFor(0.264e9, hourly * 0.5 * 2, at) === 2, "2x: mode 2");
  ok(gov.levelFor(2.9e9, 0, at) === 3, "the whole day's allowance used: mode 3");
  gov._bwSet(2.9e9, Date.now(), 0);
  ok(gov.bwMul() === 10, "mode 3 stretches caches 10x");
  gov._bwSet(0, Date.now(), 0);
  ok(gov.bwMul() === 1, "back to normal");
  ok(gov.hourRate(hourly / 6, Date.UTC(2026, 9, 8, 13, 2, 0)) < 1.01, "the first minutes of an hour are projected over at least 10 minutes");

  // 2. wire: Node's zlib, same format as the web stream, inflation capped
  const w = await import("../src/lib/rediswire");
  ok(w._wireEngine() === "zlib", "the worker and Vercel functions compress with Node's zlib");
  const big = JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => ({ i, mint: `Mint${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, v: Math.sin(i) })) });
  const z = await w.pack(big);
  ok(z.startsWith(w.MARK) && (await w.unpack(z)) === big, `round trip (${Math.round((z.length / big.length) * 100)}% of ${big.length} bytes)`);
  const stream = w.MARK + w.b64js(new Uint8Array(await new Response(new Blob([new TextEncoder().encode(big)]).stream().pipeThrough(new CompressionStream("deflate-raw") as any)).arrayBuffer()));
  ok((await w.unpack(stream)) === big, "a value written by the web stream (Edge) inflates with zlib");
  const zlib = await import("zlib");
  const bomb = w.MARK + zlib.deflateRawSync(Buffer.alloc(20 * 1024 * 1024, 32)).toString("base64");
  ok((await w.unpack(bomb)) === bomb, `a value that would inflate past 4MB is left as it is (${bomb.length} bytes stored)`);

  // 3. list counters jump on a reset: a cache holding the same counter value is not fooled
  const { listCached } = await import("../src/lib/lcache");
  type Row = { id: string };
  for (let i = 0; i < 5; i++) await R.lpush("t:l", { id: `a${i}` });
  await R.set("t:l:seq", 5);
  const id = (x: Row) => x.id;
  ok((await listCached<Row>("t:l", "t:l:seq", 100, id)).length === 5, "first read");
  await R.del("t:l");
  await R.lpush("t:l", { id: "b0" });
  await R.incrby("t:l:seq", 1_000_000);
  const after = await listCached<Row>("t:l", "t:l:seq", 100, id);
  ok(after.length === 1 && after[0].id === "b0", "after a reset (counter + 1,000,000) the list is read whole");

  // 4. nano: the history flag goes in raw; a model trained on history alone no longer pushes live coins to BOND
  const nano = await import("../src/lib/nano");
  const H = nano.NANO_FEATURES.findIndex((f: any) => f.key === "hist");
  const m = nano.emptyModel();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const xOf = (hist: number) => nano.NANO_FEATURES.map((_, i) => (i === 0 ? 1 : i === H ? hist : rnd() * 2 - 1));
  for (let i = 0; i < 2000; i++) {
    const x = xOf(1);
    nano.learn(m, x, rnd() < 0.08 + 0.1 * Math.max(0, x[1]));
  }
  let gap = 0;
  for (let i = 0; i < 200; i++) {
    const x = xOf(0);
    const x1 = x.slice();
    x1[H] = 1;
    gap = Math.max(gap, Math.abs(nano.nanoScore(m, x) - nano.nanoScore(m, x1)));
  }
  ok(gap < 15, `after 2,000 history lessons a live coin and the same coin from history score within ${gap.toFixed(1)} points`);
  ok((m.nl || 0) === 0 && !nano.nanoReady(m) && m.n === 2000, "2,000 history lessons, 0 live: nano does not make calls yet");
  for (let i = 0; i < nano.NANO_MIN; i++) nano.learn(m, xOf(0), rnd() < 0.1);
  ok(nano.nanoReady(m) && m.nl === nano.NANO_MIN, `${nano.NANO_MIN} live lessons: nano calls`);

  // 5. CATCH: a live input far outside what history showed is capped at 5 deviations
  const ct = await import("../src/lib/catcher");
  const D = ct.CT_FEATURES.length;
  const model: any = { w: new Array(D).fill(0), mu: new Array(D).fill(0), m2: new Array(D).fill(5000 * 1e-6), n: 5000, pos: 100, ver: 2 };
  const iRt = ct.CT_FEATURES.indexOf("rt_live" as any);
  model.w[iRt] = 1;
  const x = new Array(D).fill(0);
  x[0] = 1;
  x[iRt] = 1;
  const p = ct.predict(model, x);
  ok(p > 0.99 && p < 0.9934, `an input history never varied counts at most 5 deviations (p ${p.toFixed(4)}, was 1.0000)`);

  // 6. the memory rate limiter
  const http = await import("../src/lib/http");
  let allowed = 0;
  for (let i = 0; i < 40; i++) if (http.memLimit("t:ip", 30, 60)) allowed++;
  ok(allowed === 30, "30 requests a minute per address on routes that take a coin");

  // 7. prices: one value, read once per 4s per server instance, wishes noted once per 25s per coin
  const pc = await import("../src/lib/pxcache");
  const { memoDrop } = await import("../src/lib/memo");
  await pc.refreshPxCache(async () => ({}), Date.now());
  let zadds = 0;
  const orig = R.zadd.bind(R);
  (R as any).zadd = (...a: any[]) => (zadds++, orig(...a));
  const t0 = Date.now();
  await pc.readPxCache(["M1", "M2"], t0);
  await pc.readPxCache(["M1", "M2"], t0 + 1000);
  ok(zadds === 1, "a coin's wish is written once, not on every poll");
  await R.zadd(pc.PXWANT, { score: Date.now(), member: "M1" });
  await pc.refreshPxCache(async (ms) => Object.fromEntries(ms.map((x) => [x, { px: 1e-8, grad: false }])), Date.now());
  memoDrop("pxall");
  const got = await pc.readPxCache(["M1"], Date.now());
  ok(got.M1?.px === 1e-8 && !!(await R.get(pc.PXALL)), "the worker writes the whole cache as one value and pages read it");

  // 8. HOUND: a webhook deleted on Helius is recreated (it used to report "done" and stay gone)
  const hound = await import("../src/lib/hound");
  await R.hset("rn:hd:w", { W1: { w: "W1", cls: "kol", name: "k", conf: "confirmed", proof: [], src: [], at: 1 } });
  await R.set(hound.HOOK, { id: "old-deleted", n: 1, at: 1 });
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (u: string, o: any) => {
    calls.push(`${o?.method} ${String(u).replace(/\?.*/, "")}`);
    if (o?.method === "PUT") return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ webhookID: "new-id" }), { status: 200 });
  };
  const res = await hound.syncHook(true);
  (globalThis as any).fetch = realFetch;
  const saved = await R.get<any>(hound.HOOK);
  ok(calls.join() === "PUT https://api.helius.xyz/v0/webhooks/old-deleted,POST https://api.helius.xyz/v0/webhooks" && saved?.id === "new-id" && /wallets live/.test(String(res.hook)), "PUT 404 -> a new webhook is created and remembered");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.41 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
