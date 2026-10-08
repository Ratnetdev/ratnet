// Server-side fetch for URLs we don't control (token metadata, coin images, project websites).
// Token creators choose these URLs, so treat them as hostile:
//  - http(s) only, public hosts only: IP literals and DNS answers in private, loopback, link-local and metadata ranges
//    are refused (no SSRF into Vercel internals or anything else);
//  - redirects are followed by hand (max 3) and every hop is re-checked;
//  - the body is streamed with a hard byte cap and a deadline that covers the whole read, not just the headers.
import { lookup } from "dns/promises";
import { lookup as dnsLookup, type LookupAddress } from "dns";
import { isIP } from "net";
import { Agent, fetch as ufetch } from "undici";

const PRIVATE4 = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xe0000000, 4], [0xf0000000, 4],
] as const;

function privateV4(ip: string) {
  const n = ip.split(".").reduce((a, x) => (a << 8) + Number(x), 0) >>> 0;
  return PRIVATE4.some(([base, bits]) => (n & ((~0 << (32 - bits)) >>> 0)) >>> 0 === base);
}
function privateIp(ip: string) {
  if (isIP(ip) === 4) return privateV4(ip);
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateV4(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}

// host verdicts cached a minute: the digger reads metadata for every launch and the same gateways repeat
const HOSTS = new Map<string, { ok: boolean; at: number }>();

export async function publicUrl(raw: string, httpsOnly = false) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && (httpsOnly || u.protocol !== "http:")) return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || /(^localhost$|\.local$|\.internal$|\.localhost$)/i.test(host)) return null;
  if (isIP(host)) return privateIp(host) ? null : u;
  const hit = HOSTS.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok ? u : null;
  const addrs = await lookup(host, { all: true }).catch(() => []);
  const ok = addrs.length > 0 && !addrs.some((a) => privateIp(a.address));
  if (HOSTS.size > 2000) HOSTS.clear();
  HOSTS.set(host, { ok, at: Date.now() });
  return ok ? u : null;
}

// DNS rebinding guard (v0.1.39): the check above resolves the host, but fetch used to resolve it again on its own,
// so a hostile DNS server could answer with a public address for the check and a private one for the connection.
// Every connection now resolves through this lookup, which refuses private addresses at connect time.
export function connectLookup(host: string, opts: any, cb: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void) {
  dnsLookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err, undefined as any);
    const list = (Array.isArray(addrs) ? addrs : []) as LookupAddress[];
    if (!list.length || list.some((a) => privateIp(a.address))) return cb(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }), undefined as any);
    if (opts?.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  });
}
const guarded = new Agent({ connect: { lookup: connectLookup as any } });

export type Got = { buf: Buffer; type: string; url: string; status: number; ok: boolean };

/** Fetch a hostile URL safely. Throws on anything off. */
export async function safeFetch(raw: string, o: { maxBytes?: number; timeoutMs?: number; httpsOnly?: boolean; headers?: Record<string, string>; anyStatus?: boolean } = {}): Promise<Got> {
  const maxBytes = o.maxBytes ?? 2_000_000;
  const deadline = AbortSignal.timeout(o.timeoutMs ?? 4000);
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await publicUrl(url, o.httpsOnly);
    if (!u) throw new Error("blocked url");
    const r = await ufetch(u, { redirect: "manual", signal: deadline, dispatcher: guarded, headers: { "user-agent": "Mozilla/5.0 (compatible; ratnet)", ...(o.headers || {}) } });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) throw new Error("bad redirect");
      url = new URL(loc, u).toString();
      continue;
    }
    if ((!r.ok && !o.anyStatus) || !r.body) throw new Error(`http ${r.status}`);
    const len = Number(r.headers.get("content-length") || 0);
    if (len > maxBytes) throw new Error("too big");
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBytes) {
        reader.cancel().catch(() => {});
        throw new Error("too big");
      }
      chunks.push(value);
    }
    return { buf: Buffer.concat(chunks), type: (r.headers.get("content-type") || "").toLowerCase(), url: u.toString(), status: r.status, ok: r.ok };
  }
  throw new Error("too many redirects");
}

/** Real raster image type from the bytes themselves (never trust the header; SVG and HTML are refused). */
export function imageType(b: Buffer) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.toString("ascii", 4, 8) === "ftyp" && /avif|avis/.test(b.toString("ascii", 8, 12))) return "image/avif";
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return "image/x-icon";
  return null;
}

/** Headers for serving bytes that came from a stranger: no sniffing, no scripts, no framing. */
export const HOSTILE_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "content-disposition": "inline",
  "cross-origin-resource-policy": "same-origin",
};
