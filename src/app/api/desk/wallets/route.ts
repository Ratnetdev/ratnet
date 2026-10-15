import { redis } from "@/lib/redis";
import { memo } from "@/lib/memo";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// v0.1.81: WALLETS and the FIREHOSE (the worker publishes it once a minute)
export async function GET() {
  try {
    const v = await memo("wallets:view", 30_000, async () => (await redis().get("rn:wallets:view").catch(() => null)) || null);
    return new Response(JSON.stringify(v || { at: null }), { headers: { "content-type": "application/json", "cache-control": "public, s-maxage=30, stale-while-revalidate=60" } });
  } catch (e) {
    return fail(e, 500);
  }
}
