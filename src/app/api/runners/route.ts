import { getRunner, topRunners } from "@/lib/runner";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// Coins followed after the King's call and after bond: peak market cap, the multiple from the call, and the runner model.
export async function GET() {
  try {
    const [top, model] = await Promise.all([topRunners(30), getRunner()]);
    return cached({ top, model }, 10);
  } catch (e) {
    return fail(e, 500);
  }
}
