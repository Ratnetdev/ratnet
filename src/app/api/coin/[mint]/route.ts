import { getCoin } from "@/lib/stats";
import { isPubkey } from "@/lib/solana";
import { cached, fail } from "@/lib/http";
import { publicCall } from "@/lib/private";

export const dynamic = "force-dynamic";

export async function GET(_: Request, props: { params: Promise<{ mint: string }> }) {
  const params = await props.params;
  if (!isPubkey(params.mint)) return fail("Not a valid CA");
  try {
    const { launch, call, mkt, run } = await getCoin(params.mint);
    if (!launch && !call) return fail("The rats have not dug this coin", 404);
    return cached({ launch, call: publicCall(call), mkt, run }, 5);
  } catch (e) {
    return fail(e, 500);
  }
}
