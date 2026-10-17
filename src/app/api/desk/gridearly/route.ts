import { redis } from "@/lib/redis";
import { memo } from "@/lib/memo";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// v0.1.115: the EARLY search's last run (every launch read at 2 minutes, lib/early.ts)
// v0.1.117: ?sec=60|180|300 for the other reading ages (one search each)
export async function GET(req: Request) {
  try {
    const sec = Math.round(Number(new URL(req.url).searchParams.get("sec") || 120)) || 120;
    const key = sec === 120 ? "rn:grid:early" : `rn:grid:early:${sec}`;
    const v = await memo(`grid:early:${sec}`, 120_000, async () => (await redis().get(key).catch(() => null)) || null);
    return new Response(JSON.stringify(v || { at: null, sec }), { headers: { "content-type": "application/json", "cache-control": "public, s-maxage=120, stale-while-revalidate=300" } });
  } catch (e) {
    return fail(e, 500);
  }
}
