import { getProof } from "@/lib/stats";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return cached(await memo("api:proof", 60_000, getProof), 30);
  } catch (e) {
    return fail(e, 500);
  }
}
