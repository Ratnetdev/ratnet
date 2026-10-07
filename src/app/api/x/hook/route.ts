import { safeEq } from "@/lib/admin";
import { redis } from "@/lib/redis";
import { ingest, noteVolume, parseHook } from "@/lib/wire";
import { fail, json } from "@/lib/http";
import { xSpend } from "@/lib/xcredits";

export const dynamic = "force-dynamic";

// twitterapi.io webhook: tracked posts arrive here within seconds. Set the webhook URL in the twitterapi.io dashboard to
// the URL shown in Admin > Setup (its key is X_HOOK_SECRET, or derived from CRON_SECRET: never the master key itself).
export async function POST(req: Request) {
  // v0.1.33: a post arriving here can make WIRE buy, so a forged one must never get in. Accepted: the X-API-Key header
  // twitterapi.io sends (your X_API_KEY), or ?key= with a secret of its own (X_HOOK_SECRET). A key derived from
  // CRON_SECRET no longer counts: CRON_SECRET is shared with the cron pinger and has been on screen.
  const own = process.env.X_HOOK_SECRET || "";
  const ok = (!!process.env.X_API_KEY && safeEq(req.headers.get("x-api-key"), process.env.X_API_KEY)) || (!!own && safeEq(new URL(req.url).searchParams.get("key"), own));
  if (!ok) {
    await redis().incr("rn:hook:x:rejected").catch(() => 0);
    return fail("unauthorized", 401);
  }
  try {
    const body = await req.json().catch(() => null);
    const tweets = parseHook(body);
    if (!tweets.length) return json({ ok: true, stored: 0 });
    await xSpend("watchlist posts", tweets.length * 15);
    await noteVolume(tweets);
    return json({ ok: true, ...(await ingest(tweets)) });
  } catch (e) {
    return fail(e, 500);
  }
}
