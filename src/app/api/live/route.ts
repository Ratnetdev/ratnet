import { venueTemplates } from "@/lib/venues";
import { getBondCalls, getCalls, getFeed, getGrads, getRadar, getStats } from "@/lib/stats";
import { getSettings } from "@/lib/settings";
import { cached, fail } from "@/lib/http";
import { K, redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [stats, feed, calls, s, burns, radar, grads, desk, exam, bondCalls, ev] = await Promise.all([
      getStats(),
      getFeed(40),
      getCalls(12),
      getSettings(),
      redis().lrange(K.burns, 0, 9),
      getRadar(10),
      getGrads(8),
      redis().get<{ equity: number; start: number; live: boolean; liveStart: number | null; dayStart: number }>(K.deskState),
      redis().get(K.deskExam),
      getBondCalls(8).catch(() => []),
      redis().lrange<any>(K.deskEv, 0, 19).catch(() => []),
    ]);
    // the agents' headline moments for the live toasts on every page: trades, sends, MOMO and MIND calls
    const HEAD = new Set(["EXEC", "RISK", "KING", "MOMO", "MIND", "WIRE", "LEDGER", "HOUND", "PM"]);
    const agents = ((ev || []) as any[]).filter((e) => e && HEAD.has(e.agent) && (e.tone === "ok" || e.tone === "win" || e.tone === "loss")).slice(0, 12).map((e) => ({ agent: e.agent, at: e.at, mint: e.mint || "", symbol: e.symbol || "", text: String(e.text || "").slice(0, 160), tone: e.tone }));
    return cached({ stats, feed, agents, calls, bondCalls, burns, radar, grads, desk: desk ? { eq: desk.equity, base: desk.live ? desk.liveStart ?? desk.start : desk.start, live: desk.live, day: desk.dayStart, exam: exam || null } : null, live: { mint: s.mint, links: s.links, litter: s.litter, venues: venueTemplates(s) }, now: Date.now() }, 3);
  } catch (e) {
    return fail(e, 500);
  }
}
