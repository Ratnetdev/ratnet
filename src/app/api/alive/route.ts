import { aliveView, rpcLive } from "@/lib/alive";
import { xSpendView } from "@/lib/xcredits";
import { rpcDayView } from "@/lib/rpcday";
import { redis } from "@/lib/redis";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// Every loop and agent: when it last finished a pass, and whether it is stalled. Plus the RPC limiter's last minute,
// chain reads per day, X credits and the worker's restarts. Counts only, never secrets.
export async function GET() {
  try {
    const r = redis();
    const [parts, rpc, x, day, boots, bootAt, exits, takeovers, takeoverAt, reconnects] = await Promise.all([
      aliveView(),
      rpcLive(),
      xSpendView().catch(() => null),
      rpcDayView().catch(() => null),
      r.get<number>("rn:worker:boots"),
      r.get<number>("rn:worker:bootAt"),
      r.lrange<{ at: number; why: string }>("rn:worker:exits", 0, 4),
      r.get<number>("rn:takeover:n"),
      r.get<number>("rn:takeover:at"),
      r.get<number>("rn:stream:reconnects"),
    ]);
    const worker = { boots: Number(boots || 0), bootAt: Number(bootAt || 0) || null, exits: exits || [], takeovers: Number(takeovers || 0), takeoverAt: Number(takeoverAt || 0) || null, streamReconnects: Number(reconnects || 0) };
    return cached({ parts, rpc: rpc || null, x, rpcDay: day, worker }, 3);
  } catch (e) {
    return fail(e, 500);
  }
}
