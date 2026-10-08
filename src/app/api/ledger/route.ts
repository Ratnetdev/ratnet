import { getRounds } from "@/lib/rounds";
import { getExports } from "@/lib/exporter";
import { getStats } from "@/lib/stats";
import { K, redis } from "@/lib/redis";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";
import { roundOf, roundStart } from "@/lib/rats";
import { ROUND_MS, FEE_SPLIT } from "@/config/site";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [rounds, burns, exports, stats] = await memo("api:ledger", 20_000, () => Promise.all([
      getRounds(),
      redis().lrange(K.burns, 0, 99),
      getExports(),
      getStats(),
    ]));
    const cur = roundOf();
    return cached({
      rounds,
      burns: burns || [],
      exports,
      stats,
      split: FEE_SPLIT,
      current: { id: cur, startsAt: roundStart(cur), endsAt: roundStart(cur) + ROUND_MS },
    }, 10);
  } catch (e) {
    return fail(e, 500);
  }
}
