import { boardTop } from "@/lib/board";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// The BOARD on /desk: coins where several agent families agree right now, with each agent's stance.
export async function GET() {
  try {
    return cached(await boardTop(), 4);
  } catch (e) {
    return fail(e, 500);
  }
}
