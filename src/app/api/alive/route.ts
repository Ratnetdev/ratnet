import { aliveView } from "@/lib/alive";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// Every loop and agent: when it last finished a pass, and whether it is stalled.
export async function GET() {
  try {
    return cached({ parts: await aliveView() }, 3);
  } catch (e) {
    return fail(e, 500);
  }
}
