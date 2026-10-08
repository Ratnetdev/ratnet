import { getRunner, topRunners } from "@/lib/runner";
import { cached, fail } from "@/lib/http";
import { memo } from "@/lib/memo";

export const dynamic = "force-dynamic";

// Coins followed after the King's call and after bond: peak market cap, the multiple from the call, and the runner model.
export async function GET(req: Request) {
  try {
    if (new URL(req.url).searchParams.get("fame") === "1") {
      // hall of fame: BOND calls only, best multiple from the market cap at the call
      const all = await memo("api:fame", 120_000, () => topRunners(80));
      return cached({ fame: all.filter((v) => v.verdict === "BOND" && (v.x ?? 0) >= 2).slice(0, 24) }, 30);
    }
    const [top, model] = await memo("api:runners", 30_000, () => Promise.all([topRunners(30), getRunner()]));
    return cached({ top, model }, 10);
  } catch (e) {
    return fail(e, 500);
  }
}
