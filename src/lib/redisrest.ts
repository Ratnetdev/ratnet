// v0.1.64: Redis on Railway. Upstash bills every byte on the wire and its plan's daily share kept running out (saving
// modes that slowed learning and the boards, 3.8GB on 9 Oct against 2.8GB). Railway's Redis on the private network has
// no per-byte bill and answers in about a millisecond instead of a round trip to Upstash.
//
// The code keeps the Upstash client (every call site, the compression layer and the meter stay as they are). This
// module answers Upstash's REST protocol from any Redis:
//   POST /            ["SET","k","v"]        -> {"result": ...} or 400 {"error": "..."}
//   POST /pipeline    [["GET","a"],[...]]    -> [{"result": ...}, {"error": ...}]
//   POST /multi-exec  [[...],[...]]          -> the same, as one transaction
// It runs in two places: inside the worker (no HTTP at all, straight to Redis on the private network) and as the small
// "redis-rest" service the site (Vercel) talks to over HTTPS. Worker only: never bundled into the site.
import type { Redis as IORedis } from "ioredis";

export type RestAnswer = { status: number; body: string };

// the command name upper-cased: ioredis reshapes some replies by their lower-case name (HGETALL into an object), and
// Upstash answers the raw reply (a flat array for HGETALL), which is what the client expects
const toArgs = (cmd: unknown[]) => [String(cmd[0]).toUpperCase(), ...cmd.slice(1)].map((x) => (typeof x === "string" ? x : x == null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x)));
const errOf = (e: unknown) => String((e as any)?.message || e || "error").replace(/^ReplyError: /, "");

function isCmd(x: unknown): x is unknown[] {
  return Array.isArray(x) && x.length > 0 && typeof x[0] === "string";
}

/** Answer one Upstash REST request (path: "/", "/pipeline" or "/multi-exec"; body: the JSON text). */
export async function answer(r: IORedis, path: string, body: string): Promise<RestAnswer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body || "null");
  } catch {
    return { status: 400, body: JSON.stringify({ error: "ERR body is not JSON" }) };
  }
  const p = path.replace(/\?.*$/, "").replace(/\/+$/, "") || "/";
  if (p === "/" || p === "") {
    if (!isCmd(parsed)) return { status: 400, body: JSON.stringify({ error: "ERR expected a command array" }) };
    const [name, ...args] = toArgs(parsed);
    try {
      const result = await r.call(name, ...args);
      return { status: 200, body: JSON.stringify({ result: norm(result) }) };
    } catch (e) {
      return { status: 400, body: JSON.stringify({ error: errOf(e) }) };
    }
  }
  if (p.endsWith("/pipeline") || p.endsWith("/multi-exec")) {
    if (!Array.isArray(parsed) || !parsed.every(isCmd)) return { status: 400, body: JSON.stringify({ error: "ERR expected an array of commands" }) };
    if (!parsed.length) return { status: 200, body: "[]" };
    const tx = p.endsWith("/multi-exec");
    const pl = tx ? r.multi() : r.pipeline();
    for (const c of parsed as unknown[][]) {
      const [name, ...args] = toArgs(c);
      (pl as any).call(name, ...args);
    }
    try {
      const res = ((await pl.exec()) || []) as [Error | null, unknown][];
      return { status: 200, body: JSON.stringify(res.map(([e, v]) => (e ? { error: errOf(e) } : { result: norm(v) }))) };
    } catch (e) {
      // a transaction refused as a whole (a syntax error inside MULTI): Upstash answers one error
      return { status: 400, body: JSON.stringify({ error: errOf(e) }) };
    }
  }
  return { status: 404, body: JSON.stringify({ error: "ERR unknown path" }) };
}

// Buffers never reach here (call() answers strings), but a nested reply may hold them: strings out, like Upstash
function norm(v: unknown): unknown {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (Array.isArray(v)) return v.map(norm);
  return v;
}

/** A Redis client for Railway's private network (it resolves over IPv6, so family 0 is required). */
export async function connectRedis(url: string, timeoutMs = 10_000): Promise<IORedis | null> {
  const mod: any = await import("ioredis");
  const Redis = mod.default || mod.Redis || mod;
  const u = new URL(url);
  const r: IORedis = new Redis(url, { family: 0, maxRetriesPerRequest: 2, enableReadyCheck: true, connectTimeout: timeoutMs, lazyConnect: true, ...(u.protocol === "rediss:" ? { tls: {} } : {}) });
  r.on("error", () => {}); // reconnects on its own; errors surface on the commands
  try {
    await Promise.race([r.connect(), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), timeoutMs))]);
    await r.ping();
    return r;
  } catch {
    r.disconnect();
    return null;
  }
}

export const LOCAL_BASE = "http://rn-local-redis";

/** Worker: answer the Upstash client in this process, straight from Redis (the wire layer hands the calls over). */
export function installLocal(r: IORedis) {
  const g = globalThis as any;
  g.__rnLocalRedis = (url: string, body: string) => answer(r, url.slice(LOCAL_BASE.length) || "/", body);
  g.__rnLocalClient = r;
}
