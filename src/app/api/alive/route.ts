import { aliveView, rpcLive } from "@/lib/alive";
import { xSpendView } from "@/lib/xcredits";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// Every loop and agent: when it last finished a pass, and whether it is stalled. Plus the RPC limiter's last minute.
export async function GET() {
  try {
    const [parts, rpc, x] = await Promise.all([aliveView(), rpcLive(), xSpendView().catch(() => null)]);
    return cached({ parts, rpc: rpc || null, x }, 3);
  } catch (e) {
    return fail(e, 500);
  }
}
