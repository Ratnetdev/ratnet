import { getHistory } from "@/lib/historian";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// What the HISTORIAN has replayed so far, and the prequential backtest (scored before learning each launch).
export async function GET() {
  try {
    return cached(await getHistory(), 15);
  } catch (e) {
    return fail(e, 500);
  }
}
