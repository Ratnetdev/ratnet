import { waitUntil } from "@vercel/functions";
import { deskSession } from "@/lib/desk";
import { dig } from "@/lib/digger";
import { historianSession } from "@/lib/historian";
import { sealDue } from "@/lib/receipts";
import { tgFlush } from "@/lib/tg";
import { isCron } from "@/lib/admin";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function session() {
  const tg = (async () => {
    // Telegram: flush the call queue a few times during the minute so calls go out within ~15s
    let sent = 0;
    for (let i = 0; i < 4; i++) {
      sent += (await tgFlush(8).catch(() => ({ sent: 0 }))).sent;
      await new Promise((r) => setTimeout(r, 12_000));
    }
    return { sent };
  })();
  const [desk, history, receipts, telegram] = await Promise.all([
    deskSession(55_000, () => dig()),
    historianSession(45_000).catch((e) => ({ history: "error", error: String(e?.message || e) })),
    sealDue().catch((e) => ({ sealed: 0, error: String(e?.message || e) })),
    tg,
  ]);
  return { desk, history, receipts, telegram };
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
