import { proofView } from "@/lib/proof";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// v0.1.138 PROOF BOARD: the live desk against its paper twin, its fill speed, the King's record
export async function GET() {
  try {
    return cached(await memo("api:proof", 20_000, () => proofView()), 15);
  } catch (e) {
    return fail(e, 500);
  }
}
