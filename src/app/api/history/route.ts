import { getHistory } from "@/lib/historian";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// What the HISTORIAN has replayed so far, and the prequential backtest (scored before learning each launch).
export async function GET() {
  try {
    return cached(await memo("api:history", 15_000, getHistory), 15);
  } catch (e) {
    return fail(e, 500);
  }
}
