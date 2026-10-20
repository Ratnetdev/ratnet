import { redis } from "@/lib/redis";
import { FILLS_LOG, ORDERS_KEY, type FillRec } from "@/lib/desk";
import { fillSummary } from "@/lib/proof";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// v0.1.138 FILL LEDGER: every GRID buy, signal to landed, and the fill against the price at the signal
export async function GET() {
  try {
    const [fs, orders] = await memo("api:fills", 10_000, async () => Promise.all([(await redis().lrange<FillRec>(FILLS_LOG, 0, 499).catch(() => [])) || [], redis().get<any>(ORDERS_KEY).catch(() => null)]));
    // v0.1.140: every GRID order the desk received: bought, or why it was skipped
    return cached({ summary: fillSummary(fs), orders, fills: fs.slice(0, 100) }, 10);
  } catch (e) {
    return fail(e, 500);
  }
}
