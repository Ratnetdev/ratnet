import { wireViewPublic } from "@/lib/wire";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// WIRE: latest tracked posts, the coin picked for each, and the account board.
export async function GET() {
  try {
    return cached(await wireViewPublic(), 15);
  } catch (e) {
    return fail(e, 500);
  }
}
