import { deskSession } from "@/lib/desk";
import { dig } from "@/lib/digger";
import { historianSession } from "@/lib/historian";
import { isCron } from "@/lib/admin";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Ping every minute (cron-job.org). Runs the desk for ~55s: positions re-read every 2s,
// the rats dig every 10s inside the same session, and the HISTORIAN replays past launches alongside.
export async function GET(req: Request) {
  if (!isCron(req)) return fail("unauthorized", 401);
  const [desk, history] = await Promise.all([deskSession(55_000, () => dig()), historianSession(45_000).catch((e) => ({ history: "error", error: String(e?.message || e) }))]);
  return json({ desk, history });
}
