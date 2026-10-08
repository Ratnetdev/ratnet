import { buildCoins } from "@/lib/pages";
import { readSite } from "@/lib/site";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// Every coin the King or nano liked in the last 24h, plus every coin that bonded. Filtered client-side.
// v0.1.41: built by the worker once a minute (lib/pages.ts); read here at most once a minute per server instance.
export async function GET() {
  try {
    return cached(await readSite("coins", 60_000, 180_000, buildCoins), 30);
  } catch (e) {
    return fail(e, 500);
  }
}
