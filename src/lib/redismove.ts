// v0.1.64: the one-time move from Upstash to Railway's Redis, done by the worker on its first start with REDIS_URL set.
// The worker copies every key (values as stored, compressed ones included, with their expiry) before any loop starts,
// so nothing the desk writes can be lost in between. Then it marks the move done in both databases:
//   - Railway: rn:moved:v1 (a restart never copies again)
//   - Upstash: the worker heartbeat set far ahead, so the Vercel minute ping (still on Upstash until its variables are
//     switched) never takes over and runs a second desk on the old database.
// Locks are not copied (a lock from the previous process would only make the new one wait).
import type { Redis as IORedis } from "ioredis";

export const MOVED_KEY = "rn:moved:v1";
type Up = (cmds: unknown[][]) => Promise<{ result?: any; error?: string }[]>;

/** Raw Upstash pipeline: no compression layer (values are copied exactly as stored). */
export function upstashRaw(url: string, token: string): Up {
  const g = globalThis as any;
  const f: typeof fetch = g.__rnWireOrig || fetch;
  const root = url.replace(/\/+$/, "");
  return async (cmds) => {
    if (!cmds.length) return [];
    const res = await f(`${root}/pipeline`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(cmds), signal: AbortSignal.timeout(60_000) } as any);
    const txt = await res.text();
    if (!res.ok) throw new Error(`upstash ${res.status}: ${txt.slice(0, 200)}`);
    return JSON.parse(txt);
  };
}

const SKIP = /^rn:lock:/;
const CHUNK = 2000; // members per read or write for big collections

export async function moveFromUpstash(local: IORedis, up: Up, log: (s: string) => void = console.log) {
  const t0 = Date.now();
  const done = await local.get(MOVED_KEY);
  if (done) return { skipped: "already moved", at: JSON.parse(done)?.at ?? null };
  // keep the Vercel minute ping away from the old database while the copy runs (it steps aside while this is fresh)
  await up([["SET", "rn:worker:at", String(Date.now() + 3600_000)]]).catch(() => null);
  let cursor = "0";
  let keys = 0, skipped = 0, members = 0, fails = 0;
  let lastLog = Date.now();
  do {
    const [scan] = await up([["SCAN", cursor, "COUNT", "500"]]);
    if (scan.error) throw new Error(scan.error);
    cursor = String(scan.result[0]);
    const batch = (scan.result[1] as string[]).filter((k) => !SKIP.test(k));
    skipped += (scan.result[1] as string[]).length - batch.length;
    for (let i = 0; i < batch.length; i += 100) {
      const ks = batch.slice(i, i + 100);
      const meta = await up(ks.flatMap((k) => [["TYPE", k], ["PTTL", k]]));
      const types = ks.map((_, j) => String(meta[2 * j]?.result || "none"));
      const ttls = ks.map((_, j) => Number(meta[2 * j + 1]?.result ?? -1));
      const sizeCmd = (k: string, t: string) => (t === "hash" ? ["HLEN", k] : t === "list" ? ["LLEN", k] : t === "set" ? ["SCARD", k] : t === "zset" ? ["ZCARD", k] : ["EXISTS", k]);
      const sizes = (await up(ks.map((k, j) => sizeCmd(k, types[j])))).map((x) => Number(x.result || 0));
      // small values in one read; big collections in chunks
      const reads: unknown[][] = [];
      const slot: number[] = [];
      ks.forEach((k, j) => {
        const t = types[j];
        if (t === "string") reads.push(["GET", k]), slot.push(j);
        else if (sizes[j] <= CHUNK && t === "hash") reads.push(["HGETALL", k]), slot.push(j);
        else if (sizes[j] <= CHUNK && t === "list") reads.push(["LRANGE", k, "0", "-1"]), slot.push(j);
        else if (sizes[j] <= CHUNK && t === "set") reads.push(["SMEMBERS", k]), slot.push(j);
        else if (sizes[j] <= CHUNK && t === "zset") reads.push(["ZRANGE", k, "0", "-1", "WITHSCORES"]), slot.push(j);
      });
      const got = await up(reads);
      const vals: Record<number, any> = {};
      got.forEach((x, n) => (vals[slot[n]] = x.error ? undefined : x.result));
      for (let j = 0; j < ks.length; j++) {
        const k = ks[j], t = types[j], ttl = ttls[j];
        if (t === "none" || ttl === -2) continue;
        try {
          let v = vals[j];
          if (v === undefined && t !== "string") v = await readBig(up, k, t, sizes[j]);
          if (v == null) continue;
          const p = local.multi();
          p.del(k);
          if (t === "string") p.set(k, String(v));
          else if (t === "hash") for (let a = 0; a < v.length; a += CHUNK * 2) p.hset(k, ...v.slice(a, a + CHUNK * 2));
          else if (t === "list") for (let a = 0; a < v.length; a += CHUNK) p.rpush(k, ...v.slice(a, a + CHUNK));
          else if (t === "set") for (let a = 0; a < v.length; a += CHUNK) p.sadd(k, ...v.slice(a, a + CHUNK));
          else if (t === "zset") {
            const pairs: string[] = [];
            for (let a = 0; a < v.length; a += 2) pairs.push(String(v[a + 1]), String(v[a]));
            for (let a = 0; a < pairs.length; a += CHUNK * 2) p.zadd(k, ...pairs.slice(a, a + CHUNK * 2));
          } else continue; // streams and modules: not used here
          if (ttl > 0) p.pexpire(k, ttl);
          await p.exec();
          keys++;
          members += Array.isArray(v) ? v.length : 1;
        } catch (e) {
          fails++;
          if (fails <= 5) log(`redis move: ${k} failed: ${String((e as any)?.message || e).slice(0, 120)}`);
        }
      }
      if (Date.now() - lastLog > 5_000) {
        lastLog = Date.now();
        log(`redis move: ${keys} keys copied so far (${Math.round((Date.now() - t0) / 1000)}s)`);
        await up([["SET", "rn:worker:at", String(Date.now() + 3600_000)]]).catch(() => null);
      }
    }
  } while (cursor !== "0");
  const info = { at: Date.now(), keys, members, skipped, fails, ms: Date.now() - t0 };
  await local.set(MOVED_KEY, JSON.stringify(info));
  // the old database: the worker "alive" for 30 days (the Vercel minute ping never takes over there), and a note
  await up([["SET", "rn:worker:at", String(Date.now() + 30 * 86400_000)], ["SET", "rn:moved", JSON.stringify({ to: "railway", ...info })]]).catch(() => null);
  log(`redis move: done, ${keys} keys (${members} values) in ${Math.round(info.ms / 1000)}s, ${skipped} locks skipped, ${fails} failed`);
  return info;
}

async function readBig(up: Up, k: string, t: string, size: number) {
  const out: string[] = [];
  if (t === "list" || t === "zset") {
    for (let a = 0; a < size; a += CHUNK) {
      const [x] = await up([t === "list" ? ["LRANGE", k, String(a), String(a + CHUNK - 1)] : ["ZRANGE", k, String(a), String(a + CHUNK - 1), "WITHSCORES"]]);
      if (x.error) throw new Error(x.error);
      out.push(...x.result);
    }
    return out;
  }
  let c = "0";
  do {
    const [x] = await up([[t === "hash" ? "HSCAN" : "SSCAN", k, c, "COUNT", String(CHUNK)]]);
    if (x.error) throw new Error(x.error);
    c = String(x.result[0]);
    out.push(...x.result[1]);
  } while (c !== "0");
  if (t === "hash") {
    // HSCAN can repeat a field: keep the last value of each
    const m = new Map<string, string>();
    for (let a = 0; a < out.length; a += 2) m.set(out[a], out[a + 1]);
    return Array.from(m.entries()).flat();
  }
  return Array.from(new Set(out));
}
