import { KING_V1 } from "@/lib/kingcal";
import { getCalls, getGrads, getResolvedCalls, getStats } from "@/lib/stats";
import { loadModel } from "@/lib/digger";
import { WEIGHTS, VERDICTS, KING_VERSION } from "@/lib/king";
import { NANO_MIN } from "@/lib/nano";
import { cached, fail, ipOf, memLimit, tooMany } from "@/lib/http";
import { memo } from "@/lib/memo";
import { loadCal } from "@/lib/kingcal";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const page = Math.min(50, Math.max(0, Math.floor(Number(url.searchParams.get("page") || 0)) || 0));
    const verdict = (url.searchParams.get("verdict") || "").toUpperCase().slice(0, 12);
    // v0.1.41: only real filters (any other value used to be a fresh 300-call read)
    if (verdict && !["BOND", "WATCH", "DUST"].includes(verdict)) return fail("bad verdict");
    if ((verdict || page) && !memLimit(`king:${ipOf(req)}`, 60, 60)) return tooMany();
    // v0.1.40: up to 300 full calls per answer; read at most every 10s per server instance and filter
    const [callsRaw, resolved, stats, model, grads, cal] = await memo(`api:king:${verdict}:${page}`, 20_000, () => Promise.all([
      getCalls(verdict ? 300 : 60, verdict ? 0 : page * 60),
      getResolvedCalls(40),
      getStats(),
      loadModel(),
      getGrads(40),
      loadCal().catch(() => null),
    ]));
    const calls = verdict ? callsRaw.filter((c) => c.verdict === verdict || c.nano?.verdict === verdict).slice(0, 60) : callsRaw;
    return cached(
      {
        calls: calls.map(({ x, parts, nc, ...c }) => c),
        resolved: resolved.map(({ x, parts, nc, ...c }) => c),
        grads,
        stats,
        weights: WEIGHTS,
        verdicts: VERDICTS,
        version: cal?.ready ? KING_V1 : KING_VERSION,
        // King v1 (nano leads, lines calibrated on the last 7 days): public status only, the lines are admin only
        v1: cal ? { ready: cal.ready, lessons: cal.n, bonds: cal.pos, base: cal.base, at: cal.at } : null,
        // v0.1.41: n counts live lessons (history replays train it but do not unlock calls)
        nano: { n: model.nl || 0, all: model.n, pos: model.pos, min: NANO_MIN, loss: model.loss },
      },
      5
    );
  } catch (e) {
    return fail(e, 500);
  }
}
