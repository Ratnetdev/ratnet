import { waitUntil } from "@vercel/functions";
import { deskSession } from "@/lib/desk";
import { dig } from "@/lib/digger";
import { historianSession } from "@/lib/historian";
import { sealDue } from "@/lib/receipts";
import { tgFlush } from "@/lib/tg";
import { curate, ingest, syncRules } from "@/lib/wire";
import { j7Accounts, j7Session } from "@/lib/j7";
import { pulseTick } from "@/lib/pulse";
import { lensSession } from "@/lib/lens";
import { mindSession } from "@/lib/mind";
import { houndSession } from "@/lib/hound";
import { momoScan } from "@/lib/momo";
import { overseerSession } from "@/lib/overseer";
import { agentLog } from "@/lib/agents";
import { redis } from "@/lib/redis";
import { X_SEED } from "@/config/x-accounts";
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
  // WIRE: grow and prune the account list, push it to twitterapi.io when it changed (at most every 10 minutes)
  const wire = (async () => {
    const changes = await curate().catch(() => []);
    const mins = new Date().getUTCMinutes();
    // J7: make sure it watches its whole free pool and our list (hourly), then twitterapi.io pays only for the rest
    const j7acc = await j7Accounts(X_SEED.map((x) => x.h)).catch((e) => ({ error: String(e?.message || e) }));
    const synced = mins % 10 === 0 ? await syncRules().catch((e) => ({ synced: false, error: String(e?.message || e) })) : null;
    // PULSE: rebuild the rising narratives and announce new ones
    const fresh = await pulseTick().catch(() => []);
    if (fresh.length) {
      const p = redis().pipeline();
      agentLog(p, fresh.map((x) => ({ agent: "PULSE", at: Date.now(), text: `rising on X: "${x.term}" at ${x.x}x its usual pace (${x.posts15} weighted posts in 15m), mood ${x.mood}`, tone: x.mood === "bearish" ? "bad" : "ok" })));
      await p.exec();
    }
    return { changes, j7acc, synced, rising: fresh.map((x) => x.term) };
  })();
  // J7 live feed for the whole minute run: posts land in WIRE within moments
  const j7 = j7Session(52_000, (t) => ingest(t)).catch((e) => ({ on: true, error: String(e?.message || e) }));
  // LENS: hands-on looks at the coins that matter (website, X, who is talking, Telegram), streamed to the LensCam
  // MIND: the trader's mind judges the coins that matter, follows its calls, does post-mortems and goes to school
  // HOUND: FOMO traders, KOL wallets, smart wallets from breakouts, the live webhook. OVERSEER: explore and propose
  // MOMO: coins pulling real volume right now (GeckoTerminal), straight to the desk
  const momo = momoScan().catch((e) => ({ momo: "error", error: String(e?.message || e) }));
  const hound = houndSession().catch((e) => ({ hound: "error", error: String(e?.message || e) }));
  const overseer = overseerSession(50_000).catch((e) => ({ overseer: "error", error: String(e?.message || e) }));
  const mind = mindSession(54_000).catch((e) => ({ mind: "error", error: String(e?.message || e) }));
  const lens = lensSession(52_000).catch((e) => ({ lens: "error", error: String(e?.message || e) }));
  const [desk, history, receipts, telegram, x] = await Promise.all([
    deskSession(55_000, () => dig()),
    historianSession(45_000).catch((e) => ({ history: "error", error: String(e?.message || e) })),
    sealDue().catch((e) => ({ sealed: 0, error: String(e?.message || e) })),
    tg,
    wire,
  ]);
  return { desk, history, receipts, telegram, wire: x, j7: await j7, lens: await lens, mind: await mind, hound: await hound, overseer: await overseer, momo: await momo };
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
