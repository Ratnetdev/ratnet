import { boardTop } from "@/lib/board";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// The BOARD on /desk: coins where several agent families agree right now, with each agent's stance.
export async function GET() {
  try {
    return cached(await memo("api:board", 8_000, boardTop), 8);
  } catch (e) {
    return fail(e, 500);
  }
}
