import { dig } from "@/lib/digger";
import { isCron } from "@/lib/admin";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST: heartbeat from open pages (lock-protected, one run at a time).
// GET with ?key=CRON_SECRET: external pinger that keeps the rats digging 24/7.
export async function POST() {
  return json(await dig());
}

export async function GET(req: Request) {
  if (!isCron(req)) return fail("unauthorized", 401);
  return json(await dig());
}
