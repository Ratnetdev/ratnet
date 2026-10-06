import { getRecord } from "@/lib/desk";
import { fail } from "@/lib/http";
import { publicTrip, serve } from "@/lib/private";

export const dynamic = "force-dynamic";

// The desk's full public track record: every round trip, entry to exit. ?book=ghost for the ghost desk.
export async function GET(req: Request) {
  try {
    const book = new URL(req.url).searchParams.get("book") === "ghost" ? "ghost" : "real";
    return serve(req, await getRecord(undefined, book), (d: any) => ({ ...d, trips: d.trips.map(publicTrip) }), 5);
  } catch (e) {
    return fail(e, 500);
  }
}
