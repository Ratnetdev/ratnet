import { getRadar } from "@/lib/stats";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return cached({ radar: await getRadar(50), now: Date.now() }, 3);
  } catch (e) {
    return fail(e, 500);
  }
}
