import { getAgent } from "@/lib/agents";
import { cached, fail } from "@/lib/http";
import { publicEv, publicEvs } from "@/lib/private";

export const dynamic = "force-dynamic";
const NAMES = ["HISTORIAN", "SCOUT", "KING", "TAPE", "GRAPH", "VET", "FLOW", "BUZZ", "SIZE", "EXEC", "RISK", "COACH", "LEDGER", "FILM", "WIRE", "PM", "PULSE", "LENS", "MIND", "HOUND", "OVERSEER", "MOMO", "CATCH", "SHIELD"];

// One agent's history and counters, for the agent panel on /desk.
export async function GET(req: Request) {
  try {
    const name = String(new URL(req.url).searchParams.get("name") || "").toUpperCase();
    if (!NAMES.includes(name)) return fail("Unknown agent", 400);
    const a = await getAgent(name);
    return cached({ ...a, last: a.last ? publicEv(a.last) : null, history: publicEvs(a.history) }, 5);
  } catch (e) {
    return fail(e, 500);
  }
}
