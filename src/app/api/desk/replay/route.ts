import { redis } from "@/lib/redis";
import { memo } from "@/lib/memo";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// v0.1.59: REPLAY's last run (the worker runs it every 3 hours over the archive)
export async function GET() {
  try {
    const v = await memo("replay:view", 120_000, async () => (await redis().get("rn:replay:view").catch(() => null)) || null);
    return new Response(JSON.stringify(v || { at: null }), { headers: { "content-type": "application/json", "cache-control": "public, s-maxage=120, stale-while-revalidate=300" } });
  } catch (e) {
    return fail(e, 500);
  }
}
