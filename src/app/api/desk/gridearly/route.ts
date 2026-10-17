import { redis } from "@/lib/redis";
import { memo } from "@/lib/memo";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// v0.1.115: the EARLY search's last run (every launch read at 2 minutes, lib/early.ts)
export async function GET() {
  try {
    const v = await memo("grid:early", 120_000, async () => (await redis().get("rn:grid:early").catch(() => null)) || null);
    return new Response(JSON.stringify(v || { at: null }), { headers: { "content-type": "application/json", "cache-control": "public, s-maxage=120, stale-while-revalidate=300" } });
  } catch (e) {
    return fail(e, 500);
  }
}
