import { getDesk } from "@/lib/desk";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return cached(await getDesk(), 3);
  } catch (e) {
    return fail(e, 500);
  }
}
