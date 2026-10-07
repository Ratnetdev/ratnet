import { getHour, getSeals, memoOnChain } from "@/lib/receipts";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// Hourly call receipts. ?hour=2026-10-06T19 returns that hour's call list and seal; &chain=1 also reads the memo
// back from the chain so the check does not depend on this server.
export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams;
    const hour = q.get("hour");
    if (hour) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hour)) return fail("bad hour");
      const h = await getHour(hour);
      const memo = q.get("chain") === "1" && h.seal?.sig ? await memoOnChain(h.seal.sig) : null;
      return cached({ ...h, chainMemo: memo }, 30);
    }
    return cached({ seals: await getSeals(72) }, 20);
  } catch (e) {
    return fail(e, 500);
  }
}
