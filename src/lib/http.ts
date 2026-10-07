import { NextResponse } from "next/server";
import { safeErr } from "./solana";

export const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });

export const fail = (e: unknown, status = 400) => json({ error: typeof e === "string" ? e : safeErr(e) }, status);

/** Client IP. On Vercel x-real-ip / the first x-forwarded-for hop are set by the edge, not the client. */
export function ipOf(req: Request) {
  return (req.headers.get("x-real-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0]).trim().slice(0, 64) || "anon";
}

/** Fixed-window rate limit in Redis. Returns true while under the limit. Fails open if Redis is down. */
export async function limit(key: string, max: number, windowSec: number) {
  try {
    const { redis } = await import("./redis");
    const r = redis();
    const k = `rn:rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
    const n = await r.incr(k);
    if (n === 1) await r.expire(k, windowSec + 5);
    return n <= max;
  } catch {
    return true;
  }
}

/** 429 response helper for public routes. */
export const tooMany = () => NextResponse.json({ error: "Slow down a little." }, { status: 429, headers: { "cache-control": "no-store", "retry-after": "30" } });

/** Public read: cached on Vercel's CDN so thousands of viewers cost one Redis read every few seconds. */
export const cached = (data: unknown, seconds = 3, swr = seconds * 5) =>
  NextResponse.json(data, {
    headers: { "cache-control": `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${swr}` },
  });
