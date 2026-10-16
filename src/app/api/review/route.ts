import { reviewView } from "@/lib/review";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// v0.1.97: the daily review's numbers, live (counts and results only, never secrets)
export async function GET() {
  try {
    return cached(await memo("api:review", 60_000, () => reviewView()), 60);
  } catch (e) {
    return fail(e, 500);
  }
}
