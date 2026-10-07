import { mindJudgement, mindView } from "@/lib/mind";
import { isPubkey } from "@/lib/solana";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// MIND: what it is thinking about right now, its latest calls and its record. ?mint= for one coin's judgement.
export async function GET(req: Request) {
  try {
    const mint = new URL(req.url).searchParams.get("mint");
    if (mint) {
      if (!isPubkey(mint)) return fail("bad mint");
      const j = await mindJudgement(mint);
      return cached({ judgement: j ? { ...j, lessons: [] } : null }, 5);
    }
    return cached(await mindView(), 2);
  } catch (e) {
    return fail(e, 500);
  }
}
