import { getRatBoard } from "@/lib/stats";
import { cached, fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const wallet = new URL(req.url).searchParams.get("wallet") || "";
    const board = await getRatBoard();
    const { settings, ...rest } = board;
    const body = {
      ...rest,
      costs: { spawn: settings.spawnCost, sniff: settings.sniffCost, minWork: settings.minWork },
      live: !!settings.mint,
      mine: wallet ? board.rats.filter((r) => r.owner === wallet) : [],
    };
    return wallet ? json(body) : cached(body, 5);
  } catch (e) {
    return fail(e, 500);
  }
}
