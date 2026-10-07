import { getGrads, getStats } from "@/lib/stats";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [grads, stats] = await Promise.all([getGrads(100), getStats()]);
    return cached({ grads, bonded: stats.bonded, baseRate: stats.baseRate }, 5);
  } catch (e) {
    return fail(e, 500);
  }
}
