import { redis } from "@/lib/redis";
import { memo } from "@/lib/memo";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// v0.1.120: the TICK MODEL (every moment of every live coin): how much it has learned, its out-of-sample record, its weights
export async function GET() {
  try {
    const v = await memo("tick:view", 60_000, async () => (await redis().get("rn:tick:view").catch(() => null)) || null);
    return new Response(JSON.stringify(v || { at: null }), { headers: { "content-type": "application/json", "cache-control": "public, s-maxage=60, stale-while-revalidate=120" } });
  } catch (e) {
    return fail(e, 500);
  }
}
