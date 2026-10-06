import { getRecord, VET_KEY } from "@/lib/desk";
import { coinLog } from "@/lib/agents";
import { isPubkey } from "@/lib/solana";
import { redis } from "@/lib/redis";
import { fail } from "@/lib/http";
import { publicChecks, publicTrip, serve } from "@/lib/private";
import { lensDossier } from "@/lib/lens";
import { feedbackFor } from "@/lib/feedback";
import { wantsFull } from "@/lib/private";

export const dynamic = "force-dynamic";

// What the desk did on one coin: every trade with its full context, the last VET verdict, every agent line, LENS.
export async function GET(req: Request) {
  try {
    const mint = new URL(req.url).searchParams.get("mint") || "";
    if (!isPubkey(mint)) return fail("bad mint");
    const full = wantsFull(req);
    const [rec, log, vet, lens, fb, call] = await Promise.all([
      getRecord(mint),
      coinLog(mint),
      redis().get<any>(VET_KEY(mint)),
      lensDossier(mint).catch(() => null),
      full ? feedbackFor(mint).catch(() => []) : Promise.resolve([]),
      redis().get<any>(`rn:call:${mint}`).catch(() => null),
    ]);
    const data = { trips: rec.trips, live: rec.live, log, vet: vet || null, lens, feedback: fb, card: call ? { symbol: call.symbol, score: call.score, verdict: call.verdict, nano: call.nano, parts: call.parts || null, nc: call.nc || null, why: call.why || null, progress: call.progress, at: call.at } : null };
    return serve(
      req,
      data,
      (d) => ({ ...d, trips: d.trips.map(publicTrip), vet: d.vet ? { ...d.vet, checks: publicChecks(d.vet.checks) } : null, card: d.card ? { symbol: d.card.symbol, score: d.card.score, verdict: d.card.verdict, nano: d.card.nano, why: d.card.why, progress: d.card.progress, at: d.card.at } : null }),
      4
    );
  } catch (e) {
    return fail(e, 500);
  }
}
