import { syncRules } from "@/lib/wire";
import { isAdmin, isCron } from "@/lib/admin";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Push the WIRE watchlist to twitterapi.io now: /api/x/sync?key=<CRON_SECRET>
export async function GET(req: Request) {
  if (!isCron(req) && !isAdmin()) return fail("unauthorized", 401);
  try {
    return json(await syncRules(true));
  } catch (e) {
    return fail(e, 500);
  }
}
