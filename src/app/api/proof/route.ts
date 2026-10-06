import { getProof } from "@/lib/stats";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return cached(await getProof(), 30);
  } catch (e) {
    return fail(e, 500);
  }
}
