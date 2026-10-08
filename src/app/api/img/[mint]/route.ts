// Coin logos, fast and reliable on every page. pump.fun images live on IPFS, and the public ipfs.io gateway is slow
// and often fails, so new coins showed no logo. This route finds the image (our dig record, the launch metadata,
// pump.fun, then DexScreener), asks several IPFS gateways at once and takes the first that answers, and caches the
// result on the CDN for a week. If nothing answers it draws a clean badge with the ticker.
//
// Security: the image URL is chosen by whoever launched the coin. Only real raster images go out (type read from the
// bytes, never from the upstream header; SVG/HTML refused), served with nosniff + a sandbox CSP, fetched only from
// public hosts with a byte cap (lib/safefetch).
import { K, redis } from "@/lib/redis";
import { HOSTILE_HEADERS, imageType, safeFetch } from "@/lib/safefetch";

export const dynamic = "force-dynamic";

const GATEWAYS = ["https://pump.mypinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://cf-ipfs.com/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://dweb.link/ipfs/"];
const URL_KEY = (m: string) => `rn:img:${m}`;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function cidOf(u: string) {
  const m = /(?:ipfs:\/\/|\/ipfs\/)([A-Za-z0-9]{40,})(\/[^?#]*)?/.exec(u || "");
  return m ? `${m[1]}${m[2] || ""}` : null;
}

async function grab(url: string, ms = 3500) {
  const g = await safeFetch(url, { maxBytes: 4_000_000, timeoutMs: ms });
  const type = imageType(g.buf);
  if (!type) throw new Error("not an image");
  return { buf: g.buf, type };
}

/** First gateway that returns the image wins (all asked at once). */
async function fromAny(src: string) {
  const cid = cidOf(src);
  const urls = cid ? GATEWAYS.map((g) => g + cid) : [src];
  return Promise.any(urls.map((u) => grab(u)));
}

async function imageUrlOf(mint: string) {
  const r = redis();
  const cached = await r.get<string>(URL_KEY(mint)).catch(() => null);
  if (cached) return cached;
  const rec = (await r.get<any>(K.launch(mint)).catch(() => null)) as any;
  let u = typeof rec?.image === "string" ? rec.image : "";
  if (!u && typeof rec?.uri === "string" && rec.uri) {
    // brand-new coins: the image sits in the metadata JSON the launch points at
    const cid = cidOf(rec.uri);
    const urls = cid ? GATEWAYS.slice(0, 3).map((g) => g + cid) : [rec.uri];
    const meta: any = await Promise.any(urls.map((x) => safeFetch(x, { maxBytes: 64_000, timeoutMs: 3000 }).then((g) => JSON.parse(g.buf.toString("utf8"))))).catch(() => null);
    u = typeof meta?.image === "string" ? meta.image : "";
  }
  if (!u) {
    const pf = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, { signal: AbortSignal.timeout(3000), cache: "no-store" }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    u = typeof pf?.image_uri === "string" ? pf.image_uri : "";
  }
  if (!u) {
    const ds: any[] = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: AbortSignal.timeout(3000), cache: "no-store" }).then((x) => (x.ok ? x.json() : [])).catch(() => []);
    u = (Array.isArray(ds) ? ds : []).find((p: any) => typeof p?.info?.imageUrl === "string")?.info?.imageUrl || "";
  }
  u = String(u).slice(0, 500);
  if (u) await r.set(URL_KEY(mint), u, { ex: 7 * 86400 }).catch(() => {});
  return u;
}

function badge(sym: string, mint: string) {
  let h = 0;
  for (const c of mint) h = (h * 31 + c.charCodeAt(0)) % 360;
  const t = (sym || mint.slice(0, 2)).replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl(${h},45%,18%)"/><rect x="1" y="1" width="62" height="62" rx="13" fill="none" stroke="hsl(${h},60%,45%)" stroke-opacity=".6"/><text x="32" y="41" text-anchor="middle" font-family="monospace" font-size="24" font-weight="700" fill="hsl(${h},85%,72%)">${t}</text></svg>`;
}

export async function GET(req: Request, props: { params: Promise<{ mint: string }> }) {
  const params = await props.params;
  const mint = params.mint;
  if (!MINT.test(mint)) return new Response("bad mint", { status: 400 });
  const sym = (new URL(req.url).searchParams.get("s") || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  try {
    const u = await imageUrlOf(mint);
    if (!u) throw new Error("no image");
    const { buf, type } = await fromAny(u);
    return new Response(new Uint8Array(buf), { headers: { ...HOSTILE_HEADERS, "content-type": type, "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800, immutable" } });
  } catch {
    // our own SVG (only [A-Za-z0-9] from the query reaches it); retried within two minutes
    return new Response(badge(sym, mint), { headers: { ...HOSTILE_HEADERS, "content-type": "image/svg+xml", "cache-control": "public, max-age=60, s-maxage=120" } });
  }
}
