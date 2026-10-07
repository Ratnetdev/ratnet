import { lensDossier, lensView } from "@/lib/lens";
import { isPubkey } from "@/lib/solana";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// LENS live view (what it is looking at right now) or one coin's dossier (?mint=).
export async function GET(req: Request) {
  try {
    const mint = new URL(req.url).searchParams.get("mint");
    if (mint) {
      if (!isPubkey(mint)) return fail("bad mint");
      return cached({ dossier: await lensDossier(mint) }, 5);
    }
    return cached(await lensView(), 1);
  } catch (e) {
    return fail(e, 500);
  }
}
