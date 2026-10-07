import { getRatBoard } from "@/lib/stats";
import { getRounds } from "@/lib/rounds";
import { getEcon } from "@/lib/fees";
import { allPups, priceFor } from "@/lib/rats";
import { getSettings } from "@/lib/settings";
import { cached, fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const wallet = new URL(req.url).searchParams.get("wallet") || "";
    const [board, rounds, econ, pups, myPrice] = await Promise.all([
      getRatBoard(),
      getRounds().catch(() => []),
      getEcon().catch(() => null),
      allPups().catch(() => []),
      wallet ? getSettings().then((st) => priceFor("spawn", wallet, st)) : Promise.resolve(null),
    ]);
    const lr = rounds[0];
    const paid = rounds.reduce((a, r) => a + (r.ownersSol || 0), 0);
    const { settings, ...rest } = board;
    const body = {
      ...rest,
      costs: { spawn: settings.spawnCost, repeat: Math.round(settings.spawnCost * (1 - (settings.repeatOff ?? 0))), pup: settings.pupCost, pupMax: settings.pupMax, sniff: settings.sniffCost, minWork: settings.minWork },
      myPrice,
      pups: pups.map((x) => ({ name: x.name, owner: x.owner, parent: x.parent, spawnedAt: x.spawnedAt, earnedSol: x.earnedSol })),
      minePups: wallet ? pups.filter((x) => x.owner === wallet) : [],
      live: !!settings.mint,
      mint: settings.mint || null,
      lastRound: lr ? { id: lr.id, ownersSol: lr.ownersSol, eligible: lr.eligible, perRat: lr.eligible ? lr.ownersSol / lr.eligible : 0, status: lr.status } : null,
      paidTotal: paid,
      econ,
      mine: wallet ? board.rats.filter((r) => r.owner === wallet) : [],
    };
    return wallet ? json(body) : cached(body, 5);
  } catch (e) {
    return fail(e, 500);
  }
}
