import { getRecord, VET_KEY } from "@/lib/desk";
import { coinLog } from "@/lib/agents";
import { isPubkey } from "@/lib/solana";
import { redis } from "@/lib/redis";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// What the desk did on one coin: every trade with its full context, the last VET verdict, every agent line.
export async function GET(req: Request) {
  try {
    const mint = new URL(req.url).searchParams.get("mint") || "";
    if (!isPubkey(mint)) return fail("bad mint");
    const [rec, log, vet] = await Promise.all([getRecord(mint), coinLog(mint), redis().get(VET_KEY(mint))]);
    return cached({ trips: rec.trips, live: rec.live, log, vet: vet || null }, 4);
  } catch (e) {
    return fail(e, 500);
  }
}
