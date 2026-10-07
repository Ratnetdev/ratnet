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
  // the worker process is up: it runs everything itself and restarts itself when a loop hangs (watchdog). Before
  // v0.1.25 this ping also took over whenever the desk beat was late (a 429 storm, a long swap), and then a whole
  // second system ran on Vercel next to the worker, making the storm worse and risking two desks.
  const [w, lockHeld] = await Promise.all([redis().get("rn:worker:at"), redis().exists("rn:lock:desk")]);
  if (Date.now() - Number(w || 0) < 90_000) return json({ ok: true, worker: "on" });
  if (lockHeld) return json({ ok: true, desk: "locked by a running desk" });
  await redis().incr("rn:takeover:n").catch(() => 0);
  await redis().set("rn:takeover:at", Date.now()).catch(() => null);
  if (new URL(req.url).searchParams.get("wait") === "1") return json(await runSession());
  waitUntil(runSession().catch(() => null));
  return json({ ok: true, started: new Date().toISOString() });
}
