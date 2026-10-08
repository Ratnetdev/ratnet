import { lensDossier, lensView } from "@/lib/lens";
import { isPubkey } from "@/lib/solana";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// LENS live view (what it is looking at right now) or one coin's dossier (?mint=).
export async function GET(req: Request) {
  try {
    const mint = new URL(req.url).searchParams.get("mint");
    if (mint) {
      if (!isPubkey(mint)) return fail("bad mint");
      return cached({ dossier: await memo(`api:lens:${mint}`, 10_000, () => lensDossier(mint)) }, 10);
    }
    return cached(await memo("api:lens", 5_000, lensView), 5);
  } catch (e) {
    return fail(e, 500);
  }
}
