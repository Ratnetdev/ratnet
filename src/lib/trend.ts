// v0.1.119 TREND: what is going viral on TikTok and Instagram, before a coin exists.
//
// Memes are born on short video (TikTok's "Chill Guy" fuelled one of 2024's biggest memecoins) and RATNET had no eyes
// there: SEER read X, Google Trends, Polymarket and launches only. TREND samples both platforms through Apify (an
// APIFY_TOKEN, pasted into Railway): TikTok's Creative Center top hashtags and the newest videos on meme-heavy tags,
// and the newest Instagram posts on the same kind of tags. From each video or post it keeps the hashtags and the sound,
// weighs them by views in the last 72 hours, and keeps the terms that are rising.
// Two uses, both measured like everything else (nothing here trades on its own):
//   1. SEER: rising terms become SEER items, so the forecaster can arm the names a coin would be launched under;
//   2. a rule: a launch whose name or ticker matches a rising TikTok or Instagram term, at the call and at the EARLY reads
//      (GRID and the EARLY searches test it from this build on).
// Cost control: a run every TREND_EVERY_MIN (default 120), at most TREND_TT_PER_RUN / TREND_IG_PER_RUN items a run and
// TREND_PER_DAY items a day. Without APIFY_TOKEN it stays off.
import { redis } from "./redis";
import { norm } from "./seer";

const VIEW_KEY = "rn:trend:view";
const HIST_KEY = "rn:trend:h"; // term -> {first, last, score}
const DAYK = (d: string) => `rn:trend:n:${d}`;
const TT_ACTOR = () => process.env.TREND_TT_ACTOR || "clockworks~tiktok-hashtag-scraper";
const TT_CC_ACTOR = () => process.env.TREND_TT_CC_ACTOR || "dami_studio~tiktok-creative-center-trends";
const IG_ACTOR = () => process.env.TREND_IG_ACTOR || "apify~instagram-hashtag-scraper";
const TT_TAGS = () => String(process.env.TREND_TT_TAGS || "meme,viral,funny,trending,fyp").split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
const IG_TAGS = () => String(process.env.TREND_IG_TAGS || "meme,memes,viral,funny").split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
const num = (k: string, d: number) => Math.max(0, Number(process.env[k] ?? d) || 0);
export const trendOn = () => !!process.env.APIFY_TOKEN;

/** Hashtags that are on everything and say nothing. */
export const STOP = new Set(
  ["fyp", "foryou", "foryoupage", "fy", "fypage", "viral", "viralvideo", "trending", "trend", "meme", "memes", "funny", "funnyvideos", "comedy", "lol", "xyzbca", "tiktok", "explore", "explorepage", "instagram", "reels", "reel", "instagood", "love", "like", "follow", "humor", "relatable", "edit", "capcut", "duet", "stitch", "foru", "parati", "pourtoi", "originalsound", "sonidooriginal", "sonoriginal", "originalaudio", "fypシ", "fypage", "viralreels", "trendingreels", "memesdaily", "dankmemes", "funnymemes", "4u", "foryourpage", "greenscreen", "pov", "fun", "video"].map(norm),
);

export type Hit = { id: string; src: "tiktok" | "instagram"; text: string; tags: string[]; sound: string | null; views: number; likes: number; at: number | null; url: string };
export type Term = { t: string; src: string[]; score: number; views: number; n: number; first: number; last: number; rising: boolean };
export const trendStats = { runs: 0, items: 0, terms: 0, rising: 0, lastAt: 0, lastErr: "", capped: 0, byActor: {} as Record<string, number> };

async function runActor(actor: string, input: unknown, maxItems: number): Promise<any[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token || maxItems <= 0) return [];
  const r = await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?timeout=240&maxItems=${maxItems}&clean=true`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(280_000),
  });
  if (!r.ok) throw new Error(`apify ${actor.split("~")[1] || actor} answered ${r.status}`);
  const j = await r.json().catch(() => null);
  return Array.isArray(j) ? j : [];
}

const n0 = (...xs: unknown[]) => {
  for (const x of xs) if (Number.isFinite(Number(x)) && Number(x) > 0) return Number(x);
  return 0;
};
const tagsIn = (text: string) => [...String(text || "").matchAll(/#([\p{L}\p{N}_]{2,40})/gu)].map((m) => m[1]);
/** A TikTok video (clockworks scrapers) as a hit. */
export function ttHit(v: any): Hit | null {
  if (!v || v.errorCode || v.isAd) return null;
  const text = String(v.text || v.desc || "");
  const tags = (Array.isArray(v.hashtags) ? v.hashtags.map((h: any) => (typeof h === "string" ? h : h?.name)) : tagsIn(text)).filter(Boolean).map(String);
  const sound = v.musicMeta && !v.musicMeta.musicOriginal && v.musicMeta.musicName && !/original sound|sonido original|son original/i.test(v.musicMeta.musicName) ? String(v.musicMeta.musicName) : null;
  const at = v.createTimeISO ? Date.parse(v.createTimeISO) : Number(v.createTime) > 0 ? Number(v.createTime) * 1000 : null;
  return { id: `tt:${v.id || v.webVideoUrl}`, src: "tiktok", text: text.slice(0, 200), tags, sound, views: n0(v.playCount, v.stats?.playCount), likes: n0(v.diggCount, v.stats?.diggCount), at: Number.isFinite(at as number) ? (at as number) : null, url: String(v.webVideoUrl || "") };
}
/** An Instagram post (apify hashtag scrapers) as a hit. */
export function igHit(p: any): Hit | null {
  if (!p || p.error) return null;
  const text = String(p.caption || p.text || "");
  const tags = (Array.isArray(p.hashtags) && p.hashtags.length ? p.hashtags : tagsIn(text)).filter(Boolean).map(String);
  const at = p.timestamp ? Date.parse(p.timestamp) : Number(p.taken_at_timestamp) > 0 ? Number(p.taken_at_timestamp) * 1000 : null;
  const sound = p.musicInfo?.song_name || p.musicInfo?.title || null;
  return { id: `ig:${p.id || p.shortCode || p.url}`, src: "instagram", text: text.slice(0, 200), tags, sound: sound && !/original audio/i.test(sound) ? String(sound) : null, views: n0(p.videoPlayCount, p.videoViewCount, p.playsCount), likes: n0(p.likesCount, p.likes), at: Number.isFinite(at as number) ? (at as number) : null, url: String(p.url || "") };
}

/**
 * Terms from hits: each hashtag and sound, weighed by the views and likes of the hits (last 72 hours) it is on. A term
 * needs 2+ hits or one hit with 1M+ views; "rising" = new in the last 24 hours, or its score at least doubled since the
 * last run.
 */
export function termsOf(hits: Hit[], prev: Record<string, { first: number; last: number; score: number }>, now = Date.now()) {
  const by = new Map<string, Term>();
  for (const h of hits) {
    if (h.at && now - h.at > 72 * 3600_000) continue;
    const w = Math.log10(1 + h.views + 10 * h.likes);
    const keys = new Set<string>();
    for (const t of h.tags) keys.add(t);
    if (h.sound) keys.add(h.sound);
    for (const raw of keys) {
      const t = norm(raw);
      if (t.length < 4 || t.length > 30 || STOP.has(t) || /^\d+$/.test(t)) continue;
      const e = by.get(t) || { t, src: [], score: 0, views: 0, n: 0, first: now, last: now, rising: false };
      e.score += w;
      e.views += h.views;
      e.n++;
      if (!e.src.includes(h.src)) e.src.push(h.src);
      by.set(t, e);
    }
  }
  const out: Term[] = [];
  for (const e of by.values()) {
    if (e.n < 2 && e.views < 1_000_000) continue;
    const p = prev[e.t];
    e.first = p?.first ?? now;
    e.rising = now - e.first < 24 * 3600_000 || (!!p && e.score >= 2 * p.score);
    e.score = Math.round(e.score * 10) / 10;
    out.push(e);
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- the live index (matching launches)
let RISING: Term[] = [];
let INDEX: { p: string; src: string[]; score: number }[] = [];
const reindex = (terms: Term[]) => {
  RISING = terms.filter((t) => t.rising).slice(0, 200);
  INDEX = RISING.map((t) => ({ p: t.t, src: t.src, score: t.score })).sort((a, b) => b.p.length - a.p.length);
};
/** A launch's name or ticker against the rising terms: {tt, ig} = 1 when it matches a rising TikTok / Instagram term. */
export function trendAt(name: string, symbol: string): { tt: 0 | 1; ig: 0 | 1; term: string | null } | null {
  if (!INDEX.length) return null; // no TREND data (no token, or before the first run): unknown, never passes
  const n = norm(name);
  const s = norm(symbol);
  for (const e of INDEX) {
    const hit = n === e.p || s === e.p || (e.p.length >= 5 && n.includes(e.p)) || (n.length >= 5 && e.p.includes(n));
    if (hit) return { tt: e.src.includes("tiktok") ? 1 : 0, ig: e.src.includes("instagram") ? 1 : 0, term: e.p };
  }
  return { tt: 0, ig: 0, term: null };
}
export const trendRising = () => RISING;

/** Worker boot: the last run's terms. */
export async function trendLoad() {
  const v: any = await redis().get(VIEW_KEY).catch(() => null);
  if (Array.isArray(v?.terms)) reindex(v.terms);
  return RISING.length;
}

let lastRun = 0;
/** Worker, every 10 minutes: a run when TREND_EVERY_MIN has passed. */
export async function trendTick(now = Date.now(), run = runActor) {
  if (!trendOn()) return { off: "APIFY_TOKEN not set" };
  if (now - lastRun < num("TREND_EVERY_MIN", 120) * 60_000) return { wait: true };
  lastRun = now;
  const r = redis();
  const day = new Date(now).toISOString().slice(0, 10);
  const used = Number((await r.get(DAYK(day)).catch(() => 0)) || 0);
  const left = num("TREND_PER_DAY", 1500) - used;
  if (left <= 0) {
    trendStats.capped++;
    return { capped: true };
  }
  const ttN = Math.min(left, num("TREND_TT_PER_RUN", 100));
  const igN = Math.min(Math.max(0, left - ttN), num("TREND_IG_PER_RUN", 60));
  const hits: Hit[] = [];
  const jobs: Promise<void>[] = [];
  const note = (k: string, n: number) => (trendStats.byActor[k] = n);
  const fail = (k: string) => (e: any) => void (trendStats.lastErr = `${k}: ${String(e?.message || e).slice(0, 80)}`);
  // TikTok: the Creative Center's top hashtags (US, 7 days) join the meme tags
  jobs.push(
    (async () => {
      let tags = TT_TAGS();
      const cc = await run(TT_CC_ACTOR(), { trendTypes: ["hashtag"], region: "US", periodDays: 7, maxResults: 3 }, 3).catch((e) => (fail("tiktok trends")(e), [] as any[]));
      const top = cc.filter((x: any) => x?.ok && x.hashtag).map((x: any) => String(x.hashtag).replace(/^#/, ""));
      note("tiktok-cc", top.length);
      tags = [...new Set([...top, ...tags])];
      if (!ttN) return;
      const vids = await run(TT_ACTOR(), { hashtags: tags, resultsPerPage: Math.max(5, Math.ceil(ttN / tags.length)), shouldDownloadCovers: false, shouldDownloadSlideshowImages: false, shouldDownloadSubtitles: false, shouldDownloadVideos: false }, ttN);
      note("tiktok", vids.length);
      for (const v of vids) {
        const h = ttHit(v);
        if (h) hits.push(h);
      }
    })().catch(fail("tiktok")),
  );
  if (igN)
    jobs.push(
      (async () => {
        const posts = await run(IG_ACTOR(), { hashtags: IG_TAGS(), resultsType: "posts", resultsLimit: Math.max(5, Math.ceil(igN / IG_TAGS().length)) }, igN);
        note("instagram", posts.length);
        for (const p of posts) {
          const h = igHit(p);
          if (h) hits.push(h);
        }
      })().catch(fail("instagram")),
    );
  await Promise.all(jobs);
  await r.incrby(DAYK(day), hits.length + 3).catch(() => 0);
  r.expire(DAYK(day), 2 * 86400).catch(() => null);
  const prev = ((await r.hgetall<Record<string, any>>(HIST_KEY).catch(() => null)) || {}) as Record<string, { first: number; last: number; score: number }>;
  const terms = termsOf(hits, prev, now);
  if (terms.length) {
    await r.hset(HIST_KEY, Object.fromEntries(terms.slice(0, 300).map((t) => [t.t, { first: t.first, last: now, score: t.score }]))).catch(() => null);
    reindex(terms);
  }
  Object.assign(trendStats, { runs: trendStats.runs + 1, items: hits.length, terms: terms.length, rising: RISING.length, lastAt: now });
  await r.set(VIEW_KEY, { at: now, stats: { ...trendStats }, terms: terms.slice(0, 120), top: hits.sort((a, b) => b.views - a.views).slice(0, 12) }, { ex: 2 * 86400 }).catch(() => null);
  return { items: hits.length, terms: terms.length, rising: RISING.length };
}

/** SEER: the rising terms as items (the forecaster arms the coin names). */
export async function fromTrend() {
  return RISING.slice(0, 15).map((t) => ({ id: `tr:${t.t}`, src: t.src.join("+"), title: `rising on ${[...t.src].sort((a, b) => (a === "tiktok" ? -1 : b === "tiktok" ? 1 : 0)).map((s) => (s === "tiktok" ? "TikTok" : "Instagram")).join(" and ")}: #${t.t} (${t.n} videos or posts, ${Math.round(t.views / 1000)}K views)`, at: null, weight: Math.log10(1 + t.views) + (t.src.length > 1 ? 2 : 0) }));
}

/** Tests only. */
export function _trendReset(terms: Term[] = []) {
  reindex(terms);
  lastRun = 0;
  Object.assign(trendStats, { runs: 0, items: 0, terms: 0, rising: 0, lastAt: 0, lastErr: "", capped: 0, byActor: {} });
}
