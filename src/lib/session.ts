// The whole protocol in one run: the desk loop, the rats, WIRE and J7, PULSE, LENS, MIND, HOUND, MOMO, OVERSEER,
// the historian, receipts and Telegram. Called by the minute ping (/api/desk/run) and by the always-on worker.
import { deskSession } from "./desk";
import { dig } from "./digger";
import { historianSession } from "./historian";
import { sealDue } from "./receipts";
import { tgFlush } from "./tg";
import { curate, ingest, syncRules } from "./wire";
import { j7Accounts, j7Session } from "./j7";
import { pulseTick } from "./pulse";
import { lensSession } from "./lens";
import { mindSession } from "./mind";
import { houndSession } from "./hound";
import { momoScan } from "./momo";
import { catchSession } from "./catcher";
import { overseerSession } from "./overseer";
import { agentLog } from "./agents";
import { redis } from "./redis";
import { lane } from "./solana";
import { alive } from "./alive";
import { X_SEED } from "@/config/x-accounts";


/** A part of the session that runs past its time is left behind (it finishes on its own) so the loop never stalls. */
function within<T>(p: Promise<T>, ms: number, label: string): Promise<T | { timeout: string }> {
  return Promise.race([p, new Promise<{ timeout: string }>((res) => setTimeout(() => res({ timeout: `${label} ran past ${Math.round(ms / 1000)}s` }), ms))]);
}

/** One run of every agent. `ms` is how long the desk loop stays on (55s from the minute ping). The worker runs the
 * desk in its own loop (desk: false here), so the agents' minute never holds the desk back. */
export async function runSession(ms = 55_000, opts: { desk?: boolean; historian?: boolean } = {}) {
  // every agent below reads the chain in the agents' lane (behind the desk and the rats, see lib/solana.ts)
  const ag = <T,>(f: () => Promise<T>) => lane.run(2, f);
  const withDesk = opts.desk !== false;
  const k = ms / 55_000;
  const tg = (async () => {
    // Telegram: flush the call queue a few times during the minute so calls go out within ~15s
    let sent = 0;
    for (let i = 0; i < Math.max(4, Math.round(4 * k)); i++) {
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
  const j7 = alive("j7", j7Session(Math.round(52_000 * k), (t) => ingest(t)).catch((e) => ({ on: true, error: String(e?.message || e) })));
  // LENS: hands-on looks at the coins that matter (website, X, who is talking, Telegram), streamed to the LensCam
  // MIND: the trader's mind judges the coins that matter, follows its calls, does post-mortems and goes to school
  // HOUND: FOMO traders, KOL wallets, smart wallets from breakouts, the live webhook. OVERSEER: explore and propose
  // MOMO: coins pulling real volume right now (GeckoTerminal), straight to the desk
  const momo = alive("momo", ag(() => momoScan()).catch((e) => ({ momo: "error", error: String(e?.message || e) })));
  // CATCH: looks again and again at hot curves, migrations and the BOARD, for coins moving like senders
  const caught = alive("catch", ag(() => catchSession(Math.round(50_000 * k))).catch((e) => ({ catch: "error", error: String(e?.message || e) })));
  const hound = alive("hound", ag(() => houndSession()).catch((e) => ({ hound: "error", error: String(e?.message || e) })));
  const overseer = alive("overseer", ag(() => overseerSession(Math.round(50_000 * k))).catch((e) => ({ overseer: "error", error: String(e?.message || e) })));
  const mind = alive("mind", ag(() => mindSession(Math.round(54_000 * k))).catch((e) => ({ mind: "error", error: String(e?.message || e) })));
  const lens = alive("lens", ag(() => lensSession(Math.round(52_000 * k))).catch((e) => ({ lens: "error", error: String(e?.message || e) })));
  const cap = ms + 30_000; // nothing may hold the next session back by more than this
  const [desk, history, receipts, telegram, x] = await Promise.all([
    withDesk ? within(deskSession(ms, () => dig()), ms + 90_000, "desk") : Promise.resolve({ desk: "own loop" }),
    opts.historian === false ? Promise.resolve({ history: "own loop" }) : within(historianSession(Math.round(45_000 * k)).catch((e) => ({ history: "error", error: String(e?.message || e) })), cap, "historian"),
    within(alive("receipts", sealDue().catch((e) => ({ sealed: 0, error: String(e?.message || e) }))), cap, "receipts"),
    within(alive("telegram", tg), cap, "telegram"),
    within(alive("wire", wire), cap, "wire"),
  ]);
  const rest = await Promise.all([j7, lens, mind, hound, overseer, momo, caught].map((p, i) => within(p as Promise<unknown>, 15_000, ["j7", "lens", "mind", "hound", "overseer", "momo", "catch"][i])));
  const [j7r, lensr, mindr, houndr, overseerr, momor, catchr] = rest;
  return { desk, history, receipts, telegram, wire: x, j7: j7r, lens: lensr, mind: mindr, hound: houndr, overseer: overseerr, momo: momor, catch: catchr };
}

