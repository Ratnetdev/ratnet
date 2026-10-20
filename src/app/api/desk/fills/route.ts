import { redis } from "@/lib/redis";
import { FILLS_LOG, type FillRec } from "@/lib/desk";
import { fillSummary } from "@/lib/proof";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// v0.1.138 FILL LEDGER: every GRID buy, signal to landed, and the fill against the price at the signal
export async function GET() {
  try {
    const fs = await memo("api:fills", 10_000, async () => (await redis().lrange<FillRec>(FILLS_LOG, 0, 499).catch(() => [])) || []);
    return cached({ summary: fillSummary(fs), fills: fs.slice(0, 100) }, 10);
  } catch (e) {
    return fail(e, 500);
  }
}
