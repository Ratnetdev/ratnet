import { getCalls, getResolvedCalls, getStats } from "@/lib/stats";
import { WEIGHTS, VERDICTS, KING_VERSION } from "@/lib/king";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const page = Math.max(0, Number(new URL(req.url).searchParams.get("page") || 0));
    const [calls, resolved, stats] = await Promise.all([getCalls(60, page * 60), getResolvedCalls(40), getStats()]);
    return json({ calls, resolved, stats, weights: WEIGHTS, verdicts: VERDICTS, version: KING_VERSION });
  } catch (e) {
    return fail(e, 500);
  }
}
