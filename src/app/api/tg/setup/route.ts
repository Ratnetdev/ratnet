import { setupHook } from "@/lib/tgbot";
import { isCron } from "@/lib/admin";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Open once after deploy: points your bot's webhook at this site so /yes, /no and the other commands work.
export async function GET(req: Request) {
  if (!isCron(req)) return fail("unauthorized", 401);
  return json(await setupHook());
}
