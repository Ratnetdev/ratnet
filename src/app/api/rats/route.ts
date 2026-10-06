import { getRatBoard } from "@/lib/stats";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const wallet = new URL(req.url).searchParams.get("wallet") || "";
    const board = await getRatBoard();
    const { settings, ...rest } = board;
    return json({
      ...rest,
      costs: { spawn: settings.spawnCost, sniff: settings.sniffCost, minWork: settings.minWork },
      live: !!settings.mint,
      mine: wallet ? board.rats.filter((r) => r.owner === wallet) : [],
    });
  } catch (e) {
    return fail(e, 500);
  }
}
