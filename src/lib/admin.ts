// Admin and machine auth.
//
// Admin sessions are stateless signed tokens: `v1.<exp>.<nonce>.<sig>`, sig = HMAC-SHA256 over the payload with a key
// derived from ADMIN_PASSWORD *and* a server-only secret (ADMIN_SESSION_SECRET, else CRON_SECRET). So:
//  - a session expires on its own (7 days), and every session dies the moment the password or the secret changes;
//  - a stolen cookie can't be brute-forced offline back to the password (the key needs the server secret too);
//  - checks stay synchronous (no Redis round trip on every admin request).
//
// v0.1.46: sessions are also revocable. Each token carries the session epoch (rn:admin:epoch); "log out everywhere"
// bumps it and every older token stops working at once.
//
// Machine secrets are split by purpose: CRON_SECRET for the cron, and each webhook its own env var (v0.1.46: never
// derived from CRON_SECRET), so a key that leaks through a third party's logs can't run the cron, the bot or the admin.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

export const ADMIN_COOKIE = "rn_admin";
export const SESSION_DAYS = 7;

const sha = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time string compare (hashes first, so lengths don't leak either). */
export function safeEq(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  return timingSafeEqual(sha(a), sha(b));
}

function sessionKey() {
  const pw = process.env.ADMIN_PASSWORD || "";
  const secret = process.env.ADMIN_SESSION_SECRET || process.env.CRON_SECRET || "";
  if (!pw || !secret) return null;
  return createHmac("sha256", secret).update(`ratnet-admin-session:${pw}`).digest();
}

const sign = (key: Buffer, payload: string) => createHmac("sha256", key).update(payload).digest("base64url");

const EPOCH_KEY = "rn:admin:epoch";
let EPOCH: { v: number; at: number } | null = null;
/** The current session epoch (read at most every 10s per server instance). null when Redis can't be read: no session
 *  is valid then (fails closed). */
async function sessionEpoch(): Promise<number | null> {
  if (EPOCH && Date.now() - EPOCH.at < 10_000) return EPOCH.v;
  try {
    const { redis } = await import("./redis");
    const v = Number((await redis().get(EPOCH_KEY)) || 0);
    EPOCH = { v, at: Date.now() };
    return v;
  } catch {
    return null;
  }
}
/** Log out every session (all devices). */
export async function revokeSessions() {
  const { redis } = await import("./redis");
  await redis().incr(EPOCH_KEY);
  EPOCH = null;
}

/** A fresh session token for a successful login. */
export async function newSession() {
  const key = sessionKey();
  const ep = await sessionEpoch();
  if (!key || ep == null) return "";
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = `v2.${exp}.${randomBytes(12).toString("base64url")}.${ep}`;
  return `${payload}.${sign(key, payload)}`;
}

function validSession(tok: string, epoch: number) {
  const key = sessionKey();
  if (!key || !tok) return false;
  const i = tok.lastIndexOf(".");
  if (i < 0) return false;
  const payload = tok.slice(0, i);
  const [v, exp, , ep] = payload.split(".");
  if (v !== "v2" || !(Number(exp) * 1000 > Date.now()) || Number(ep) !== epoch) return false;
  return safeEq(tok.slice(i + 1), sign(key, payload));
}

// Next 15: cookies() is async
export async function isAdmin() {
  try {
    const tok = (await cookies()).get(ADMIN_COOKIE)?.value || "";
    if (!tok) return false;
    const ep = await sessionEpoch();
    return ep != null && validSession(tok, ep);
  } catch {
    return false; // outside a request scope
  }
}

export function checkPassword(pw: string) {
  return safeEq(pw, process.env.ADMIN_PASSWORD || "");
}

/**
 * Purpose-bound secret: its own env var only. v0.1.46: no longer derived from CRON_SECRET when the env var is missing
 * (one leaked cron key also opened every webhook). Empty when not set: that webhook then refuses everything, and
 * /status says which secret is missing.
 */
export function secretFor(purpose: "x-hook" | "helius-hook" | "tg-hook") {
  return ({ "x-hook": process.env.X_HOOK_SECRET, "helius-hook": process.env.HELIUS_HOOK_SECRET, "tg-hook": process.env.TG_HOOK_SECRET }[purpose] || "").trim();
}

/**
 * Cron and one-time setup calls. Preferred: `Authorization: Bearer <CRON_SECRET>` (cron-job.org supports custom
 * headers). `?key=` still works so existing pingers don't break, unless CRON_HEADER_ONLY=1.
 */
export function isCron(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const h = req.headers.get("authorization") || "";
  if (h.startsWith("Bearer ") && safeEq(h.slice(7), secret)) return true;
  if (process.env.CRON_HEADER_ONLY === "1") return false;
  return safeEq(new URL(req.url).searchParams.get("key"), secret);
}
