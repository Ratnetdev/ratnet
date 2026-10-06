import { getRecord } from "@/lib/desk";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// The desk's full public track record: every round trip, entry to exit.
export async function GET() {
  try {
    return cached(await getRecord(), 5);
  } catch (e) {
    return fail(e, 500);
  }
}
