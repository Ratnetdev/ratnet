import { getCalls, getFeed, getGrads, getRadar, getStats } from "@/lib/stats";
import { getSettings } from "@/lib/settings";
import { cached, fail } from "@/lib/http";
import { K, redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [stats, feed, calls, s, burns, radar, grads, desk, exam] = await Promise.all([
      getStats(),
      getFeed(40),
      getCalls(12),
      getSettings(),
      redis().lrange(K.burns, 0, 9),
      getRadar(10),
      getGrads(8),
      redis().get<{ equity: number; start: number; live: boolean; liveStart: number | null; dayStart: number }>(K.deskState),
      redis().get(K.deskExam),
    ]);
    return cached({ stats, feed, calls, burns, radar, grads, desk: desk ? { eq: desk.equity, base: desk.live ? desk.liveStart ?? desk.start : desk.start, live: desk.live, day: desk.dayStart, exam: exam || null } : null, live: { mint: s.mint, links: s.links, litter: s.litter }, now: Date.now() }, 3);
  } catch (e) {
    return fail(e, 500);
  }
}
