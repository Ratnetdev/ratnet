import { getCalls, getFeed, getStats } from "@/lib/stats";
import { getSettings } from "@/lib/settings";
import { fail, json } from "@/lib/http";
import { K, redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [stats, feed, calls, s, burns] = await Promise.all([
      getStats(),
      getFeed(40),
      getCalls(12),
      getSettings(),
      redis().lrange(K.burns, 0, 9),
    ]);
    return json({ stats, feed, calls, burns, live: { mint: s.mint, links: s.links, litter: s.litter }, now: Date.now() });
  } catch (e) {
    return fail(e, 500);
  }
}
