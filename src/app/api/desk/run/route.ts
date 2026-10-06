import { waitUntil } from "@vercel/functions";
import { deskSession } from "@/lib/desk";
import { dig } from "@/lib/digger";
import { historianSession } from "@/lib/historian";
import { isCron } from "@/lib/admin";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function session() {
  const [desk, history] = await Promise.all([
    deskSession(55_000, () => dig()),
    historianSession(45_000).catch((e) => ({ history: "error", error: String(e?.message || e) })),
  ]);
  return { desk, history };
}

// Ping every minute (cron-job.org). The ping gets an answer right away, and the work keeps running in the
// background for ~55s: positions re-read every 2s, the rats dig every 10s, the HISTORIAN replays the past.
// Answering fast means pingers with short timeouts never mark the job as failed. Add &wait=1 to see the result.
export async function GET(req: Request) {
  if (!isCron(req)) return fail("unauthorized", 401);
  if (new URL(req.url).searchParams.get("wait") === "1") return json(await session());
  waitUntil(session().catch(() => null));
  return json({ ok: true, started: new Date().toISOString() });
}
