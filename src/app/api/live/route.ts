import { buildLive } from "@/lib/pages";
import { readSite } from "@/lib/site";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// Polled by every open page. v0.1.41: the worker builds it every ~10s (lib/pages.ts); a server instance reads that
// one key at most every 8s, and builds it itself only when the worker's copy is missing or old.
export async function GET() {
  try {
    return cached(await readSite("live", 8_000, 60_000, buildLive), 8);
  } catch (e) {
    return fail(e, 500);
  }
}
