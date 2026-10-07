import { getDesk } from "@/lib/desk";
import { memo } from "@/lib/memo";
import { fail } from "@/lib/http";
import { publicDesk, serve } from "@/lib/private";

export const dynamic = "force-dynamic";

// The desk. Public: without its playbook. Admin with ?full=1: everything.
export async function GET(req: Request) {
  try {
    // 2s on the CDN and no long stale window: the heartbeat and live positions must look live
    return serve(req, await memo("desk", 2_000, getDesk), publicDesk, 2, 2);
  } catch (e) {
    return fail(e, 500);
  }
}
