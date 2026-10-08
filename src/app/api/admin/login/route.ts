import { NextResponse } from "next/server";
import { ADMIN_COOKIE, SESSION_DAYS, checkPassword, isAdmin, newSession, revokeSessions } from "@/lib/admin";
import { fail, ipOf, limit, memLimit } from "@/lib/http";

// 5 tries per 15 minutes per IP, 30 per hour across all IPs: online guessing goes nowhere.
export async function POST(req: Request) {
  // v0.1.46: also limited in memory, and the Redis limit fails closed (a Redis outage no longer lifts it)
  if (!memLimit(`login:${ipOf(req)}`, 5, 900) || !(await limit(`login:${ipOf(req)}`, 5, 900, true)) || !(await limit("login:all", 30, 3600, true))) return fail("Too many tries. Wait a few minutes.", 429);
  const body = await req.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password.slice(0, 200) : "";
  if (!checkPassword(password)) return fail("Wrong password", 401);
  const tok = await newSession();
  if (!tok) return fail("Admin is not configured (ADMIN_PASSWORD and CRON_SECRET)", 500);
  const res = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  res.cookies.set(ADMIN_COOKIE, tok, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: SESSION_DAYS * 86400 });
  return res;
}

// ?all=1 logs out every session on every device (v0.1.46)
export async function DELETE(req: Request) {
  if (new URL(req.url).searchParams.get("all") === "1" && (await isAdmin())) await revokeSessions();
  const res = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  res.cookies.set(ADMIN_COOKIE, "", { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 0 });
  return res;
}
