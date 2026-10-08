import { getGrads, getStats } from "@/lib/stats";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [grads, stats] = await memo("api:grads", 15_000, () => Promise.all([getGrads(100), getStats()]));
    return cached({ grads, bonded: stats.bonded, baseRate: stats.baseRate }, 15);
  } catch (e) {
    return fail(e, 500);
  }
}
