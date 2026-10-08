import { buyersOf, houndView } from "@/lib/hound";
import { isPubkey } from "@/lib/solana";
import { cached, fail, json } from "@/lib/http";
import { wantsFull } from "@/lib/private";

export const dynamic = "force-dynamic";

// HOUND: who among the tracked wallets is buying right now. ?mint= for one coin. Admin with ?full=1: the whole book.
export async function GET(req: Request) {
  try {
    const mint = new URL(req.url).searchParams.get("mint");
    const full = await wantsFull(req);
    if (mint) {
      if (!isPubkey(mint)) return fail("bad mint");
      const b = await buyersOf(mint);
      const out = b.map((x: any) => (full ? x : { ...x, w: x.cls === "smart" ? "" : x.w, name: x.cls === "smart" ? "smart wallet" : x.name }));
      return full ? json({ buyers: out }) : cached({ buyers: out }, 5);
    }
    const v = await houndView(full);
    return full ? json(v) : cached(v, 3);
  } catch (e) {
    return fail(e, 500);
  }
}
