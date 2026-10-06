import { getCalls, getGrads, getResolvedCalls, getStats } from "@/lib/stats";
import { loadModel } from "@/lib/digger";
import { WEIGHTS, VERDICTS, KING_VERSION } from "@/lib/king";
import { NANO_MIN } from "@/lib/nano";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const page = Math.max(0, Number(url.searchParams.get("page") || 0));
    const verdict = (url.searchParams.get("verdict") || "").toUpperCase();
    const [callsRaw, resolved, stats, model, grads] = await Promise.all([
      getCalls(verdict ? 300 : 60, verdict ? 0 : page * 60),
      getResolvedCalls(40),
      getStats(),
      loadModel(),
      getGrads(40),
    ]);
    const calls = verdict ? callsRaw.filter((c) => c.verdict === verdict || c.nano?.verdict === verdict).slice(0, 60) : callsRaw;
    return cached(
      {
        calls: calls.map(({ x, ...c }) => c),
        resolved: resolved.map(({ x, ...c }) => c),
        grads,
        stats,
        weights: WEIGHTS,
        verdicts: VERDICTS,
        version: KING_VERSION,
        nano: { n: model.n, pos: model.pos, min: NANO_MIN, loss: model.loss },
      },
      5
    );
  } catch (e) {
    return fail(e, 500);
  }
}
