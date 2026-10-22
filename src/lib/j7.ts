// J7Tracker feed: the trenches' own social monitor. Its main feed already covers the accounts that move coins, its
// shared pool adds thousands more for free, it includes Truth Social, Instagram, TikTok and YouTube, and it flags any
// contract address in a post. WIRE listens to it during every minute run (Socket.IO, ~55s per run; the backlog of the
// last 100 posts on each connect covers the gap between runs).
// Set J7_JWT (your J7Tracker session token) and optionally J7_HOST (default https://nyc.j7tracker.io).
import { redis } from "./redis";
import type { XTweet } from "./wire";

const CORE = "https://core.j7tracker.io";
const COVER = "rn:x:j7cov"; // handles J7 already watches for us (lowercase), refreshed hourly
const STATE = "rn:x:j7"; // last session result, for the page
export const j7On = () => !!process.env.J7_JWT;
// v0.1.123: a J7 token now lasts about 10 hours (19 Oct: "Invalid token" since the night). J7 renews it only with the
// browser's own login cookie, so the worker cannot renew it itself. It reads the token's expiry instead: the status
// shows the minutes left, and from 60 minutes before the end the part reports an error, so the alert comes in time.
// A fresh token: the copy button on j7tracker.io, pasted into Railway as J7_JWT. Never logged or shown.
export function jwtExp(t: string | undefined | null): number {
  try {
    const p = JSON.parse(Buffer.from(String(t).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return Number(p.exp) * 1000 || 0;
  } catch {
    return 0;
  }
}
export const j7Left = (now = Date.now()) => {
  const e = jwtExp(process.env.J7_JWT);
  return e ? Math.round((e - now) / 60_000) : null; // minutes
};
const head = () => ({ Authorization: `Bearer ${process.env.J7_JWT}`, "content-type": "application/json" });

/** J7 tweet or external post -> WIRE's tweet shape. */
export function fromJ7(t: any, platform?: string): XTweet | null {
  const h = t?.author?.handle || t?.author?.username || t?.handle;
  if (!t?.id || !h) return null;
  const type = String(t.type || "").toUpperCase();
  const kind: XTweet["kind"] = t.isRetweet || type === "RETWEET" ? "rt" : t.isQuote || type === "QUOTE" ? "quote" : t.isReply || type === "REPLY" ? (t.isSelfReply ? "post" : "reply") : "post";
  const at = typeof t.createdAt === "number" ? t.createdAt : Date.parse(t.createdAt) || Date.now();
  const inner = t.quotedTweet?.text || t.retweetedQuote?.text || undefined;
  const ca = t.contractAddress && (!t.chain || /sol/i.test(t.chain)) ? String(t.contractAddress) : undefined;
  return {
    id: platform ? `${platform}:${t.id}` : String(t.id),
    h: String(h),
    name: t.author?.name,
    f: Number(t.author?.followersCount || 0),
    at,
    text: String(t.text || "").slice(0, 400),
    terms: [],
    url: t.tweetUrl || t.url || (platform ? "" : `https://x.com/${h}/status/${t.id}`),
    kind,
    inner: inner ? String(inner).slice(0, 200) : undefined,
    ca,
    src: platform || "j7",
  };
}

/** Listen to the J7 feed for `ms`, handing new posts to `onPosts` in small batches (every 400ms). */
export async function j7Session(ms: number, onPosts: (t: XTweet[]) => Promise<unknown>) {
  if (!j7On()) return { on: false };
  const { io } = await import("socket.io-client");
  const token = process.env.J7_JWT!;
  const host = process.env.J7_HOST || "https://nyc.j7tracker.io";
  const buf: XTweet[] = [];
  let got = 0;
  let error: string | null = null;
  const seen = new Set<string>();
  const push = (raw: any, platform?: string) => {
    const t = fromJ7(raw, platform);
    if (!t) return;
    // a later update can carry the contract address the first copy didn't have
    const key = `${t.id}|${t.ca || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    buf.push(t);
    got++;
  };
  return new Promise<{ on: true; got: number; error: string | null; minsLeft?: number | null }>((resolve) => {
    const sock = io(host, { transports: ["websocket"], auth: { token }, reconnection: false, timeout: 8000 });
    const flush = setInterval(() => {
      if (buf.length) onPosts(buf.splice(0, buf.length)).catch(() => {});
    }, 400);
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      clearInterval(flush);
      sock.close();
      if (buf.length) await onPosts(buf.splice(0, buf.length)).catch(() => {});
      await redis().set(STATE, { at: Date.now(), got, error }).catch(() => {});
      const left = j7Left();
      // the token is about to run out (or has): an error now, so the alert comes before the feed stops
      const soon = left != null && left < 60 ? (left <= 0 ? "J7 token expired: copy a fresh one on j7tracker.io into Railway (J7_JWT)" : `J7 token runs out in ${left}m: copy a fresh one on j7tracker.io into Railway (J7_JWT)`) : null;
      resolve({ on: true, got, error: error || soon, minsLeft: left });
    };
    sock.on("connect", () => sock.emit("user_connected", token));
    sock.on("initialTweets", (items: any[]) => (items || []).forEach((x) => push(x)));
    sock.on("tweet", (x: any) => push(x));
    sock.on("tweet_update", (x: any) => x?.contractAddress && push(x));
    sock.on("external_message", (m: any) => push({ ...m, id: m.id || `${m.author?.handle}-${m.createdAt}`, author: m.author }, String(m.platform || "social").toLowerCase()));
    const fail = (e: any) => {
      error = String(e?.message || e?.error || e || "error");
      finish();
    };
    sock.on("connect_error", fail);
    sock.on("auth_error", fail);
    // a drop mid-session ends it at once (the next session reconnects within seconds), instead of a silent gap until
    // the session timer runs out
    sock.on("disconnect", (why: any) => {
      if (done) return;
      error = `disconnected: ${String(why || "")}`.slice(0, 80);
      finish();
    });
    setTimeout(finish, ms);
  });
}

/** Hourly: make J7 watch everything it can for free (its whole shared pool and our own list where pooled) and note
 *  which handles J7 covers, so twitterapi.io only pays for the rest. */
export async function j7Accounts(ours: string[]) {
  if (!j7On()) return { on: false };
  const r = redis();
  if (!(await r.set("rn:x:j7lock", 1, { nx: true, ex: 3600 }))) return { skipped: "hourly" };
  const res: any = await fetch(`${CORE}/api/watched-accounts?fresh=1`, { headers: head() }).then((x) => x.json()).catch(() => null);
  if (!res?.success) return { error: res?.error || "watched-accounts failed" };
  const pool: string[] = (res.available?.accounts || []).map(String);
  const poolSet = new Set(pool.map((h) => h.toLowerCase()));
  // the whole free pool, plus our handles that sit in it (adding a pooled handle uses no slot)
  const add = Array.from(new Set([...pool, ...ours.filter((h) => poolSet.has(h.toLowerCase()))]));
  let added = 0;
  for (let i = 0; i < add.length; i += 5000) {
    const out: any = await fetch(`${CORE}/api/accounts/available`, { method: "POST", headers: head(), body: JSON.stringify({ handles: add.slice(i, i + 5000) }) }).then((x) => x.json()).catch(() => null);
    added += Number(out?.added || 0) + Number(out?.unhidden || 0);
  }
  const xs: string[] = (res.x?.accounts || []).map((a: any) => String(typeof a === "string" ? a : a.handle || a.username || "")).filter(Boolean);
  const cover = Array.from(new Set([...xs, ...(res.custom?.accounts || []), ...(res.custom?.availableAccounts || []), ...add].map((h: string) => h.toLowerCase())));
  if (cover.length) {
    await r.del(COVER);
    for (let i = 0; i < cover.length; i += 1000) await r.sadd(COVER, cover[i], ...cover.slice(i + 1, i + 1000));
  }
  return { covered: cover.length, added, pool: pool.length };
}

export async function j7Covered(): Promise<Set<string>> {
  const m = ((await redis().smembers(COVER)) || []) as string[];
  return new Set(m.map(String));
}
export async function j7State() {
  const [st, n] = await Promise.all([redis().get<{ at: number; got: number; error: string | null }>(STATE), redis().scard(COVER)]);
  return { on: j7On(), last: st || null, covered: n || 0 };
}
