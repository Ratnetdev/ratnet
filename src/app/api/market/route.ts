import { getMarket } from "@/lib/market";
import { isPubkey } from "@/lib/solana";
import { cached, fail, ipOf, limit, tooMany } from "@/lib/http";

export const dynamic = "force-dynamic";

// GET /api/market?m=CA1,CA2,... (max 60)
export async function GET(req: Request) {
  try {
    // v0.1.100 (audit): every new set of addresses reached DexScreener and wrote Redis: 60 requests a minute per IP
    if (!(await limit(`market:${ipOf(req)}`, 60, 60))) return tooMany();
    const m = (new URL(req.url).searchParams.get("m") || "").split(",").filter(isPubkey).slice(0, 60);
    return cached({ market: await getMarket(m) }, 20);
  } catch (e) {
    return fail(e, 500);
  }
}
