import { getMarket } from "@/lib/market";
import { isPubkey } from "@/lib/solana";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// GET /api/market?m=CA1,CA2,... (max 60)
export async function GET(req: Request) {
  try {
    const m = (new URL(req.url).searchParams.get("m") || "").split(",").filter(isPubkey).slice(0, 60);
    return cached({ market: await getMarket(m) }, 20);
  } catch (e) {
    return fail(e, 500);
  }
}
