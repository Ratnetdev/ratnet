import { getRunner, topRunners } from "@/lib/runner";
import { cached, fail } from "@/lib/http";
import { memo } from "@/lib/memo";

export const dynamic = "force-dynamic";

// Coins followed after the King's call and after bond: peak market cap, the multiple from the call, and the runner model.
export async function GET(req: Request) {
  try {
    if (new URL(req.url).searchParams.get("fame") === "1") {
      // hall of fame: BOND calls only, best multiple from the market cap at the call
      // v0.1.68: from the top 400 runners (it took the top 80 by peak, of any verdict, so most BOND calls fell off the
      // list before the BOND filter), and never a call priced under $1,500 (a pump.fun coin starts near $4K: "$5 at
      // the call" was a broken price read, not a 90x)
      const all = await memo("api:fame", 120_000, () => topRunners(400));
      const fame = all.filter((v) => v.verdict === "BOND" && (v.x ?? 0) >= 2 && (v.cUsd ?? 0) >= 1500).sort((a, b) => (b.x ?? 0) - (a.x ?? 0));
      return cached({ fame: fame.slice(0, 24) }, 30);
    }
    const [top, model] = await memo("api:runners", 30_000, () => Promise.all([topRunners(30), getRunner()]));
    return cached({ top, model }, 10);
  } catch (e) {
    return fail(e, 500);
  }
}
