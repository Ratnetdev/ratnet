import { dig } from "@/lib/digger";
import { isCron } from "@/lib/admin";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST: old pages used to nudge a dig here every 15s. That ran a second dig on Vercel next to the worker (v0.1.25
// removed it); the answer stays a bare ok so a page still open from before the update does no harm.
export async function POST() {
  return json({ ok: true });
}

// GET with the cron key: an outside pinger can still keep the rats digging when the worker is down. dig() steps aside
// by itself while the worker is alive.
export async function GET(req: Request) {
  if (!isCron(req)) return fail("unauthorized", 401);
  return json(await dig());
}
