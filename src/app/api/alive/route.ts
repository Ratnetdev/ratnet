import { aliveView, rpcLive } from "@/lib/alive";
import { xSpendView } from "@/lib/xcredits";
import { rpcDayView } from "@/lib/rpcday";
import { redis } from "@/lib/redis";
import { memo } from "@/lib/memo";
import { cached, fail, json } from "@/lib/http";
import { isAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// Every loop and agent: when it last finished a pass, and whether it is stalled. Plus the RPC limiter's last minute,
// chain reads per day, X credits and the worker's restarts. Counts only, never secrets.
export async function GET() {
  try {
    const out = await memo("api:alive", 5_000, build);
    // v0.1.46: the Redis bandwidth figures are for the admin only (they show how much traffic it takes to push the
    // database over its plan); the admin's answer is never shared through the CDN cache
    if (await isAdmin()) return json({ ...out, bw: await memo("api:alive:bw", 5_000, bwView) });
    return cached({ ...out, bw: null }, 5);
  } catch (e) {
    return fail(e, 500);
  }
}

async function bwView() {
  const bw = await redis().get<any>("rn:bw").catch(() => null);
  return bw ? { at: bw.at, hourMB: bw.hourMB, gov: bw.gov ?? null } : null;
}

async function build() {
  {
    const r = redis();
    const rpcP = rpcLive();
    const [parts, rpc, x, day, boots, bootAt, exits, takeovers, takeoverAt, reconnects, streamNote, streamShapes, xRejected] = await Promise.all([
      aliveView(),
      rpcP,
      xSpendView().catch(() => null),
      rpcP.then((rp: any) => rpcDayView(Number(rp?.perSec ?? 0))).catch(() => null),
      r.get<number>("rn:worker:boots"),
      r.get<number>("rn:worker:bootAt"),
      r.lrange<{ at: number; why: string }>("rn:worker:exits", 0, 4),
      r.get<number>("rn:takeover:n"),
      r.get<number>("rn:takeover:at"),
      r.get<number>("rn:stream:reconnects"),
      r.get<{ at: number; text: string }>("rn:stream:note"),
      r.get<{ at: number; shapes: [string, number][] }>("rn:stream:shapes"),
      r.get<number>("rn:hook:x:rejected"),
    ]);
    const worker = { boots: Number(boots || 0), bootAt: Number(bootAt || 0) || null, exits: exits || [], takeovers: Number(takeovers || 0), takeoverAt: Number(takeoverAt || 0) || null, streamReconnects: Number(reconnects || 0), streamNote: streamNote || null, streamShapes: streamShapes || null, xHookRejected: Number(xRejected || 0) };
    return { parts, rpc: rpc || null, x, rpcDay: day, worker };
  }
}
