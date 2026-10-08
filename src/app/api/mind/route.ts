import { mindJudgement, mindView } from "@/lib/mind";
import { isPubkey } from "@/lib/solana";
import { memo } from "@/lib/memo";
import { cached, fail, ipOf, memLimit, tooMany } from "@/lib/http";

export const dynamic = "force-dynamic";

// MIND: what it is thinking about right now, its latest calls and its record. ?mint= for one coin's judgement.
export async function GET(req: Request) {
  try {
    const mint = new URL(req.url).searchParams.get("mint");
    if (mint) {
      if (!isPubkey(mint)) return fail("bad mint");
      if (!memLimit(`mind:${ipOf(req)}`, 30, 60)) return tooMany();
      const j = await memo(`api:mind:${mint}`, 10_000, () => mindJudgement(mint));
      return cached({ judgement: j ? { ...j, lessons: [] } : null }, 5);
    }
    return cached(await memo("api:mind", 10_000, mindView), 10);
  } catch (e) {
    return fail(e, 500);
  }
}
