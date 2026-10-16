// Live market caps for the coins on a page (v0.1.38): from the worker's price cache (curve or canonical PumpSwap pool,
// read on the worker's budgeted lane), DexScreener for a coin the worker has not priced yet. Vercel no longer reads the
// chain here. Cached 4s on the CDN, so viewers of the same coins share one answer.
import { dexPx } from "@/lib/desk";
import { readPxCache } from "@/lib/pxcache";
import { solUsd } from "@/lib/solana";
import { NextResponse } from "next/server";
import { cached } from "@/lib/http";

export const dynamic = "force-dynamic";

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(req: Request) {
  const mints = Array.from(new Set((new URL(req.url).searchParams.get("m") || "").split(",").filter((m) => MINT.test(m)))).sort().slice(0, 60);
  if (!mints.length) return NextResponse.json({ px: {} });
  try {
    const [cache, sol] = await Promise.all([readPxCache(mints), solUsd()]);
    const miss = mints.filter((m) => !cache[m]);
    const dx = miss.length ? await dexPx(miss).catch(() => ({} as Record<string, { px: number; sol: number }>)) : {};
    // v0.1.84: the price itself too (SOL per token), so pages work out changes and P&L from the same number
    const out: Record<string, { mc: number; grad: boolean; px?: number }> = {};
    if (sol) {
      for (const m of mints) {
        if (cache[m]) out[m] = { mc: Math.round(cache[m].px * 1e9 * sol), grad: cache[m].grad, px: cache[m].px };
        else if (dx[m]) out[m] = { mc: Math.round(dx[m].px * 1e9 * sol), grad: true, px: dx[m].px };
      }
    }
    // v0.1.41: through cached() so saving mode stretches it too. v0.1.84: 1s on the CDN (was 4s): the worker now
    // rewrites prices every second from the firehose
    return cached({ px: out, at: Date.now() }, 1, 2);
  } catch {
    return NextResponse.json({ px: {} }, { status: 200, headers: { "cache-control": "no-store" } });
  }
}
