import { ARENA_VIEW, VARIANTS } from "@/lib/arena";
import { redis } from "@/lib/redis";
import { memo } from "@/lib/memo";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// v0.1.58: ARENA, the paper strategies running side by side (variants, open positions, scores, recent trips)
export async function GET() {
  try {
    // the worker publishes this once a minute; page views never read the trip list itself
    const v = (await memo("arena:view", 30_000, async () => (await redis().get(ARENA_VIEW).catch(() => null)) || null)) || { at: null, variants: VARIANTS.map((x) => ({ ...x, open: [], n: 0, wins: 0, winRate: 0, pnl: 0, avgPct: 0, checks: [], passed: false })), recent: [] };
    return new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": "public, s-maxage=15, stale-while-revalidate=30" } });
  } catch (e) {
    return fail(e, 500);
  }
}
