import { buyersOf, houndView } from "@/lib/hound";
import { isPubkey } from "@/lib/solana";
import { cached, fail, ipOf, json, memLimit, tooMany } from "@/lib/http";
import { wantsFull } from "@/lib/private";
import { readSite } from "@/lib/site";
import { buildBoards } from "@/lib/boards";
import { memo } from "@/lib/memo";

export const dynamic = "force-dynamic";

// HOUND: who among the tracked wallets is buying right now. ?mint= for one coin. Admin with ?full=1: the whole book.
export async function GET(req: Request) {
  try {
    const mint = new URL(req.url).searchParams.get("mint");
    const full = await wantsFull(req);
    if (mint) {
      if (!isPubkey(mint)) return fail("bad mint");
      if (!full && !memLimit(`hound:${ipOf(req)}`, 30, 60)) return tooMany();
      const b = await memo(`hound:buyers:${mint}`, 15_000, () => buyersOf(mint));
      const anon = (c: string) => c === "smart" || c === "admin"; // v0.1.46: your own wallets are hidden too
      const out = b.map((x: any) => (full ? x : { ...x, w: anon(x.cls) ? "" : x.w, name: anon(x.cls) ? (x.cls === "smart" ? "smart wallet" : "tracked wallet") : x.name }));
      return full ? json({ buyers: out }) : cached({ buyers: out }, 5);
    }
    if (full) return json(await houndView(true));
    // v0.1.40: the public view comes from the worker's board summary (it holds HOUND's wallet book in memory)
    // (same builder as /api/boards: the two share one cached copy)
    const b = await readSite<any>("boards", 10_000, 180_000, buildBoards);
    return cached(b?.hound ?? (await houndView(false)), 8);
  } catch (e) {
    return fail(e, 500);
  }
}
