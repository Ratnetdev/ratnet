import { NextResponse } from "next/server";
import { safeErr } from "./solana";

export const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });

export const fail = (e: unknown, status = 400) => json({ error: typeof e === "string" ? e : safeErr(e) }, status);

export function ipOf(req: Request) {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "anon";
}
