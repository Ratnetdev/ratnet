// Venue logos as PNG, fetched once and cached at the edge for a week.
export const runtime = "edge";

const DOMAIN: Record<string, string> = { pump: "pump.fun", dex: "dexscreener.com", gmgn: "gmgn.ai", axiom: "axiom.trade", fomo: "fomo.family" };

export async function GET(_: Request, { params }: { params: { v: string } }) {
  const d = DOMAIN[params.v];
  if (!d) return new Response("not found", { status: 404 });
  try {
    const r = await fetch(`https://www.google.com/s2/favicons?domain=${d}&sz=64`, { cache: "force-cache" });
    if (!r.ok) throw new Error(String(r.status));
    return new Response(await r.arrayBuffer(), { headers: { "content-type": r.headers.get("content-type") || "image/png", "cache-control": "public, max-age=604800, s-maxage=604800, immutable" } });
  } catch {
    // a neutral dot if the logo can't be fetched
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="#8a9a91"/></svg>`;
    return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
  }
}
