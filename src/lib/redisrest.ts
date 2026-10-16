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

// v0.1.100 (audit): server and admin commands are refused. The REST service is reachable over public HTTPS behind its
// token; with the token leaked, CONFIG SET (write files on the Redis host), FLUSHALL or REPLICAOF would have run too.
// The app never sends any of these.
const DENY = new Set(["CONFIG", "MODULE", "FLUSHALL", "FLUSHDB", "DEBUG", "SHUTDOWN", "SAVE", "BGSAVE", "BGREWRITEAOF", "REPLICAOF", "SLAVEOF", "MIGRATE", "ACL", "CLIENT", "FUNCTION", "MONITOR", "SYNC", "PSYNC", "CLUSTER", "FAILOVER", "SWAPDB", "RESTORE", "LATENCY", "MEMORY", "OBJECT"]);
export const refused = (name: string) => DENY.has(String(name).toUpperCase());

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
    if (refused(name)) return { status: 400, body: JSON.stringify({ error: `ERR ${name} is not allowed` }) };
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
    const bad = (parsed as unknown[][]).find((c) => refused(String(c[0])));
    if (bad) return { status: 400, body: JSON.stringify({ error: `ERR ${String(bad[0]).toUpperCase()} is not allowed` }) };
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

/**
 * v0.1.69: connect, and keep trying until Redis answers (backoff 5s, 10s ... 30s). Never gives up: with REDIS_URL set the
 * worker must not run anywhere else. One alert after `alertAfterMs`, one "back" note if it alerted.
 */
export async function connectRedisWait(
  url: string,
  o: { log?: (s: string) => void; onAlert?: (mins: number) => unknown; onBack?: (mins: number) => unknown; alertAfterMs?: number; stepMs?: number; maxMs?: number; timeoutMs?: number } = {},
): Promise<IORedis> {
  const t0 = Date.now();
  const step = o.stepMs ?? 5_000;
  const max = o.maxMs ?? 30_000;
  const alertAfter = o.alertAfterMs ?? 120_000;
  const mins = () => Math.max(1, Math.round((Date.now() - t0) / 60_000));
  let tries = 0;
  let alerted = false;
  let r = await connectRedis(url, o.timeoutMs);
  while (!r) {
    tries++;
    const wait = Math.min(max, step * tries);
    o.log?.(`redis: Railway's Redis is not reachable (try ${tries}, ${Math.round((Date.now() - t0) / 1000)}s): waiting for it, retry in ${Math.round(wait / 1000)}s (never Upstash)`);
    if (!alerted && Date.now() - t0 >= alertAfter) {
      alerted = true;
      await Promise.resolve(o.onAlert?.(mins())).catch(() => null);
    }
    await new Promise((res) => setTimeout(res, wait));
    r = await connectRedis(url, o.timeoutMs);
  }
  if (alerted) await Promise.resolve(o.onBack?.(mins())).catch(() => null);
  return r;
}

export type RedisHealth = { saveOk: boolean; lastOkSave: number | null; saveErr: string | null; usedMb: number | null; peakMb: number | null; aof: boolean; healed: boolean; stopWrites: string | null };

const infoField = (txt: string, k: string) => (txt.match(new RegExp(`^${k}:(.*)$`, "m"))?.[1] ?? "").trim();

/**
 * v0.1.70: a failed disk snapshot must never stop the desk. Redis's default (stop-writes-on-bgsave-error yes) refuses
 * every write once one snapshot fails (MISCONF): on 11 and 12 Oct a full volume took every loop down. The worker turns
 * it off (again after each Redis restart, which resets it) and reports the snapshot state, so a failing disk is an alert,
 * not an outage.
 */
export async function redisGuard(r: IORedis): Promise<RedisHealth> {
  let healed = false;
  let stopWrites: string | null = null;
  try {
    const cfg = (await r.call("CONFIG", "GET", "stop-writes-on-bgsave-error")) as string[];
    stopWrites = cfg?.[1] ?? null;
    if (stopWrites === "yes") {
      await r.call("CONFIG", "SET", "stop-writes-on-bgsave-error", "no");
      healed = true;
    }
  } catch {
    // CONFIG disabled on this Redis: the snapshot state below still tells why writes fail
  }
  const pers = String(await r.call("INFO", "persistence").catch(() => ""));
  const mem = String(await r.call("INFO", "memory").catch(() => ""));
  const st = infoField(pers, "rdb_last_bgsave_status");
  const lastSave = Number(infoField(pers, "rdb_last_save_time")) || 0;
  const mb = (k: string) => {
    const v = Number(infoField(mem, k));
    return v ? Math.round(v / 1048576) : null;
  };
  return {
    saveOk: st !== "err",
    lastOkSave: lastSave ? lastSave * 1000 : null,
    saveErr: st === "err" ? "the last snapshot to disk failed (full volume, or not enough memory to fork)" : null,
    usedMb: mb("used_memory"),
    peakMb: mb("used_memory_peak"),
    aof: infoField(pers, "aof_enabled") === "1",
    healed,
    stopWrites,
  };
}

export const LOCAL_BASE = "http://rn-local-redis";

/** Worker: answer the Upstash client in this process, straight from Redis (the wire layer hands the calls over). */
export function installLocal(r: IORedis) {
  const g = globalThis as any;
  g.__rnLocalRedis = (url: string, body: string) => answer(r, url.slice(LOCAL_BASE.length) || "/", body);
  g.__rnLocalClient = r;
}
