import { waitUntil } from "@vercel/functions";
import { runSession } from "@/lib/session";
import { redis } from "@/lib/redis";
import { isCron } from "@/lib/admin";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Ping every minute (cron-job.org). The ping gets an answer right away, and the work keeps running in the
// background for ~55s. When the always-on worker is running (worker/index.ts), it does the work without gaps and
// this ping steps aside. Add &wait=1 to see the result.
export async function GET(req: Request) {
  if (!isCron(req)) return fail("unauthorized", 401);
  // step aside only while the desk itself is beating (not just while some worker process is alive): if the worker
  // hangs, this ping takes the desk over within a minute. The desk lock keeps two desks from ever trading at once.
  const beat = Number((await redis().get("rn:desk:beat")) || 0);
  const w = Number((await redis().get("rn:worker:at")) || 0);
  if (Date.now() - w < 90_000 && Date.now() - beat < 60_000) return json({ ok: true, worker: "on", deskBeat: new Date(beat).toISOString() });
  if (new URL(req.url).searchParams.get("wait") === "1") return json(await runSession());
  waitUntil(runSession().catch(() => null));
  return json({ ok: true, started: new Date().toISOString() });
}
