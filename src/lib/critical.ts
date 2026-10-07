// Protocol-wide failures, straight to Telegram (the private ideas chat). These are the ones where nothing else can
// warn you, because the thing that broke is what the other alerts run on: Redis (the 7 Oct Upstash plan limit took
// every page and every loop down at once), the chain RPC, the public site. No Redis is used here: incidents are kept
// in the worker's memory, one alert when it starts, a reminder every 30 minutes while it lasts, one line when it ends.
import { SITE } from "@/config/site";
import { redis } from "./redis";
import { rpcStats } from "./solana";

type Incident = { since: number; lastSent: number; fails: number; detail: string };
const open = new Map<string, Incident>();
const NAMES: Record<string, string> = { redis: "Redis (Upstash)", rpc: "Chain RPC (Helius)", site: "Public site API" };
const FIX: Record<string, string> = {
  redis: "Upstash Console: check the plan limits and usage (bandwidth, storage, commands). Every loop and page is down until Redis answers.",
  rpc: "Helius dashboard: check credits and the plan's rate limit. The desk cannot price or exit positions without it.",
  site: "Vercel: check the latest deployment and its function logs.",
};
const clean = (s: string) => s.replace(/https?:\/\/\S+/g, "[url]").replace(/api-key=\S+/gi, "").replace(/[<>&]/g, " ").slice(0, 220);

async function send(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_IDEAS_CHAT_ID;
  if (!token || !chat) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
}

/** Feed one check result. Two failures in a row open an incident (one blip is not an outage). */
export async function noteCheck(name: string, ok: boolean, detail = "") {
  const now = Date.now();
  const inc = open.get(name);
  if (ok) {
    if (inc && inc.fails >= 2) await send(`✅ <b>${NAMES[name] || name}</b> is back (down ${Math.max(1, Math.round((now - inc.since) / 60_000))}m).`);
    open.delete(name);
    return;
  }
  const cur = inc || { since: now, lastSent: 0, fails: 0, detail };
  cur.fails++;
  cur.detail = detail || cur.detail;
  open.set(name, cur);
  if (cur.fails >= 2 && now - cur.lastSent > 30 * 60_000) {
    cur.lastSent = now;
    const mins = Math.round((now - cur.since) / 60_000);
    await send(`🚨 <b>${NAMES[name] || name} is failing</b>${mins ? ` (${mins}m)` : ""}\n${clean(cur.detail)}\n\n${FIX[name] || ""}`);
  }
}

/** True while Redis is failing (the worker then skips restarts: a restart cannot fix the database, it only re-alerts). */
export const redisDown = () => (open.get("redis")?.fails ?? 0) >= 2;

let lastRpc = { calls: 0, fails: 0 };
let lastSite = 0;
/** One round of checks (the worker calls this every 20s). */
export async function criticalChecks() {
  // Redis: one tiny write, the same thing every loop depends on
  try {
    await redis().set("rn:crit:ping", Date.now(), { ex: 120 });
    await noteCheck("redis", true);
  } catch (e: any) {
    await noteCheck("redis", false, String(e?.message || e));
  }
  // RPC: share of failed calls since the last round (a dead key or exhausted credits fails everything)
  const calls = rpcStats.calls - lastRpc.calls;
  const fails = rpcStats.fails - lastRpc.fails;
  lastRpc = { calls: rpcStats.calls, fails: rpcStats.fails };
  if (calls >= 20) await noteCheck("rpc", fails / calls < 0.5, `${fails} of ${calls} chain reads failed in the last 20s (last error: ${rpcStats.lastError || "?"})`);
  // the public site, once a minute: the API pages read Redis on Vercel, a different path from the worker's
  if (Date.now() - lastSite >= 60_000) {
    lastSite = Date.now();
    const res = await fetch(`${SITE.url}/api/alive`, { cache: "no-store", signal: AbortSignal.timeout(15_000) }).catch((e) => e as Error);
    if (res instanceof Error) await noteCheck("site", false, `no answer: ${res.message}`);
    else if (!res.ok) await noteCheck("site", false, `HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    else await noteCheck("site", true);
  }
}
