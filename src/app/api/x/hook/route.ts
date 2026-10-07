import { safeEq, secretFor } from "@/lib/admin";
import { ingest, parseHook } from "@/lib/wire";
import { fail, json } from "@/lib/http";
import { xSpend } from "@/lib/xcredits";

export const dynamic = "force-dynamic";

// twitterapi.io webhook: tracked posts arrive here within seconds. Set the webhook URL in the twitterapi.io dashboard to
// the URL shown in Admin > Setup (its key is X_HOOK_SECRET, or derived from CRON_SECRET: never the master key itself).
export async function POST(req: Request) {
  const secret = secretFor("x-hook");
  const ok = (!!secret && safeEq(new URL(req.url).searchParams.get("key"), secret)) || (!!process.env.X_API_KEY && safeEq(req.headers.get("x-api-key"), process.env.X_API_KEY));
  if (!ok) return fail("unauthorized", 401);
  try {
    const body = await req.json().catch(() => null);
    const tweets = parseHook(body);
    if (!tweets.length) return json({ ok: true, stored: 0 });
    await xSpend("watchlist posts", tweets.length * 15);
    return json({ ok: true, ...(await ingest(tweets)) });
  } catch (e) {
    return fail(e, 500);
  }
}
