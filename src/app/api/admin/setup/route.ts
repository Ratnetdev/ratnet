// Admin > Setup: what is configured, what still needs doing, and one-click setup actions. Secrets are never echoed;
// the only URL with a key in it is the twitterapi.io webhook (that service only accepts a URL), and its key is a
// purpose-bound secret derived from CRON_SECRET, not CRON_SECRET itself.
import { waitUntil } from "@vercel/functions";
import { SITE } from "@/config/site";
import { isAdmin, secretFor } from "@/lib/admin";
import { fail, json } from "@/lib/http";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Need = "core" | "trade" | "agent" | "optional";
const ENV: { k: string; need: Need; what: string; alt?: string[] }[] = [
  { k: "UPSTASH_REDIS_REST_URL", need: "core", what: "database", alt: ["KV_REST_API_URL"] },
  { k: "UPSTASH_REDIS_REST_TOKEN", need: "core", what: "database", alt: ["KV_REST_API_TOKEN"] },
  { k: "HELIUS_RPC_URL", need: "core", what: "Solana RPC (paid plan: set RPC_RPS 50)", alt: ["SOLANA_RPC_URL"] },
  { k: "RPC_RPS", need: "core", what: "RPC requests per second your plan allows (50 on Helius Developer)" },
  { k: "CRON_SECRET", need: "core", what: "root secret: cron pings, setup, derived webhook keys" },
  { k: "ADMIN_PASSWORD", need: "core", what: "this page" },
  { k: "NEXT_PUBLIC_SITE_URL", need: "core", what: "https://www.ratnet.network" },
  { k: "DESK_WALLET_SECRET", need: "trade", what: "the desk's own hot wallet: on Railway only (Vercel ignores it since v0.1.33; remove it there)" },
  { k: "JUPITER_API_KEY", need: "trade", what: "faster Jupiter (paid api.jup.ag), optional" },
  { k: "ANTHROPIC_API_KEY", need: "agent", what: "MIND, OVERSEER, LENS judgement" },
  { k: "X_API_KEY", need: "agent", what: "twitterapi.io: WIRE, LENS, PULSE" },
  { k: "J7_JWT", need: "agent", what: "J7 tweet feed (expires 21 Oct)" },
  { k: "FOMO_API_KEY", need: "agent", what: "HOUND: FOMO traders" },
  { k: "MADEONSOL_API_KEY", need: "agent", what: "HOUND: KOL wallets" },
  { k: "SOLANATRACKER_API_KEY", need: "agent", what: "holders, top-10 share, PnL" },
  { k: "TELEGRAM_BOT_TOKEN", need: "agent", what: "Telegram calls and OVERSEER ideas" },
  { k: "TELEGRAM_CHAT_ID", need: "agent", what: "channel for public calls" },
  { k: "TELEGRAM_IDEAS_CHAT_ID", need: "agent", what: "private chat for OVERSEER ideas" },
  { k: "TELEGRAM_ADMIN_IDS", need: "agent", what: "your Telegram user id(s): only they can command the bot" },
  { k: "BLOB_READ_WRITE_TOKEN", need: "optional", what: "dataset exports" },
  { k: "RECEIPT_WALLET_SECRET", need: "optional", what: "on-chain call receipts (tiny SOL wallet)" },
  { k: "PAYOUT_WALLET_SECRET", need: "optional", what: "rat payouts (after launch)" },
  { k: "ADMIN_SESSION_SECRET", need: "optional", what: "separate key for admin sessions (else CRON_SECRET)" },
];

async function tgInfo() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) return null;
  const j: any = await fetch(`https://api.telegram.org/bot${t}/getWebhookInfo`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
  const u = j?.result;
  return u ? { url: u.url || "", pending: u.pending_update_count || 0, lastError: u.last_error_message || null, ok: u.url === `${SITE.url}/api/tg/hook` } : null;
}

export async function GET() {
  if (!(await isAdmin())) return fail("unauthorized", 401);
  const r = redis();
  const [worker, hook, xsync, tg, hst, hn] = await Promise.all([
    r.get("rn:worker:at").catch(() => null),
    r.get<any>("rn:hd:hook").catch(() => null),
    r.get<any>("rn:x:synced").catch(() => null),
    tgInfo(),
    r.hgetall<Record<string, any>>("rn:hd:status").catch(() => null),
    r.hlen("rn:hd:w").catch(() => 0),
  ]);
  const env = ENV.map((e) => ({ ...e, set: !!process.env[e.k] || !!e.alt?.some((a) => process.env[a]) }));
  const rps = Number(process.env.RPC_RPS || 0);
  return json({
    env,
    site: SITE.url,
    status: {
      worker: worker ? { at: Number(worker), fresh: Date.now() - Number(worker) < 90_000 } : null,
      rpcPlan: rps >= 40 ? `paid (${rps} rps)` : rps ? `${rps} rps` : "free tier (set RPC_RPS)",
      heliusHook: hook || null,
      hound: { wallets: Number(hn || 0), fomo: hst?.fomo || null, kol: hst?.kol || null },
      xRules: xsync || null,
      telegram: tg,
    },
    // v0.1.33: only an own X_HOOK_SECRET works in the URL (or twitterapi.io's X-API-Key header)
    xHookUrl: process.env.X_HOOK_SECRET ? `${SITE.url}/api/x/hook?key=${process.env.X_HOOK_SECRET}` : `${SITE.url}/api/x/hook (twitterapi.io sends your X_API_KEY as the X-API-Key header)`,
    cron: { url: `${SITE.url}/api/desk/run`, header: "Authorization: Bearer <CRON_SECRET>" },
  });
}

export async function POST(req: Request) {
  if (!(await isAdmin())) return fail("unauthorized", 401);
  const { action } = await req.json().catch(() => ({ action: "" }));
  try {
    if (action === "tg") return json(await (await import("@/lib/tgbot")).setupHook());
    // long jobs (dozens of API calls) run in the background: the button answers at once and the status rows above
    // update when they finish, so a slow source can never time the request out and show a false "failed"
    if (action === "xsync") {
      const { syncRules } = await import("@/lib/wire");
      waitUntil(syncRules(true).catch(() => null));
      return json({ started: true, note: "X sync running, the row updates within a minute" });
    }
    if (action === "hound") return json(await (await import("@/lib/hound")).syncHook(true));
    if (action === "houndfill") {
      const { houndRefill } = await import("@/lib/hound");
      waitUntil(houndRefill().catch(() => null));
      return json({ started: true, note: "HOUND fill running (FOMO, KOL rosters, then the Helius webhook), the rows update within a minute" });
    }
    return fail("unknown action");
  } catch (e) {
    return fail(e, 500);
  }
}
