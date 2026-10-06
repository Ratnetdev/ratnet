import { getCoin } from "@/lib/stats";
import { isPubkey } from "@/lib/solana";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: { mint: string } }) {
  if (!isPubkey(params.mint)) return fail("Not a valid CA");
  try {
    const { launch, call } = await getCoin(params.mint);
    if (!launch && !call) return fail("The rats have not dug this coin", 404);
    return cached({ launch, call }, 5);
  } catch (e) {
    return fail(e, 500);
  }
}
