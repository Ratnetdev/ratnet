// v0.1.40: the Redis wire layer. Upstash bills (and caps) every byte sent to it and every byte it sends back, and on
// 8 Oct the $20 plan's 100GB ran out in 8 days. Most of those bytes were large JSON values: desk trades, runs, launch
// records, boards. JSON compresses 5 to 10 times, so this layer, sitting on the one fetch the Upstash client uses:
//  - compresses every large VALUE written (set, setex, hset, lpush, mset ...) with deflate, stored as "~z1~<base64>"
//    (the web CompressionStream, so the same code runs on Node, Vercel functions and the Edge runtime)
//  - inflates any such string in every answer, pipelines and transactions included, before the client parses it
//  - counts the real bytes on the wire per command, for the bandwidth meter and the daily governor (lib/bwgov.ts)
// Keys, set members, sorted-set members, scores and fields are never touched, so lookups and ranges behave as before.
// Old uncompressed values stay readable: only strings that start with the marker are inflated.
import { bwCount } from "./bwgov";

export const MARK = "~z1~";
const MIN = Number(process.env.RW_MIN_BYTES || 1024);

// which argument positions of a command hold values (0 = the command name)
function valueSlots(cmd: unknown[]): number[] {
  const c = String(cmd[0] || "").toLowerCase();
  const n = cmd.length;
  const from = (i: number, step = 1) => {
    const out: number[] = [];
    for (let k = i; k < n; k += step) out.push(k);
    return out;
  };
  switch (c) {
    case "set":
    case "setnx":
    case "getset":
      return [2];
    case "setex":
    case "psetex":
    case "lset":
    case "hsetnx":
      return [3];
    case "mset":
    case "msetnx":
      return from(2, 2);
    case "hset":
    case "hmset":
      return from(3, 2);
    case "lpush":
    case "rpush":
    case "lpushx":
    case "rpushx":
      return from(2);
    default:
      return [];
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64(u: Uint8Array) {
  if (typeof Buffer !== "undefined") return Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString("base64");
  return b64js(u);
}
/** Base64 without Buffer (the Edge runtime). Exported for the tests. */
export function b64js(u: Uint8Array) {
  let out = "";
  for (let i = 0; i < u.length; i += 3) {
    const n = (u[i] << 16) | ((u[i + 1] ?? 0) << 8) | (u[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < u.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < u.length ? B64[n & 63] : "=");
  }
  return out;
}
function unb64(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  return unb64js(s);
}
export function unb64js(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function through(data: Uint8Array, t: CompressionStream | DecompressionStream) {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(t as any);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// v0.1.41: Node's own zlib when there is one (about 15x faster than the web stream; a full read of the desk's round
// trips cost 0.4 to 0.8s of CPU with the stream), the web stream on the Edge runtime. Same deflate-raw format.
const MAX_OUT = 4 * 1024 * 1024; // a stored value never inflates past 4MB (a crafted value cannot blow up memory)
type Z = { deflateRawSync: (b: Uint8Array, o?: any) => Uint8Array; inflateRawSync: (b: Uint8Array, o?: any) => Uint8Array };
let ZL: Z | null | undefined;
function nodeZlib(): Z | null {
  if (ZL !== undefined) return ZL;
  ZL = null;
  try {
    const p: any = (globalThis as any).process;
    ZL = p?.getBuiltinModule?.("zlib") || null;
    if (!ZL && p?.versions?.node) ZL = (0, eval)("require")("zlib");
  } catch {
    ZL = null;
  }
  return ZL ?? null;
}
export const _wireEngine = () => (nodeZlib() ? "zlib" : "stream");

export async function pack(v: string): Promise<string> {
  if (v.length < MIN || v.startsWith(MARK)) return v;
  const zl = nodeZlib();
  const raw = new TextEncoder().encode(v);
  const bytes = zl ? zl.deflateRawSync(raw, { level: 6 }) : await through(raw, new CompressionStream("deflate-raw"));
  const z = MARK + b64(bytes);
  return z.length < v.length ? z : v;
}

export async function unpack(v: string): Promise<string> {
  if (!v.startsWith(MARK)) return v;
  try {
    const zl = nodeZlib();
    const raw = unb64(v.slice(MARK.length));
    const out = zl ? zl.inflateRawSync(raw, { maxOutputLength: MAX_OUT }) : await through(raw, new DecompressionStream("deflate-raw"));
    if (out.byteLength > MAX_OUT) return v;
    return new TextDecoder().decode(out);
  } catch {
    return v;
  }
}

/** Compress the value arguments of one command in place. Returns true when something changed. */
export async function packCommand(cmd: unknown[]): Promise<boolean> {
  let hit = false;
  for (const i of valueSlots(cmd)) {
    const v = cmd[i];
    if (typeof v === "string" && v.length >= MIN) {
      const z = await pack(v);
      if (z !== v) {
        cmd[i] = z;
        hit = true;
      }
    }
  }
  return hit;
}

/** Inflate every marked string anywhere in a parsed answer. */
export async function inflateDeep(x: any): Promise<any> {
  const found: string[] = [];
  const walk = (y: any) => {
    if (typeof y === "string") {
      if (y.startsWith(MARK)) found.push(y);
    } else if (Array.isArray(y)) y.forEach(walk);
    else if (y && typeof y === "object") Object.values(y).forEach(walk);
  };
  walk(x);
  if (!found.length) return x;
  const uniq = Array.from(new Set(found));
  const out = new Map(await Promise.all(uniq.map(async (z) => [z, await unpack(z)] as const)));
  const put = (y: any): any => {
    if (typeof y === "string") return out.get(y) ?? y;
    if (Array.isArray(y)) {
      for (let i = 0; i < y.length; i++) y[i] = put(y[i]);
      return y;
    }
    if (y && typeof y === "object") {
      for (const k of Object.keys(y)) y[k] = put(y[k]);
      return y;
    }
    return y;
  };
  return put(x);
}

export type WireTap = (cmds: unknown[][], tx: number[], rx: number[]) => void;
const taps: WireTap[] = [];
export const onWire = (f: WireTap) => taps.push(f);
export const wireTotals = { tx: 0, rx: 0, calls: 0, saved: 0 };

const isPipeUrl = (u: string) => /\/(pipeline|multi-exec)(\?|$)/.test(u);

/** Wrap global fetch for the Upstash base URL. Safe to call more than once. */
export function installRedisWire(base?: string) {
  const g = globalThis as any;
  base = base || process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  if (!base || typeof g.fetch !== "function" || g.__rnWire === base) return;
  // v0.1.64: a second base (the worker switching to Railway's Redis) re-wraps the original fetch, never the wrapper
  const orig = g.__rnWireOrig || g.fetch.bind(globalThis);
  g.__rnWireOrig = orig;
  g.__rnWire = base;
  const root = base.replace(/\/+$/, "");
  g.fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (!url.startsWith(root)) return orig(input, init);
    const pipe = isPipeUrl(url);
    let cmds: unknown[][] = [];
    let body = typeof init?.body === "string" ? init.body : "";
    if (body) {
      try {
        const parsed = JSON.parse(body);
        cmds = pipe ? parsed : [parsed];
        const before = body.length;
        let hit = false;
        for (const c of cmds) if (Array.isArray(c) && (await packCommand(c))) hit = true;
        if (hit) {
          body = JSON.stringify(pipe ? cmds : cmds[0]);
          wireTotals.saved += before - body.length;
          init = { ...init, body };
        }
      } catch {}
    }
    // v0.1.64: the worker on Railway's Redis: answered in-process (lib/redisrest.ts), no network
    const local = (globalThis as any).__rnLocalRedis;
    const res: Response = local && url.startsWith("http://rn-local-redis") ? await local(url, body).then((a: { status: number; body: string }) => new Response(a.body, { status: a.status, headers: { "content-type": "application/json" } })) : await orig(input, init);
    const txt = await res.text();
    wireTotals.tx += body.length;
    wireTotals.rx += txt.length;
    wireTotals.calls += cmds.length || 1;
    bwCount(body.length + txt.length + 300); // + ~300 bytes of HTTP headers each way that Upstash may count
    let out = txt;
    let parsed: any = null;
    if (txt.includes(MARK) || taps.length) {
      try {
        parsed = JSON.parse(txt);
      } catch {}
    }
    if (taps.length) {
      try {
        const tx = cmds.map((c) => (pipe ? JSON.stringify(c).length : body.length));
        const rx = cmds.map((_, i) => (pipe && Array.isArray(parsed) ? JSON.stringify(parsed[i] ?? null).length : txt.length));
        for (const t of taps) t(cmds, tx, rx);
      } catch {}
    }
    if (parsed && txt.includes(MARK)) out = JSON.stringify(await inflateDeep(parsed));
    // the answer's own headers (Upstash's sync token among them), minus the ones that describe the old body
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    if (!headers.get("content-type")) headers.set("content-type", "application/json");
    return new Response(out, { status: res.status, statusText: res.statusText, headers });
  };
}
