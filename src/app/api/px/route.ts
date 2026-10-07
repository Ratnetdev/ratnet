// Live market caps for the coins on a page, straight from the chain (bonding curve or the canonical PumpSwap pool),
// DexScreener only as a fallback. Cached 1s on the CDN, so every viewer of the same coins shares one read. The browser
// uses this next to the PumpPortal trade stream: whichever is newer wins, so a number is never more than ~2s old.
import { priceOf } from "@/lib/desk";
import { solUsd } from "@/lib/solana";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(req: Request) {
  const mints = Array.from(new Set((new URL(req.url).searchParams.get("m") || "").split(",").filter((m) => MINT.test(m)))).sort().slice(0, 60);
  if (!mints.length) return NextResponse.json({ px: {} });
  try {
    const [px, sol] = await Promise.all([priceOf(mints), solUsd()]);
    const out: Record<string, { mc: number; grad: boolean }> = {};
    for (const m of mints) if (px[m] && sol) out[m] = { mc: Math.round(px[m].px * 1e9 * sol), grad: px[m].grad };
    return NextResponse.json({ px: out, at: Date.now() }, { headers: { "cache-control": "public, max-age=0, s-maxage=1, stale-while-revalidate=2" } });
  } catch {
    return NextResponse.json({ px: {} }, { status: 200, headers: { "cache-control": "no-store" } });
  }
}
