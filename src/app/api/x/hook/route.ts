import { ingest, parseHook } from "@/lib/wire";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// twitterapi.io webhook: tracked posts arrive here within seconds. Set the webhook URL in the twitterapi.io dashboard to
// https://www.ratnet.network/api/x/hook?key=<X_HOOK_SECRET or CRON_SECRET>
export async function POST(req: Request) {
  const key = new URL(req.url).searchParams.get("key") || "";
  const secret = process.env.X_HOOK_SECRET || process.env.CRON_SECRET || "";
  const hdr = req.headers.get("x-api-key") || "";
  if (!secret || (key !== secret && hdr !== process.env.X_API_KEY)) return fail("unauthorized", 401);
  try {
    const body = await req.json().catch(() => null);
    const tweets = parseHook(body);
    if (!tweets.length) return json({ ok: true, stored: 0 });
    return json({ ok: true, ...(await ingest(tweets)) });
  } catch (e) {
    return fail(e, 500);
  }
}
