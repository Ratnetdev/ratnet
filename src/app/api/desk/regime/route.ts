import { REGIME_VIEW } from "@/lib/regimegate";
import { redis } from "@/lib/redis";
import { memo } from "@/lib/memo";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// v0.1.63: REGIME, the market state and which strategies it has on, at half size or off (the worker publishes it every 5 minutes)
export async function GET() {
  try {
    const v = (await memo("regime:view", 30_000, async () => (await redis().get(REGIME_VIEW).catch(() => null)) || null)) || { at: null };
    return new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": "public, s-maxage=30, stale-while-revalidate=60" } });
  } catch (e) {
    return fail(e, 500);
  }
}
