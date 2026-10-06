import { getRatBoard } from "@/lib/stats";
import { getRounds } from "@/lib/rounds";
import { cached, fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const wallet = new URL(req.url).searchParams.get("wallet") || "";
    const [board, rounds] = await Promise.all([getRatBoard(), getRounds().catch(() => [])]);
    const lr = rounds[0];
    const paid = rounds.reduce((a, r) => a + (r.ownersSol || 0), 0);
    const { settings, ...rest } = board;
    const body = {
      ...rest,
      costs: { spawn: settings.spawnCost, sniff: settings.sniffCost, minWork: settings.minWork },
      live: !!settings.mint,
      mint: settings.mint || null,
      lastRound: lr ? { id: lr.id, ownersSol: lr.ownersSol, eligible: lr.eligible, perRat: lr.eligible ? lr.ownersSol / lr.eligible : 0, status: lr.status } : null,
      paidTotal: paid,
      mine: wallet ? board.rats.filter((r) => r.owner === wallet) : [],
    };
    return wallet ? json(body) : cached(body, 5);
  } catch (e) {
    return fail(e, 500);
  }
}
