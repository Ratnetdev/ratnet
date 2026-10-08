// v0.1.40: the Redis wire layer (compression, inflate, byte counts), the bandwidth governor and the incremental list
// cache, against the real @upstash/redis client talking to a small Upstash-compatible REST server.
// Run: npx tsx sim/v040test.ts
import http from "http";

let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};

// ---------- a tiny Upstash REST server (plain JSON answers, values stored exactly as sent)
const kv = new Map<string, any>();
const stats = { cmds: [] as string[], bytesIn: 0, bytesOut: 0 };
const str = (v: any) => (v == null ? null : String(v));
function run(cmd: any[]): any {
  const [c0, k, ...a] = cmd;
  const c = String(c0).toLowerCase();
  stats.cmds.push(`${c} ${k}`);
  const list = () => (kv.get(k) as string[]) || (kv.set(k, []), kv.get(k));
  const hash = () => (kv.get(k) as Record<string, string>) || (kv.set(k, {}), kv.get(k));
  const zset = () => (kv.get(k) as Map<string, number>) || (kv.set(k, new Map()), kv.get(k));
  switch (c) {
    case "get": return str(kv.get(k));
    case "set": kv.set(k, String(a[0])); return "OK";
    case "del": { let n = 0; for (const x of [k, ...a]) if (kv.delete(x)) n++; return n; }
    case "incr": kv.set(k, String(Number(kv.get(k) || 0) + 1)); return Number(kv.get(k));
    case "incrby": kv.set(k, String(Number(kv.get(k) || 0) + Number(a[0]))); return Number(kv.get(k));
    case "expire": return 1;
    case "mget": return [k, ...a].map((x) => str(kv.get(x)));
    case "hset": { const h = hash(); for (let i = 0; i < a.length; i += 2) h[a[i]] = String(a[i + 1]); return a.length / 2; }
    case "hincrby": { const h = hash(); h[a[0]] = String(Number(h[a[0]] || 0) + Number(a[1])); return Number(h[a[0]]); }
    case "hgetall": { const h = kv.get(k) || {}; return Object.entries(h).flatMap(([f, v]) => [f, v]); }
    case "hmget": { const h = kv.get(k) || {}; return a.map((f: string) => h[f] ?? null); }
    case "lpush": { const l = list(); for (const v of a) l.unshift(String(v)); return l.length; }
    case "rpush": { const l = list(); for (const v of a) l.push(String(v)); return l.length; }
    case "ltrim": { const l = list(); const s = Number(a[0]); const e0 = Number(a[1]); const e = e0 < 0 ? l.length + e0 : e0; kv.set(k, l.slice(s, e + 1)); return "OK"; }
    case "lrange": { const l = (kv.get(k) as string[]) || []; const s = Number(a[0]); const e0 = Number(a[1]); const e = e0 < 0 ? l.length + e0 : e0; return l.slice(s, e + 1); }
    case "zadd": { const z = zset(); for (let i = 0; i < a.length; i += 2) z.set(String(a[i + 1]), Number(a[i])); return 1; }
    case "zrange": return [...zset().entries()].sort((x, y) => x[1] - y[1]).map(([m]) => m);
    default: throw new Error(`unknown command ${c}`);
  }
}
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    stats.bytesIn += body.length;
    let out: any;
    try {
      const j = JSON.parse(body);
      if (/\/(pipeline|multi-exec)/.test(req.url || "")) out = (j as any[][]).map((c) => ({ result: run(c) }));
      else out = { result: run(j) };
    } catch (e: any) {
      out = { error: String(e?.message || e) };
    }
    const txt = JSON.stringify(out);
    stats.bytesOut += txt.length;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(txt);
  });
});

(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  process.env.KV_REST_API_URL = `http://127.0.0.1:${port}`;
  process.env.KV_REST_API_TOKEN = "test";
  const { redis } = await import("../src/lib/redis");
  const { MARK, wireTotals } = await import("../src/lib/rediswire");
  const r = redis();

  // a realistic big value: a launch record with a tape and a call
  const big = {
    mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", symbol: "RAT", name: "Rat Net", createdAt: 1, p0: 3.1,
    tape: { uniq: 41, organic: 33, insiders: Array.from({ length: 20 }, (_, i) => ({ acc: `Acc${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, role: "early", base: 1234567 + i })) },
    call: { score: 74, verdict: "BOND", x: Array.from({ length: 60 }, (_, i) => Math.round(Math.sin(i) * 1e6) / 1e6), parts: Array.from({ length: 20 }, (_, i) => ({ f: `feature ${i}`, v: i * 1.5 })) },
  };
  const raw = JSON.stringify(big);

  // 1. set / get
  await r.set("t:big", big);
  const stored = String(kv.get("t:big"));
  ok(stored.startsWith(MARK), "a large value is stored compressed");
  ok(stored.length < raw.length / 2, `compressed to ${Math.round((stored.length / raw.length) * 100)}% of ${raw.length} bytes`);
  const back = await r.get<any>("t:big");
  ok(JSON.stringify(back) === raw, "get returns the original object");
  await r.set("t:small", { a: 1 });
  ok(!String(kv.get("t:small")).startsWith(MARK), "a small value is stored as is");
  ok((await r.get<any>("t:small"))?.a === 1, "and read back");
  await r.set("t:ex", big, { ex: 60 });
  ok(String(kv.get("t:ex")).startsWith(MARK) && JSON.stringify(await r.get("t:ex")) === raw, "set with options compresses the value, not the options");

  // 2. hashes: fields never compressed, values compressed when large
  const longField = "F".repeat(1500);
  await r.hset("t:h", { big, small: { b: 2 }, [longField]: 1 });
  const h = kv.get("t:h");
  ok(String(h.big).startsWith(MARK) && !String(h.small).startsWith(MARK), "hset compresses only the large field values");
  ok(longField in h, "a long field name is never compressed");
  const hg = await r.hgetall<Record<string, any>>("t:h");
  ok(JSON.stringify(hg?.big) === raw && hg?.small?.b === 2, "hgetall inflates the values");
  const hm = await r.hmget<Record<string, any>>("t:h", "big", "small");
  ok(JSON.stringify(hm?.big) === raw && hm?.small?.b === 2, "hmget inflates the values");

  // 3. lists
  await r.lpush("t:l", big, { s: 1 }, big);
  const lr = await r.lrange<any>("t:l", 0, -1);
  ok(lr.length === 3 && JSON.stringify(lr[0]) === raw && lr[1].s === 1 && JSON.stringify(lr[2]) === raw, "lpush and lrange round trip, order kept");

  // 4. old uncompressed values stay readable, mixed with new ones
  kv.set("t:old", raw);
  const mg = await r.mget<any[]>("t:old", "t:big", "t:small", "t:none");
  ok(JSON.stringify(mg[0]) === raw && JSON.stringify(mg[1]) === raw && mg[2].a === 1 && mg[3] === null, "mget mixes old plain values, compressed values and missing keys");

  // 5. sorted-set members are never touched
  const longMember = "M".repeat(2000);
  await r.zadd("t:z", { score: 1, member: longMember });
  ok(kv.get("t:z").has(longMember), "a long sorted-set member is stored as is");

  // 6. pipelines and transactions
  const p = r.pipeline();
  p.set("t:p1", big);
  p.get("t:p1");
  p.hgetall("t:h");
  p.lrange("t:l", 0, 0);
  p.incr("t:n");
  const pr = (await p.exec()) as any[];
  ok(pr[0] === "OK" && JSON.stringify(pr[1]) === raw && JSON.stringify(pr[2].big) === raw && JSON.stringify(pr[3][0]) === raw && pr[4] === 1, "pipeline: writes compressed, every answer inflated in place");
  const m = r.multi();
  m.lrange("t:l", 0, 1);
  m.ltrim("t:l", 2, -1);
  const mr = (await m.exec()) as any[];
  ok(JSON.stringify(mr[0][0]) === raw && mr[0][1].s === 1 && (kv.get("t:l") as string[]).length === 1, "multi-exec: inflated too");
  ok(((await r.pipeline().exec()) as any[]).length === 0, "an empty pipeline is still a no-op");

  // base64 without Buffer (the Edge runtime) matches Buffer's
  const { b64js, unb64js } = await import("../src/lib/rediswire");
  const bytes = new Uint8Array(Array.from({ length: 1000 }, (_, i) => (i * 37) % 256));
  ok([0, 1, 2, 3, 999, 1000].every((n) => b64js(bytes.subarray(0, n)) === Buffer.from(bytes.subarray(0, n)).toString("base64") && Buffer.from(unb64js(b64js(bytes.subarray(0, n)))).equals(Buffer.from(bytes.subarray(0, n)))), "the Edge base64 path matches Node's");

  // 7. byte counts
  ok(wireTotals.tx > 0 && wireTotals.rx > 0 && wireTotals.saved > 0, `wire bytes counted (${wireTotals.tx} sent, ${wireTotals.rx} received, ${wireTotals.saved} saved by compression)`);
  ok(Math.abs(wireTotals.tx - stats.bytesIn) < 50, "counted bytes sent match what the server received");

  // 8. governor: the shared day counter and the levels
  const gov = await import("../src/lib/bwgov");
  gov.bwCount(5000);
  const total = await gov.bwFlush();
  const dk = gov.bwDayKey();
  ok(Number(kv.get(dk)) === total && total > 5000, `bytes flushed to ${dk} (${total})`);
  const noon = Date.UTC(2026, 9, 8, 12, 0, 0);
  const pace = gov.paceNow(noon);
  ok(Math.abs(pace - 2.8e9 * 0.56) < 1e6, `pace at noon UTC is 56% of the 2.8GB day (${Math.round(pace / 1e6)}MB)`);
  gov._bwSet(pace * 0.9, noon);
  ok(gov.bwLevel(noon) === 0, "under pace: normal");
  gov._bwSet(pace * 1.1, noon);
  ok(gov.bwLevel(noon) === 1, "over pace: saving mode 1");
  gov._bwSet(pace * 1.6, noon);
  ok(gov.bwLevel(noon) === 2, "1.5x pace: saving mode 2");
  ok(gov.bwLevel(noon + 6 * 60_000) === 0, "a stale reading (no flush for 5 minutes) never throttles");
  // v0.1.49: pinned to noon UTC today. The pace reaches the whole day's allowance by ~22:00 UTC, so after that no
  // saving mode 1 exists and this check failed at night
  const realNow = Date.now;
  const d0 = new Date();
  const noonT = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate(), 12, 0, 0);
  Date.now = () => noonT;
  gov._bwSet(gov.paceNow(noonT) * 1.1, noonT);
  ok(gov.bwMul() === 3, "saving mode 1 stretches caches 3x");
  const { memo } = await import("../src/lib/memo");
  let loads = 0;
  const load = async () => ++loads;
  await memo("t:memo", 1_000, load);
  Date.now = () => noonT + 2_000; // past the 1s TTL, inside 3x
  await memo("t:memo", 1_000, load);
  ok(loads === 1, "memo holds 3x longer in saving mode 1");
  Date.now = realNow;
  gov._bwSet(0);
  ok(gov.bwMul() === 1, "back to normal");

  // 9. incremental list cache
  const { listCached } = await import("../src/lib/lcache");
  type Row = { id: string; n: number; pad: string };
  const row = (i: number): Row => ({ id: `r${i}`, n: i, pad: "x".repeat(400) });
  for (let i = 0; i < 50; i++) await r.lpush("t:trades", row(i));
  await r.set("t:trades:seq", 50);
  const idOf = (x: Row) => x.id;
  const a1 = await listCached<Row>("t:trades", "t:trades:seq", 2000, idOf);
  ok(a1.length === 50 && a1[0].id === "r49", "first read: the whole list");
  stats.cmds = [];
  const a2 = await listCached<Row>("t:trades", "t:trades:seq", 2000, idOf);
  ok(a2.length === 50 && !stats.cmds.some((c) => c.startsWith("lrange")), "unchanged: only the counter is read");
  await r.lpush("t:trades", row(50), row(51));
  await r.incrby("t:trades:seq", 2);
  stats.cmds = [];
  const a3 = await listCached<Row>("t:trades", "t:trades:seq", 2000, idOf);
  ok(a3.length === 52 && a3[0].id === "r51" && a3[1].id === "r50" && a3[2].id === "r49", "two new rows merged at the head, in order");
  ok(stats.cmds.filter((c) => c.startsWith("lrange")).length === 1, "with one small read of the head");
  // a writer pushed but has not bumped the counter yet: the next bump picks it up exactly once
  await r.lpush("t:trades", row(52));
  const a4 = await listCached<Row>("t:trades", "t:trades:seq", 2000, idOf);
  ok(a4.length === 52, "rows pushed before their counter bump wait for it");
  await r.lpush("t:trades", row(53));
  await r.incrby("t:trades:seq", 2);
  const a5 = await listCached<Row>("t:trades", "t:trades:seq", 2000, idOf);
  ok(a5.length === 54 && new Set(a5.map((x) => x.id)).size === 54 && a5[0].id === "r53", "no row lost or doubled");
  // a reset deletes the list and its counter: a full read follows
  await r.del("t:trades", "t:trades:seq");
  await r.lpush("t:trades", row(100));
  const a6 = await listCached<Row>("t:trades", "t:trades:seq", 2000, idOf);
  ok(a6.length === 1 && a6[0].id === "r100", "after a reset the list is read whole again");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.40 checks passed");
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
