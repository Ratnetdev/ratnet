// Venue logos, fetched once and cached at the edge for a week. Several sources race (Google, DuckDuckGo, the site's
// own favicon); the first real image wins. If all fail, a coloured letter badge is returned so a button is never blank.
export const runtime = "edge";

const DOMAIN: Record<string, string> = { pump: "pump.fun", dex: "dexscreener.com", gmgn: "gmgn.ai", axiom: "axiom.trade", fomo: "fomo.family" };
const BADGE: Record<string, [string, string]> = { pump: ["P", "#54d38a"], dex: ["D", "#9aa4b1"], gmgn: ["G", "#a6f04a"], axiom: ["A", "#e8e8e8"], fomo: ["F", "#ff8a3d"] };

// real raster type from the bytes (fixed hosts, but still never echo an upstream content-type)
function sniff(b: Uint8Array) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return "image/x-icon";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return null;
}
const SAFE = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };

async function one(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(3000), headers: { "user-agent": "Mozilla/5.0 (compatible; ratnet)" } });
  if (!r.ok) throw new Error(String(r.status));
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.byteLength < 100 || buf.byteLength > 300_000) throw new Error("size");
  const type = sniff(buf);
  if (!type) throw new Error("not an image");
  return { buf, type };
}

export async function GET(_: Request, props: { params: Promise<{ v: string }> }) {
  const params = await props.params;
  const d = DOMAIN[params.v];
  if (!d) return new Response("not found", { status: 404 });
  try {
    const got = await Promise.any([
      one(`https://www.google.com/s2/favicons?domain=${d}&sz=64`),
      one(`https://icons.duckduckgo.com/ip3/${d}.ico`),
      one(`https://${d}/favicon.ico`),
    ]);
    return new Response(got.buf, { headers: { ...SAFE, "content-type": got.type, "cache-control": "public, max-age=604800, s-maxage=604800, immutable" } });
  } catch {
    const [ch, col] = BADGE[params.v] || ["?", "#8a9a91"];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#111814"/><text x="16" y="22" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="18" fill="${col}">${ch}</text></svg>`;
    return new Response(svg, { headers: { ...SAFE, "content-type": "image/svg+xml", "cache-control": "public, max-age=600, s-maxage=600" } });
  }
}
