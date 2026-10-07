import { dig } from "@/lib/digger";
import { isCron } from "@/lib/admin";
import { fail, ipOf, json, limit, tooMany } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST: heartbeat from open pages (lock-protected, one run at a time).
// GET with ?key=CRON_SECRET: external pinger that keeps the rats digging 24/7.
// Pages only nudge: the answer is a bare ok (no internals), and one IP can nudge at most 6 times a minute.
export async function POST(req: Request) {
  if (!(await limit(`dig:${ipOf(req)}`, 6, 60))) return tooMany();
  const r = await dig();
  return json({ ok: (r as any)?.ok !== false });
}

export async function GET(req: Request) {
  if (!isCron(req)) return fail("unauthorized", 401);
  return json(await dig());
}
