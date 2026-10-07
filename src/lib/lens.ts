// LENS: the hands-on look. For coins that matter (desk buys, tweet picks, BOND calls, launches named after a rising
// narrative) LENS opens what a trader would open by hand: the website, the X account or the post behind it, who is
// talking about the coin on X right now, and the Telegram. Every step streams live to the LensCam on the site, and
// the result is a dossier: a 0-100 score with the red flags and the good signs in plain words.
// LENS informs; it does not block a buy. Its score rides along on every trade so COACH and FILM can learn what it is worth.
import { safeFetch } from "./safefetch";
import { K, redis } from "./redis";
import { agentLog } from "./agents";
import { accountOf, xOn } from "./wire";
import type { Launch } from "./digger";

const Q = "rn:lens:q";
const LIVE = "rn:lens:live";
const HIST = "rn:lens:hist";
const LOCK = "rn:lens:lock";
const HOUR = (t: number) => `rn:lens:h:${Math.floor(t / 3600_000)}`;
export const LENS_D = (m: string) => `rn:lens:d:${m}`;
const MAX_PER_HOUR = 60; // dossiers per hour (each costs ~3 twitterapi.io reads)
const MAX_AGE_MS = 20 * 60_000; // queued coins older than this are dropped
const API = "https://api.twitterapi.io";
const UA = "Mozilla/5.0 (compatible; RATNET-LENS/1.0)";

export const LENS_PRI = { buy: 4, wire: 3, bond: 2, pulse: 1 } as const;
export type LensWhy = keyof typeof LENS_PRI;

type Step = { k: string; label: string; st: "wait" | "run" | "ok" | "bad" | "skip"; note?: string };
export type LensLive = { mint: string; symbol: string; image?: string; at: number; why: LensWhy; url: string; tab: string; title: string; text: string; steps: Step[]; score?: number; done: boolean };
export type Dossier = {
  mint: string;
  symbol: string;
  at: number;
  why: LensWhy;
  done: boolean;
  score: number;
  flags: string[];
  good: string[];
  site: { url: string; up: boolean; title: string; text: string; builder: string | null; caOnSite: boolean; linksX: boolean; domainAgeDays: number | null } | null;
  x: { kind: "account" | "post" | "community"; handle: string | null; followers: number | null; ageDays: number | null; posts: number | null; blue: boolean; bio: string; postText?: string; likes?: number; views?: number; trust?: number } | null;
  talk: { posts: number; authors: number; reach: number; top: { h: string; f: number; text: string; url: string }[]; known: string[] } | null;
  tg: { url: string; members: number | null } | null;
};

/** Ask LENS to look at a coin (pipeline-safe). Higher priority and newer go first. */
export function enqueueLens(p: { zadd: Function }, mint: string, why: LensWhy) {
  p.zadd(Q, { score: LENS_PRI[why] * 1e13 + Date.now(), member: `${why}:${mint}` });
}

export async function lensDossier(mint: string) {
  return (await redis().get<Dossier>(LENS_D(mint))) || null;
}

export async function lensView() {
  const r = redis();
  const [live, hist, q] = await Promise.all([r.get<LensLive>(LIVE), r.lrange<any>(HIST, 0, 19), r.zcard(Q)]);
  return { on: true, x: xOn(), live: live || null, recent: hist || [], queued: q || 0 };
}

// ---------------------------------------------------------------- helpers

const safeHost = (u: URL) => /^https?:$/.test(u.protocol) && !/^(localhost|.*\.local|.*\.internal|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(u.hostname);

// Every fetch here goes through safeFetch: project websites are chosen by whoever launched the coin (public hosts only,
// redirects re-checked, 400KB cap, one deadline for the whole read).
async function get(url: string, ms = 6000, headers: Record<string, string> = {}) {
  const g = await safeFetch(url, { timeoutMs: ms, maxBytes: 400_000, headers: { "user-agent": UA, ...headers }, anyStatus: true });
  return { ok: g.ok, status: g.status, url: g.url, body: g.buf.toString("utf8") };
}

async function xApi<T = any>(path: string): Promise<T | null> {
  if (!xOn()) return null;
  const r = await get(`${API}${path}`, 8000, { "X-API-Key": process.env.X_API_KEY! }).catch(() => null);
  if (!r?.ok) return null;
  try {
    return JSON.parse(r.body) as T;
  } catch {
    return null;
  }
}

const strip = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const BUILDERS: [RegExp, string][] = [
  [/wix\.com|wixsite|_wixCIDX/i, "Wix"],
  [/carrd\.co/i, "Carrd"],
  [/framer\.(com|app|website)|framerusercontent/i, "Framer"],
  [/webflow/i, "Webflow"],
  [/linktr\.ee/i, "Linktree"],
  [/vercel\.app/i, "Vercel"],
  [/netlify\.app/i, "Netlify"],
  [/github\.io/i, "GitHub Pages"],
  [/squarespace/i, "Squarespace"],
  [/wordpress|wp-content/i, "WordPress"],
];
const FREE_HOST = /(vercel\.app|netlify\.app|github\.io|carrd\.co|linktr\.ee|wixsite\.com|framer\.(app|website)|webflow\.io|pages\.dev|replit\.app|lovable\.app)$/i;

function parseX(u: string): { kind: "account" | "post" | "community"; handle: string | null; id: string | null } | null {
  try {
    const url = new URL(u.startsWith("http") ? u : `https://${u}`);
    if (!/(^|\.)(x|twitter)\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "i" && parts[1] === "communities") return { kind: "community", handle: null, id: parts[2] || null };
    if (parts[1] === "status" && /^\d+$/.test(parts[2] || "")) return { kind: "post", handle: parts[0], id: parts[2] };
    if (parts[0] && /^[A-Za-z0-9_]{1,15}$/.test(parts[0])) return { kind: "account", handle: parts[0], id: null };
  } catch {}
  return null;
}

const days = (d: string | number | undefined | null) => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round(((Date.now() - t) / 86400_000) * 10) / 10) : null;
};

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------- one investigation

async function investigate(rec: Launch, why: LensWhy): Promise<Dossier> {
  const r = redis();
  const steps: Step[] = [
    { k: "site", label: "open the website", st: "wait" },
    { k: "domain", label: "check the domain age", st: "wait" },
    { k: "x", label: "open the X link", st: "wait" },
    { k: "talk", label: "search X for the CA and ticker", st: "wait" },
    { k: "tg", label: "open the Telegram", st: "wait" },
    { k: "verdict", label: "write the dossier", st: "wait" },
  ];
  const live: LensLive = { mint: rec.mint, symbol: rec.symbol, image: rec.image, at: Date.now(), why, url: "", tab: "", title: `$${rec.symbol}`, text: "", steps, done: false };
  const push = async (k: string, st: Step["st"], note?: string, view?: Partial<LensLive>) => {
    const s = steps.find((x) => x.k === k);
    if (s) {
      s.st = st;
      if (note) s.note = note;
    }
    Object.assign(live, view || {});
    await r.set(LIVE, live, { ex: 600 }).catch(() => {});
  };
  const d: Dossier = { mint: rec.mint, symbol: rec.symbol, at: Date.now(), why, done: false, score: 50, flags: [], good: [], site: null, x: null, talk: null, tg: null };
  let pts = 50;
  const add = (n: number, text: string) => {
    pts += n;
    (n >= 0 ? d.good : d.flags).push(text);
  };
  const xi = rec.twitter ? parseX(rec.twitter) : null;
  const tweetLinked = !!rec.wire || xi?.kind === "post";

  // 1. website
  if (rec.website) {
    let u: URL | null = null;
    try {
      u = new URL(rec.website.startsWith("http") ? rec.website : `https://${rec.website}`);
    } catch {}
    if (!u || !safeHost(u)) {
      await push("site", "bad", "not a usable link");
      add(-5, "website link is broken");
    } else {
      await push("site", "run", u.hostname, { url: u.toString(), tab: "site", title: u.hostname, text: "loading…" });
      const page = await get(u.toString(), 7000).catch(() => null);
      if (!page || !page.ok) {
        d.site = { url: u.toString(), up: false, title: "", text: "", builder: null, caOnSite: false, linksX: false, domainAgeDays: null };
        add(-10, `website ${u.hostname} does not load${page ? ` (${page.status})` : ""}`);
        await push("site", "bad", page ? `HTTP ${page.status}` : "no answer", { text: "(page did not load)" });
      } else {
        const title = strip((page.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
        const desc = (page.body.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1] || "";
        const text = strip(page.body);
        const builder = BUILDERS.find(([re]) => re.test(page.body) || re.test(page.url))?.[1] ?? null;
        const caOnSite = page.body.includes(rec.mint);
        const linksX = xi?.handle ? new RegExp(`(x|twitter)\\.com/${xi.handle}\\b`, "i").test(page.body) : false;
        const named = new RegExp(`\\b(${rec.symbol.replace(/[^A-Za-z0-9]/g, "")}|${rec.name.replace(/[^A-Za-z0-9 ]/g, "").split(" ")[0] || "zzzz"})\\b`, "i").test(`${title} ${text.slice(0, 3000)}`);
        d.site = { url: page.url, up: true, title: short(title, 90), text: short(desc || text, 400), builder, caOnSite, linksX, domainAgeDays: null };
        add(5, `website loads${builder ? ` (${builder})` : ""}`);
        if (caOnSite) add(10, "the website shows this exact CA");
        if (linksX) add(5, "the website links the same X account");
        if (!named) add(-5, "the website does not mention the coin's name or ticker");
        if (text.length < 120) add(-4, "the website is almost empty");
        await push("site", "ok", `${short(title || u.hostname, 40)}${caOnSite ? " · CA on page" : ""}`, { url: page.url, title: short(title || u.hostname, 90), text: short(desc ? `${desc}\n\n${text}` : text, 900) });

        // 2. domain age (RDAP). Free subdomains have no registration of their own.
        if (FREE_HOST.test(u.hostname)) {
          await push("domain", "skip", "free subdomain");
          add(-3, `free subdomain (${u.hostname.split(".").slice(-2).join(".")}), no domain bought`);
        } else {
          await push("domain", "run", `rdap ${u.hostname}`);
          const root = u.hostname.split(".").slice(-2).join(".");
          const rd = await get(`https://rdap.org/domain/${root}`, 6000, { accept: "application/rdap+json" }).catch(() => null);
          let age: number | null = null;
          try {
            const j = rd?.ok ? JSON.parse(rd.body) : null;
            const reg = (j?.events || []).find((e: any) => e.eventAction === "registration");
            age = days(reg?.eventDate);
          } catch {}
          if (d.site) d.site.domainAgeDays = age;
          if (age == null) await push("domain", "skip", "no record");
          else {
            if (age < 2) add(-4, `domain registered ${age < 1 ? "today" : "yesterday"}`);
            else if (age > 60) add(4, `domain is ${Math.round(age)} days old`);
            await push("domain", age < 2 ? "bad" : "ok", `${age < 1 ? "<1" : Math.round(age)} days old`);
          }
        }
      }
    }
  } else {
    await push("site", "skip", "no website");
    await push("domain", "skip");
    if (!tweetLinked) add(-8, "no website");
  }

  // 3. X: the account, the post the coin is tied to, or a community
  if (xi) {
    await push("x", "run", xi.kind === "post" ? `post by @${xi.handle}` : xi.handle ? `@${xi.handle}` : "community", { url: rec.twitter, tab: "x", title: xi.handle ? `@${xi.handle}` : "X community", text: "loading…" });
    if (xi.kind === "post" && xi.id) {
      const j = await xApi<any>(`/twitter/tweets?tweet_ids=${xi.id}`);
      const tw = j?.tweets?.[0] || j?.data?.[0] || null;
      if (tw) {
        const a = tw.author || {};
        const f = Number(a.followers ?? a.followersCount ?? 0);
        const trust = (await accountOf(String(a.userName || xi.handle || "")).catch(() => ({ w: 0 }))).w;
        d.x = { kind: "post", handle: a.userName || xi.handle, followers: f, ageDays: days(a.createdAt), posts: a.statusesCount ?? null, blue: !!a.isBlueVerified, bio: short(String(a.description || ""), 160), postText: short(String(tw.text || ""), 280), likes: Number(tw.likeCount || 0), views: Number(tw.viewCount || 0), trust };
        if (f >= 50_000) add(15, `tied to a post by @${d.x.handle} (${fmtK(f)} followers)`);
        else if (f >= 5_000) add(8, `tied to a post by @${d.x.handle} (${fmtK(f)} followers)`);
        else add(2, `tied to a post by @${d.x.handle} (${fmtK(f)} followers)`);
        if (trust >= 0.3) add(6, `WIRE trusts @${d.x.handle} (${trust})`);
        await push("x", "ok", `${fmtK(f)} followers · ${fmtK(d.x.likes || 0)} likes`, { title: `@${d.x.handle} on X`, text: `${d.x.postText}\n\n${fmtK(d.x.likes || 0)} likes · ${fmtK(d.x.views || 0)} views` });
      } else {
        d.x = { kind: "post", handle: xi.handle, followers: null, ageDays: null, posts: null, blue: false, bio: "" };
        await push("x", xOn() ? "bad" : "skip", xOn() ? "post not found" : "X reads not connected");
        if (xOn()) add(-3, "the linked post could not be read");
      }
    } else if (xi.kind === "account" && xi.handle) {
      const j = await xApi<any>(`/twitter/user/info?userName=${encodeURIComponent(xi.handle)}`);
      const a = j?.data || null;
      if (a) {
        const f = Number(a.followers ?? 0);
        const age = days(a.createdAt);
        d.x = { kind: "account", handle: a.userName || xi.handle, followers: f, ageDays: age, posts: Number(a.statusesCount ?? 0), blue: !!a.isBlueVerified, bio: short(String(a.description || ""), 160) };
        const own = new RegExp(`${rec.symbol.replace(/[^A-Za-z0-9]/g, "")}|${rec.mint.slice(0, 6)}`, "i").test(`${a.userName} ${a.name} ${a.description}`);
        if (age != null && age < 3) add(-5, `X account made ${age < 1 ? "today" : `${Math.round(age)} days ago`}`);
        if (f < 50) add(-5, `X account has ${f} followers`);
        else if (f >= 50_000) add(10, `X account @${d.x.handle} has ${fmtK(f)} followers`);
        else if (f >= 2_000) add(5, `X account has ${fmtK(f)} followers`);
        if (!own && f >= 50_000) add(-6, `links a big account (@${d.x.handle}) that is not the coin's own: borrowed X`);
        if ((d.x.posts ?? 0) <= 2 && (age ?? 99) < 7) add(-3, "X account has almost no posts");
        await push("x", f < 50 || (age ?? 99) < 3 ? "bad" : "ok", `${fmtK(f)} followers · ${age == null ? "?" : Math.round(age)}d old${d.x.blue ? " · blue" : ""}`, { title: `@${d.x.handle} on X`, text: `${a.name || ""}\n${d.x.bio}\n\n${fmtK(f)} followers · ${fmtK(d.x.posts || 0)} posts · ${age == null ? "?" : Math.round(age)} days old` });
      } else {
        d.x = { kind: "account", handle: xi.handle, followers: null, ageDays: null, posts: null, blue: false, bio: "" };
        await push("x", xOn() ? "bad" : "skip", xOn() ? "account not found" : "X reads not connected");
        if (xOn()) add(-6, `X account @${xi.handle} not found (suspended or fake link)`);
      }
    } else {
      d.x = { kind: "community", handle: null, followers: null, ageDays: null, posts: null, blue: false, bio: "" };
      await push("x", "ok", "X community link");
      add(1, "has an X community");
    }
  } else {
    await push("x", "skip", rec.twitter ? "not an X link" : "no X");
    if (!rec.wire) add(-8, "no X account or post");
  }
  if (rec.wire && !d.x) add(8, `launched ${rec.wire.lagSec}s after @${rec.wire.h} posted`);

  // 4. who is talking about it on X right now
  if (xOn()) {
    const sym = rec.symbol.replace(/[^A-Za-z0-9]/g, "");
    const q = sym.length >= 3 ? `"${rec.mint}" OR $${sym}` : `"${rec.mint}"`;
    await push("talk", "run", q.length > 40 ? `CA or $${sym}` : q, { url: `https://x.com/search?q=${encodeURIComponent(q)}&f=live`, tab: "talk", title: "X search · latest", text: "searching…" });
    const j = await xApi<any>(`/twitter/tweet/advanced_search?query=${encodeURIComponent(q)}&queryType=Latest`);
    const tweets: any[] = j?.tweets || [];
    const hourAgo = Date.now() - 3600_000;
    const recent = tweets.filter((t) => new Date(t.createdAt || 0).getTime() >= hourAgo);
    const by = new Map<string, any>();
    for (const t of recent) {
      const h = t.author?.userName;
      if (h && !by.has(h)) by.set(h, t);
    }
    const authors = [...by.values()];
    const reach = authors.reduce((s, t) => s + Number(t.author?.followers || 0), 0);
    const known: string[] = [];
    for (const t of authors.slice(0, 12)) {
      const w = (await accountOf(t.author.userName).catch(() => ({ w: 0 }))).w;
      if (w >= 0.3) known.push(t.author.userName);
    }
    const top = authors
      .sort((a, b) => Number(b.author?.followers || 0) - Number(a.author?.followers || 0))
      .slice(0, 4)
      .map((t) => ({ h: t.author.userName, f: Number(t.author.followers || 0), text: short(String(t.text || ""), 160), url: t.url || `https://x.com/${t.author.userName}/status/${t.id}` }));
    d.talk = { posts: recent.length, authors: by.size, reach, top, known };
    if (j == null) await push("talk", "skip", "search failed");
    else {
      if (by.size === 0) add(-6, "nobody on X has posted the CA or ticker in the last hour");
      else if (by.size >= 30) add(14, `${by.size} accounts posted it in the last hour (${fmtK(reach)} reach)`);
      else if (by.size >= 10) add(8, `${by.size} accounts posted it in the last hour`);
      else add(2, `${by.size} account${by.size > 1 ? "s" : ""} posted it in the last hour`);
      if (known.length) add(10, `posted by accounts WIRE trusts: @${known.slice(0, 3).join(", @")}`);
      const bots = recent.length >= 10 && by.size <= recent.length / 4;
      if (bots) add(-6, `${recent.length} posts from only ${by.size} accounts: looks like shilling bots`);
      await push("talk", by.size ? "ok" : "bad", `${by.size} accounts · ${fmtK(reach)} reach`, { text: top.length ? top.map((t) => `@${t.h} (${fmtK(t.f)}): ${t.text}`).join("\n\n") : "No posts in the last hour." });
    }
  } else await push("talk", "skip", "X reads not connected");

  // 5. Telegram member count from the public preview page
  if (rec.telegram && /t\.me\//i.test(rec.telegram)) {
    const name = rec.telegram.split(/t\.me\//i)[1]?.split(/[/?#]/)[0] || "";
    if (/^[A-Za-z0-9_+]{3,64}$/.test(name) && !name.startsWith("+")) {
      await push("tg", "run", `t.me/${name}`, { url: `https://t.me/${name}`, tab: "tg", title: `t.me/${name}`, text: "loading…" });
      const pg = await get(`https://t.me/${name}`, 6000).catch(() => null);
      const extra = pg?.ok ? strip((pg.body.match(/tgme_page_extra[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "") : "";
      const mm = extra.replace(/\s/g, "").match(/([\d]+)(members|subscribers)/i);
      const members = mm ? Number(mm[1]) : null;
      d.tg = { url: `https://t.me/${name}`, members };
      if (members != null && members >= 300) add(4, `Telegram has ${fmtK(members)} members`);
      else if (members != null && members < 20) add(-2, `Telegram has ${members} members`);
      await push("tg", members == null ? "skip" : "ok", members == null ? "no member count" : `${fmtK(members)} members`, { text: extra || "(no preview)" });
    } else {
      d.tg = { url: rec.telegram, members: null };
      await push("tg", "skip", "private invite link");
    }
  } else await push("tg", "skip", "no Telegram");

  d.score = Math.max(0, Math.min(100, Math.round(pts)));
  d.done = true;
  d.flags = d.flags.slice(0, 6);
  d.good = d.good.slice(0, 6);
  await push("verdict", d.score >= 60 ? "ok" : d.score < 40 ? "bad" : "ok", `${d.score}/100`, { score: d.score, done: true, tab: "verdict", title: `$${rec.symbol} · LENS ${d.score}/100`, text: [...d.good.map((x) => `+ ${x}`), ...d.flags.map((x) => `- ${x}`)].join("\n") });
  return d;
}

const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));

// ---------------------------------------------------------------- the session

/** Work the queue for up to `ms` (inside the minute run). One coin at a time, so the LensCam reads like a person. */
export async function lensSession(ms: number) {
  const r = redis();
  const end = Date.now() + ms;
  if (!(await r.set(LOCK, 1, { nx: true, ex: Math.ceil(ms / 1000) + 5 }))) return { lens: "busy" };
  let done = 0;
  try {
    while (Date.now() < end - 8000) {
      const hk = HOUR(Date.now());
      if (Number((await r.get(hk)) || 0) >= MAX_PER_HOUR) break;
      const top = (await r.zpopmax<string>(Q, 1)) as any[];
      if (!top?.length) {
        await new Promise((res) => setTimeout(res, 2000));
        continue;
      }
      const member = String(top[0]);
      const score = Number(top[1]);
      const [why, mint] = member.split(":") as [LensWhy, string];
      if (Date.now() - (score % 1e13) > MAX_AGE_MS) continue;
      const old = await r.get<Dossier>(LENS_D(mint));
      if (old?.done && Date.now() - old.at < 2 * 3600_000 && why !== "buy") continue;
      if (old?.done && Date.now() - old.at < 10 * 60_000) continue;
      const rec = await r.get<Launch>(K.launch(mint));
      if (!rec) continue;
      await r.incr(hk);
      await r.expire(hk, 7200);
      const d = await investigate(rec, why).catch(() => null);
      if (!d) continue;
      done++;
      const p = r.pipeline();
      p.set(LENS_D(mint), d, { ex: 7 * 86400 });
      p.lpush(HIST, { mint, symbol: d.symbol, at: d.at, why, score: d.score, flags: d.flags.slice(0, 2), good: d.good.slice(0, 2) });
      p.ltrim(HIST, 0, 29);
      agentLog(p, [{ agent: "LENS", at: Date.now(), mint, symbol: d.symbol, text: `$${d.symbol} ${d.score}/100${d.good[0] ? ` · + ${d.good[0]}` : ""}${d.flags[0] ? ` · - ${d.flags[0]}` : ""}`, tone: d.score >= 60 ? "ok" : d.score < 40 ? "bad" : "info", stance: Math.max(-1, Math.min(1, (d.score - 50) / 40)) }]);
      await p.exec();
    }
  } finally {
    await r.del(LOCK).catch(() => {});
  }
  return { lens: done };
}
