import { getRadar } from "@/lib/stats";
import { cached, fail } from "@/lib/http";
import { memo } from "@/lib/memo";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // v0.1.40: built at most every 5s per server instance (was on every CDN miss)
    return cached({ radar: await memo("api:radar", 5_000, () => getRadar(50)), now: Date.now() }, 5);
  } catch (e) {
    return fail(e, 500);
  }
}
