// v0.1.64: Redis on Railway. Real redis-server processes, the real Upstash client, the real compression layer.
//   1. "Upstash" = a redis-server behind our REST service (the same protocol Upstash speaks)
//   2. the worker's one-time move copies it into the "Railway" redis-server
//   3. the worker answers the Upstash client in-process from Railway's Redis; the site through the REST service
// Run: npx tsx sim/v064test.ts (needs redis-server on the PATH)
import { spawn, type ChildProcess } from "node:child_process";
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const kids: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function server(port: number) {
  const p = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  kids.push(p);
  return p;
}
function rest(port: number, redisPort: number, token: string) {
  const p = spawn("node_modules/.bin/tsx", ["rest/index.ts"], { env: { ...process.env, PORT: String(port), REDIS_URL: `redis://127.0.0.1:${redisPort}`, REST_TOKEN: token }, stdio: "ignore" });
  kids.push(p);
  return p;
}
async function waitHttp(url: string) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

(async () => {
  const TOK = "t".repeat(40);
  server(6390); // the old database ("Upstash")
  server(6391); // Railway's Redis
  rest(7790, 6390, TOK); // Upstash's REST, played by our service
  rest(7791, 6391, TOK); // the redis-rest service the site talks to
  await sleep(500);
  ok(await waitHttp("http://127.0.0.1:7790/healthz"), "REST service up (old database)");
  ok(await waitHttp("http://127.0.0.1:7791/healthz"), "REST service up (Railway)");

  // ---- fill the old database through the real client and compression layer, as the live site does
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:7790";
  process.env.UPSTASH_REDIS_REST_TOKEN = TOK;
  const { redis, redisHost } = await import("../src/lib/redis");
  const r = redis();
  const big = { trades: Array.from({ length: 400 }, (_, i) => ({ i, mint: "So1111111111111111111111111111111111111112", sol: i / 7 })) };
  await r.set("rn:desk:state", { cash: 0.62, live: false });
  await r.set("rn:desk:big", big);
  await r.set("rn:ttl", "x", { ex: 5000 });
  await r.set("rn:lock:desk", "someone", { px: 60_000 });
  await r.hset("rn:desk:pos", { A: { mint: "A", px: 1.5 }, B: { mint: "B", series: big.trades } });
  await r.lpush("rn:desk:ev", { agent: "KING", text: "a" }, { agent: "PM", text: "b" });
  await r.sadd("rn:set", "a", "b", "c");
  await r.zadd("rn:due", { score: 1, member: "m1" }, { score: 2.5, member: "m2" });
  const many: Record<string, number> = {};
  for (let i = 0; i < 5000; i++) many[`f${i}`] = i;
  await r.hset("rn:pools", many); // big: copied in chunks
  await r.rpush("rn:biglist", ...Array.from({ length: 4500 }, (_, i) => `v${i}`));
  ok(redisHost() === "railway", "a non-upstash.io URL counts as self-hosted (the site after the switch)");

  // ---- the move
  const { connectRedis, installLocal, answer } = await import("../src/lib/redisrest");
  const { moveFromUpstash, upstashRaw, MOVED_KEY } = await import("../src/lib/redismove");
  const dest = (await connectRedis("redis://127.0.0.1:6391"))!;
  const src = (await connectRedis("redis://127.0.0.1:6390"))!;
  ok(!!dest && !!src, "ioredis connects (family 0)");
  ok((await connectRedis("redis://127.0.0.1:6399", 1500)) === null, "an unreachable Redis returns null in time (the worker stays on Upstash)");
  const logs: string[] = [];
  const res: any = await moveFromUpstash(dest, upstashRaw("http://127.0.0.1:7790", TOK), (s) => logs.push(s));
  ok(res.keys >= 10 && res.fails === 0, `move: ${res.keys} keys, ${res.members} values, ${res.fails} failed in ${res.ms}ms`);
  // every copied key holds the same data in both databases (compared by content: hash and set encodings may differ)
  const keys = (await src.keys("*")).filter((k) => !k.startsWith("rn:lock:") && k !== "rn:worker:at" && k !== "rn:moved" && !k.startsWith("rn:bw"));
  const content = async (c: any, k: string) => {
    const t = await c.type(k);
    if (t === "string") return await c.get(k);
    if (t === "hash") return JSON.stringify(Object.entries(await c.hgetall(k)).sort());
    if (t === "list") return JSON.stringify(await c.lrange(k, 0, -1));
    if (t === "set") return JSON.stringify((await c.smembers(k)).sort());
    if (t === "zset") return JSON.stringify(await c.zrange(k, 0, -1, "WITHSCORES"));
    return t;
  };
  let same = 0;
  for (const k of keys) {
    if ((await content(src, k)) === (await content(dest, k))) same++;
    else console.log("  differs:", k);
  }
  ok(same === keys.length, `every key identical after the move (${same}/${keys.length}), compressed values copied as stored`);
  ok((await dest.pttl("rn:ttl")) > 4_000_000, "expiry carried over");
  ok(!(await dest.exists("rn:lock:desk")), "locks are not copied");
  ok((await dest.hlen("rn:pools")) === 5000 && (await dest.llen("rn:biglist")) === 4500, "big hash and list copied in chunks");
  ok(Number(await src.get("rn:worker:at")) > Date.now() + 20 * 86400_000, "old database: worker heartbeat set 30 days ahead (the Vercel ping never takes over there)");
  ok(!!(await dest.get(MOVED_KEY)), "move marked done");
  const again: any = await moveFromUpstash(dest, upstashRaw("http://127.0.0.1:7790", TOK));
  ok(again.skipped === "already moved", "a restart never copies twice");

  // ---- the worker: the Upstash client answered in-process from Railway's Redis
  installLocal(dest);
  const w = redis();
  ok(w !== r && redisHost() === "railway", "the client switches to the local transport");
  const { bwLevel, bwLimited, _bwSet } = await import("../src/lib/bwgov");
  _bwSet(9e9, Date.now(), 9e9);
  ok(!bwLimited() && bwLevel() === 0, "no saving mode on Railway's Redis, whatever the byte count");
  const battery = async (c: any, label: string) => {
    let n = 0, good = 0;
    const t = (cond: boolean, m: string) => {
      n++;
      if (cond) good++;
      else console.log(`  ${label} FAIL ${m}`);
    };
    t(((await c.get("rn:desk:state")) as any)?.cash === 0.62, "get object");
    t(((await c.get("rn:desk:big")) as any)?.trades?.length === 400, "get compressed value");
    const pos: any = await c.hgetall("rn:desk:pos");
    t(pos?.A?.px === 1.5 && pos?.B?.series?.length === 400, "hgetall (compressed field)");
    if (!(pos?.A?.px === 1.5 && pos?.B?.series?.length === 400)) console.log("   got", JSON.stringify(pos).slice(0, 300));
    t((await c.hmget("rn:desk:pos", "A", "Z"))?.Z === null, "hmget missing field");
    t(((await c.lrange("rn:desk:ev", 0, -1)) as any[])[0]?.text === "b", "lrange");
    t((await c.zrange("rn:due", 0, -1, { withScores: true })).length === 4, "zrange withScores");
    t(JSON.stringify(await c.zrange("rn:due", 2, 3, { byScore: true })) === '["m2"]', "zrange byScore");
    t((await c.zscore("rn:due", "m2")) === 2.5, "zscore");
    t(JSON.stringify(await c.zmscore("rn:due", ["m1", "x"])) === "[1,null]", "zmscore");
    t((await c.incr(`rn:t:${label}`)) === 1 && (await c.incrby(`rn:t:${label}`, 4)) === 5, "incr/incrby");
    t((await c.hincrbyfloat(`rn:h:${label}`, "x", 1.5)) === 1.5, "hincrbyfloat");
    t((await c.set(`rn:nx:${label}`, "1", { nx: true, ex: 30 })) === "OK" && (await c.set(`rn:nx:${label}`, "2", { nx: true, ex: 30 })) === null, "set nx ex");
    t((await c.get("rn:nothing")) === null, "missing key is null");
    t((await c.exists("rn:desk:state")) === 1 && (await c.del(`rn:t:${label}`)) === 1, "exists/del");
    t(JSON.stringify(await c.smismember("rn:set", ["a", "z"])) === "[1,0]", "smismember");
    t((await c.scard("rn:set")) === 3, "scard");
    const [sc, sk] = await c.scan(0, { match: "rn:desk:*", count: 1000 });
    t(sc !== undefined && Array.isArray(sk) && sk.includes("rn:desk:state"), "scan");
    t((await c.ltrim("rn:desk:ev", 0, 0)) === "OK" && (await c.llen("rn:desk:ev")) === 1, "ltrim/llen");
    t((await c.zremrangebyscore("rn:due", 0, 1.5)) === 1 && (await c.zcard("rn:due")) === 1, "zremrangebyscore/zcard");
    await c.zadd("rn:due", { score: 1, member: "m1" });
    await c.lpush("rn:desk:ev", { agent: "PM", text: "b" });
    const [cur, fields] = await c.hscan("rn:pools", 0, { count: 100 });
    t(fields.length > 0 && cur !== undefined, "hscan");
    const p = c.pipeline();
    p.set(`rn:p:${label}`, { a: 1 });
    p.get(`rn:p:${label}`);
    p.hincrby(`rn:ph:${label}`, "n", 2);
    p.zadd(`rn:pz:${label}`, { score: 3, member: "q" });
    const out = await p.exec();
    t((out[1] as any)?.a === 1 && out[2] === 2 && out[3] === 1, "pipeline");
    const m = c.multi();
    m.incr(`rn:m:${label}`);
    m.incr(`rn:m:${label}`);
    t(JSON.stringify(await m.exec()) === "[1,2]", "multi");
    t(JSON.stringify(await c.pipeline().exec()) === "[]", "empty pipeline is a no-op");
    // the desk lock's Lua (lib/lock.ts)
    await c.set(`rn:lk:${label}`, "tok", { px: 10_000 });
    t((await c.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end", [`rn:lk:${label}`], ["tok", "20000"])) === 1, "eval (lock renew)");
    let threw = false;
    try {
      await c.hgetall("rn:desk:state"); // WRONGTYPE
    } catch {
      threw = true;
    }
    t(threw, "a Redis error throws, as with Upstash");
    const many2: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) many2[`k${i}`] = { i, big: big.trades.slice(0, 20) };
    await c.hset(`rn:hb:${label}`, many2);
    t(((await c.hget(`rn:hb:${label}`, "k199")) as any)?.i === 199, "hset of 200 compressed fields");
    return { n, good };
  };
  const a = await battery(w, "worker");
  ok(a.good === a.n, `worker, in-process: ${a.good}/${a.n} client operations behave as on Upstash`);

  // the site: the same redis() on Vercel, its URL switched to the redis-rest service (Railway)
  const g = globalThis as any;
  const localFn = g.__rnLocalRedis;
  delete g.__rnLocalRedis;
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:7791";
  const site = redis();
  ok(site !== w, "the site's client talks HTTP to the REST service");
  const s = await battery(site, "site");
  ok(s.good === s.n, `site, over the REST service: ${s.good}/${s.n} client operations behave as on Upstash`);
  const bad = await fetch("http://127.0.0.1:7791/", { method: "POST", headers: { authorization: "Bearer nope" }, body: '["GET","rn:desk:state"]' });
  ok(bad.status === 401, "wrong token refused");
  const notJson = await answer(dest, "/", "{x");
  ok(notJson.status === 400, "bad body answered with an error, not a crash");
  const both = await dest.get("rn:p:site");
  ok(JSON.parse(String(both))?.a === 1, "worker and site see the same database");

  // speed: in-process answers vs an HTTP round trip
  const siteC = redis();
  g.__rnLocalRedis = localFn;
  const wl = redis();
  let t0 = Date.now();
  for (let i = 0; i < 300; i++) await wl.get("rn:desk:state");
  const local = (Date.now() - t0) / 300;
  t0 = Date.now();
  g.__rnLocalRedis = undefined;
  for (let i = 0; i < 300; i++) await siteC.get("rn:desk:state");
  const http = (Date.now() - t0) / 300;
  ok(local < 5, `worker read: ${local.toFixed(2)}ms each in-process (site over HTTP: ${http.toFixed(2)}ms on this machine)`);

  // ---- wiring
  const fs = await import("fs");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/async function main\(\) \{\n  await setupRedis\(\);/.test(wk), "the worker moves and switches before anything else runs");
  ok(/staying on Upstash/.test(wk), "unreachable Redis or a failed move: the worker stays on Upstash");
  const nc = fs.readFileSync(new URL("../next.config.js", import.meta.url), "utf8");
  ok(/"ioredis"/.test(nc), "ioredis is never bundled into the site");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(pkg.scripts.rest === "tsx rest/index.ts" && !!pkg.dependencies.ioredis, "npm run rest starts the REST service");

  dest.disconnect();
  src.disconnect();
  for (const k of kids) k.kill("SIGKILL");
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log("crash", e);
  for (const k of kids) k.kill("SIGKILL");
  process.exit(1);
});
