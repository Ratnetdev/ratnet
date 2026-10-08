import { getCoin } from "@/lib/stats";
import { isPubkey } from "@/lib/solana";
import { memo } from "@/lib/memo";
import { cached, fail, ipOf, memLimit, tooMany } from "@/lib/http";
import { publicCall } from "@/lib/private";

export const dynamic = "force-dynamic";

export async function GET(req: Request, props: { params: Promise<{ mint: string }> }) {
  const params = await props.params;
  if (!isPubkey(params.mint)) return fail("Not a valid CA");
  if (!memLimit(`coin:${ipOf(req)}`, 60, 60)) return tooMany();
  try {
    const { launch, call, mkt, run } = await memo(`api:coin:${params.mint}`, 5_000, () => getCoin(params.mint));
    if (!launch && !call) return fail("The rats have not dug this coin", 404);
    return cached({ launch, call: publicCall(call), mkt, run }, 5);
  } catch (e) {
    return fail(e, 500);
  }
}
