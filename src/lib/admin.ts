// Admin and machine auth.
//
// Admin sessions are stateless signed tokens: `v1.<exp>.<nonce>.<sig>`, sig = HMAC-SHA256 over the payload with a key
// derived from ADMIN_PASSWORD *and* a server-only secret (ADMIN_SESSION_SECRET, else CRON_SECRET). So:
//  - a session expires on its own (7 days), and every session dies the moment the password or the secret changes;
//  - a stolen cookie can't be brute-forced offline back to the password (the key needs the server secret too);
//  - checks stay synchronous (no Redis round trip on every admin request).
//
// Machine secrets are split by purpose. CRON_SECRET is the root; each integration gets its own key derived from it
// (or its own env var), so a key that leaks through a third party's logs can't run the cron, the bot or the admin.
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

/** A fresh session token for a successful login. */
export function newSession() {
  const key = sessionKey();
  if (!key) return "";
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = `v1.${exp}.${randomBytes(12).toString("base64url")}`;
  return `${payload}.${sign(key, payload)}`;
}

function validSession(tok: string) {
  const key = sessionKey();
  if (!key || !tok) return false;
  const i = tok.lastIndexOf(".");
  if (i < 0) return false;
  const payload = tok.slice(0, i);
  const [v, exp] = payload.split(".");
  if (v !== "v1" || !(Number(exp) * 1000 > Date.now())) return false;
  return safeEq(tok.slice(i + 1), sign(key, payload));
}

export function isAdmin() {
  try {
    return validSession(cookies().get(ADMIN_COOKIE)?.value || "");
  } catch {
    return false; // outside a request scope
  }
}

export function checkPassword(pw: string) {
  return safeEq(pw, process.env.ADMIN_PASSWORD || "");
}

/** Purpose-bound secret: its own env var if set, else derived from CRON_SECRET. Empty when nothing is configured. */
export function secretFor(purpose: "x-hook" | "helius-hook" | "tg-hook") {
  const own = { "x-hook": process.env.X_HOOK_SECRET, "helius-hook": process.env.HELIUS_HOOK_SECRET, "tg-hook": process.env.TG_HOOK_SECRET }[purpose];
  if (own) return own;
  const root = process.env.CRON_SECRET;
  if (!root) return "";
  return createHmac("sha256", root).update(`ratnet:${purpose}`).digest("hex").slice(0, 40);
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
