// Fake Upstash REST endpoint backed by a dumped simulation state, so the real Next app can render it.
import http from "http";
import fs from "fs";

const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const kv = new Map<string, any>();
for (const [k, v] of Object.entries<any>(raw)) kv.set(k, v && v.__z ? new Map(v.__z) : v);
const ser = (v: any) => (v == null ? null : typeof v === "string" ? v : JSON.stringify(v));
const b64 = (x: any): any => (x == null ? null : Array.isArray(x) ? x.map(b64) : typeof x === "number" ? x : Buffer.from(String(x)).toString("base64"));
const zsorted = (k: string) => [...((kv.get(k) as Map<string, number>) || new Map()).entries()].sort((a, b) => a[1] - b[1]);

function run(cmd: any[]): any {
  const [c0, k, ...a] = cmd;
  const c = String(c0).toLowerCase();
  switch (c) {
    case "ping": return "PONG";
    case "get": return ser(kv.get(k));
    case "mget": return [k, ...a].map((x: string) => ser(kv.get(x)));
    case "hgetall": { const h = kv.get(k); if (!h) return []; return Object.entries(h).flatMap(([f, v]) => [f, ser(v)]); }
    case "hmget": { const h = kv.get(k) || {}; return a.map((f: string) => ser(h[f])); }
    case "zcard": return kv.get(k)?.size || 0;
    case "zscore": { const z = kv.get(k); return z?.has(a[0]) ? String(z.get(a[0])) : null; }
    case "zmscore": { const z = kv.get(k); return a.map((m: string) => (z?.has(m) ? String(z.get(m)) : null)); }
    case "zrange": {
      const up = a.map((x: any) => String(x).toUpperCase());
      let arr = zsorted(k);
      const ws = up.includes("WITHSCORES");
      if (up.includes("BYSCORE")) {
        const lo = Number(a[0]), hi = Number(a[1]);
        arr = arr.filter(([, s]) => s >= lo && s <= hi);
        const li = up.indexOf("LIMIT");
        if (li >= 0) arr = arr.slice(Number(a[li + 1]), Number(a[li + 1]) + Number(a[li + 2]));
      } else {
        if (up.includes("REV")) arr.reverse();
        const s = Number(a[0]), e0 = Number(a[1]);
        const e = e0 < 0 ? arr.length + e0 : e0;
        arr = arr.slice(s, e + 1);
      }
      return ws ? arr.flatMap(([m, s]) => [m, String(s)]) : arr.map(([m]) => m);
    }
    case "lrange": { const l = kv.get(k) || []; const s = Number(a[0]); const e0 = Number(a[1]); const e = e0 < 0 ? l.length + e0 : e0; return l.slice(s, e + 1).map(ser); }
    case "smembers": return kv.get(k) || [];
    case "sismember": return (kv.get(k) || []).includes(a[0]) ? 1 : 0;
    case "set": case "del": case "incr": case "incrby": case "expire": case "hincrby": case "zadd": case "zrem": case "lpush": case "ltrim": case "rpush": case "sadd": case "hset":
      return c === "set" ? "OK" : 1; // read-only replay: writes are accepted and ignored
    default: return null;
  }
}

http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const j = JSON.parse(body || "[]");
    const enc = req.headers["upstash-encoding"] === "base64";
    const wrap = (r: any) => ({ result: enc ? b64(r) : r });
    const out = req.url?.startsWith("/pipeline") || req.url?.startsWith("/multi-exec") ? j.map((cmd: any[]) => wrap(run(cmd))) : wrap(run(j));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  });
}).listen(8079, () => console.log("fake upstash on 8079"));
