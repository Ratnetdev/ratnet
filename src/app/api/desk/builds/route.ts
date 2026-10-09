import { redis } from "@/lib/redis";
import { memo } from "@/lib/memo";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// v0.1.55: results per build and book over the last 30 days, from the archive (the worker publishes it every 5 minutes).
export async function GET() {
  try {
    const b = await memo("archive:board", 60_000, async () => (await redis().get("rn:archive:board").catch(() => null)) || null);
    return new Response(JSON.stringify(b || { at: null, rows: [], sizes: null }), { headers: { "content-type": "application/json", "cache-control": "public, s-maxage=60, stale-while-revalidate=120" } });
  } catch (e) {
    return fail(e, 500);
  }
}
