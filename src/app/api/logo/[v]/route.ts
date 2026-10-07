// Venue logos, fetched once and cached at the edge for a week. Several sources race (Google, DuckDuckGo, the site's
// own favicon); the first real image wins. If all fail, a coloured letter badge is returned so a button is never blank.
export const runtime = "edge";

const DOMAIN: Record<string, string> = { pump: "pump.fun", dex: "dexscreener.com", gmgn: "gmgn.ai", axiom: "axiom.trade", fomo: "fomo.family" };
const BADGE: Record<string, [string, string]> = { pump: ["P", "#54d38a"], dex: ["D", "#9aa4b1"], gmgn: ["G", "#a6f04a"], axiom: ["A", "#e8e8e8"], fomo: ["F", "#ff8a3d"] };

async function one(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(3000), headers: { "user-agent": "Mozilla/5.0 (compatible; ratnet)" } });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !/image|octet-stream|icon/.test(type)) throw new Error(String(r.status));
  const buf = await r.arrayBuffer();
  if (buf.byteLength < 100) throw new Error("empty");
  return { buf, type: /octet-stream/.test(type) ? "image/x-icon" : type };
}

export async function GET(_: Request, { params }: { params: { v: string } }) {
  const d = DOMAIN[params.v];
  if (!d) return new Response("not found", { status: 404 });
  try {
    const got = await Promise.any([
      one(`https://www.google.com/s2/favicons?domain=${d}&sz=64`),
      one(`https://icons.duckduckgo.com/ip3/${d}.ico`),
      one(`https://${d}/favicon.ico`),
    ]);
    return new Response(got.buf, { headers: { "content-type": got.type, "cache-control": "public, max-age=604800, s-maxage=604800, immutable" } });
  } catch {
    const [ch, col] = BADGE[params.v] || ["?", "#8a9a91"];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#111814"/><text x="16" y="22" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="18" fill="${col}">${ch}</text></svg>`;
    return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=600, s-maxage=600" } });
  }
}
