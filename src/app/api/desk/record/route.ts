import { getRecord } from "@/lib/desk";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// The desk's full public track record: every round trip, entry to exit. ?book=ghost for the ghost desk.
export async function GET(req: Request) {
  try {
    const book = new URL(req.url).searchParams.get("book") === "ghost" ? "ghost" : "real";
    return cached(await getRecord(undefined, book), 5);
  } catch (e) {
    return fail(e, 500);
  }
}
