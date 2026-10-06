import { createHash, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

export const ADMIN_COOKIE = "rn_admin";

export function adminToken() {
  const pw = process.env.ADMIN_PASSWORD || "";
  if (!pw) return "";
  return createHash("sha256").update(`ratnet-admin:${pw}`).digest("hex");
}

export function isAdmin() {
  const t = adminToken();
  const c = cookies().get(ADMIN_COOKIE)?.value || "";
  if (!t || c.length !== t.length) return false;
  return timingSafeEqual(Buffer.from(c), Buffer.from(t));
}

export function checkPassword(pw: string) {
  const real = process.env.ADMIN_PASSWORD || "";
  if (!real || pw.length !== real.length) return false;
  return timingSafeEqual(Buffer.from(pw), Buffer.from(real));
}

export function isCron(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(req.url);
  return req.headers.get("authorization") === `Bearer ${secret}` || url.searchParams.get("key") === secret;
}
