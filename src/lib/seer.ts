// v0.1.102 SEER: see the coin before it exists.
//
// FTR (16 Oct): the Roadster demo date was public 33 days ahead; a 130K-follower account posted "Roadster is launching
// tomorrow" and 135 seconds later "Flying Tesla Roadster" was created. The King called it at minute 5 ($28.2K) and it
// went 246x, but nothing was armed to buy it. Research (15.2M pump.fun coins): 23.5% of launches follow a post, and the
// biggest posts (large accounts, images or video) hold most of the value; the first coin of a meme graduates ~10x more
// often than its copies.
//
// SEER keeps a watchlist of coins that are likely to be launched:
//   1. what is coming: Polymarket events (end dates, sudden volume), rocket launches (Launch Library), the posts of the
//      accounts that move this market (WIRE already streams them), X trends, Google Trends "trending now", PULSE;
//   2. a forecaster (Claude Haiku) turns each new item into the names and tickers a coin would be launched under, how
//      big it is (tier 1 to 3) and how long to watch. It only writes the watchlist, it never decides a trade;
//   3. every new launch is matched against the watchlist the moment the firehose sees it (name and ticker), and again
//      at the dig (description and linked post). The first coin for an entry is marked first, later ones are copies.
// The foreseen coins trade on GRID LIVE (paper) in the SEER family; the desk can follow one only through the exams.
import { redis } from "./redis";
import { ask, json, llmOn } from "./llm";

const ARMED_KEY = "rn:seer:armed"; // hash id -> Armed
const SEEN_KEY = "rn:seer:seen"; // hash item id -> at (an item is forecast once)
const VIEW_KEY = "rn:seer:view";
export const MATCH_KEY = (m: string) => `rn:seer:m:${m}`;
const ARMED_MAX = 600;
const TIMEOUT = 8_000;
const model = () => process.env.SEER_MODEL || "claude-haiku-4-5-20251001";

export type Item = { id: string; src: string; title: string; at: number | null; weight: number };
export type Armed = { id: string; title: string; src: string; names: string[]; tickers: string[]; tier: 1 | 2 | 3; at: number | null; until: number; armedAt: number; why: string; hits: number; first: string | null };
export type SeerMatch = { id: string; title: string; tier: 1 | 2 | 3; rank: number; at: number | null; by: "ticker" | "name" | "text"; lagMs: number; on?: string };

// the accounts whose posts most often become coins (WIRE streams their posts already)
export const VIPS = ["elonmusk", "tesla", "spacex", "xai", "grok", "realdonaldtrump", "cz_binance", "openai", "sama", "nvidia", "whitehouse", "potus", "kanyewest", "mrbeast"];

export const norm = (s: string) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

// ---------------------------------------------------------------- the armed watchlist (memory index, Redis copy)
const ARMED = new Map<string, Armed>();
let NAMES: { p: string; id: string }[] = [];
let TICKS = new Map<string, string[]>();
function reindex(now = Date.now()) {
  for (const [k, a] of ARMED) if (a.until < now) ARMED.delete(k);
  NAMES = [];
  TICKS = new Map();
  for (const a of ARMED.values()) {
    for (const n of a.names) {
      const p = norm(n);
      if (p.length >= 5) NAMES.push({ p, id: a.id });
    }
    for (const t of a.tickers) {
      const p = norm(t);
      if (p.length >= 3) TICKS.set(p, [...(TICKS.get(p) || []), a.id]);
    }
  }
  NAMES.sort((x, y) => y.p.length - x.p.length); // the longest (most specific) name wins
}
export const seerArmed = () => [...ARMED.values()];

export async function seerLoad(now = Date.now()) {
  const all = ((await redis().hgetall<Record<string, Armed>>(ARMED_KEY).catch(() => null)) || {}) as Record<string, Armed>;
  for (const a of Object.values(all)) if (a && a.until > now) ARMED.set(a.id, a);
  reindex(now);
  return ARMED.size;
}

export function arm(a: Armed, now = Date.now()) {
  if (!a.names.length && !a.tickers.length) return false;
  ARMED.set(a.id, a);
  if (ARMED.size > ARMED_MAX) {
    const old = [...ARMED.values()].sort((x, y) => x.armedAt - y.armedAt).slice(0, ARMED.size - ARMED_MAX);
    for (const o of old) ARMED.delete(o.id);
  }
  reindex(now);
  redis().hset(ARMED_KEY, { [a.id]: a }).catch(() => null);
  return true;
}

// ---------------------------------------------------------------- matching (the firehose's create, then the dig)
const MATCHED = new Map<string, SeerMatch>(); // mint -> match (this process)
export const seerOf = (mint: string) => MATCHED.get(mint) || null;

function pick(ids: string[], now: number): Armed | null {
  const live = ids.map((i) => ARMED.get(i)).filter((a): a is Armed => !!a && a.until >= now);
  live.sort((x, y) => x.tier - y.tier || y.armedAt - x.armedAt);
  return live[0] || null;
}

/**
 * Match a new launch against the watchlist. At the create only name and ticker are known (seconds count); the dig
 * adds the description and the linked post's text. Returns the match (and records the coin's rank for that entry).
 */
export function seerSee(mint: string, name: string, symbol: string, createdAt: number, text = "", now = Date.now()): SeerMatch | null {
  if (!mint || !ARMED.size) return null;
  const had = MATCHED.get(mint);
  if (had) return had;
  let a: Armed | null = null;
  let by: SeerMatch["by"] = "ticker";
  let on = "";
  const t = norm(symbol);
  if (t.length >= 3 && TICKS.has(t)) (a = pick(TICKS.get(t)!, now)), (on = t);
  if (!a) {
    const n = norm(name);
    if (n.length >= 4) {
      const hit = NAMES.find((x) => n.includes(x.p) || (n.length >= 6 && x.p.includes(n)));
      if (hit) (a = pick([hit.id], now)), (by = "name"), (on = hit.p);
    }
  }
  if (!a && text) {
    const tx = norm(text);
    const hit = NAMES.find((x) => x.p.length >= 6 && tx.includes(x.p));
    if (hit) (a = pick([hit.id], now)), (by = "text"), (on = hit.p);
  }
  if (!a) return null;
  a.hits += 1;
  if (!a.first) a.first = mint;
  const m: SeerMatch = { id: a.id, title: a.title, tier: a.tier, rank: a.hits, at: a.at, by, lagMs: Math.max(0, now - createdAt), on }; // v0.1.103: which watched name or ticker it matched
  MATCHED.set(mint, m);
  if (MATCHED.size > 20_000) MATCHED.delete(MATCHED.keys().next().value as string);
  const r = redis();
  r.set(MATCH_KEY(mint), m, { ex: 7 * 86400 }).catch(() => null);
  r.hset(ARMED_KEY, { [a.id]: a }).catch(() => null);
  r.lpush("rn:seer:matches", { mint, ...m, sym: symbol, at0: now }).then(() => r.ltrim("rn:seer:matches", 0, 199)).catch(() => null);
  return m;
}

// ---------------------------------------------------------------- collectors (free, or nearly)
async function getJson(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}
async function getText(url: string) {
  const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.text();
}
const lg = (x: number) => Math.log10(Math.max(1, x));

export async function fromPolymarket(): Promise<Item[]> {
  const j: any = await getJson("https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=40");
  return (Array.isArray(j) ? j : []).map((e: any) => ({ id: `pm:${e.slug || e.id}`, src: "polymarket", title: String(e.title || "").slice(0, 200), at: e.endDate ? Date.parse(e.endDate) || null : null, weight: lg(Number(e.volume24hr) || 0) })).filter((x: Item) => x.title);
}
export async function fromLaunches(): Promise<Item[]> {
  const j: any = await getJson("https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=8&mode=list");
  return (j?.results || []).map((l: any) => ({ id: `ll:${l.id}`, src: "launch", title: String(l.name || "").slice(0, 200), at: l.net ? Date.parse(l.net) || null : null, weight: 4 }));
}
export async function fromGoogleTrends(): Promise<Item[]> {
  const x = await getText("https://trends.google.com/trending/rss?geo=US");
  const out: Item[] = [];
  for (const m of x.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const t = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const tr = Number(((m[1].match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/) || [])[1] || "").replace(/[^0-9]/g, "")) || 0;
    if (t) out.push({ id: `gt:${norm(t)}`, src: "gtrends", title: t.slice(0, 200), at: null, weight: lg(tr) });
  }
  return out.slice(0, 20);
}
export async function fromXTrends(): Promise<Item[]> {
  if (!process.env.X_API_KEY) return [];
  const { xAllowed, xSpend } = await import("./xcredits");
  if (!(await xAllowed(0.7, true))) return [];
  const j: any = await getJson("https://api.twitterapi.io/twitter/trends?woeid=1", { "X-API-Key": process.env.X_API_KEY! });
  await xSpend("SEER trends", 450);
  const list = j?.trends || j?.data || [];
  return (Array.isArray(list) ? list : []).slice(0, 30).map((t: any) => {
    const name = String(t?.name || t?.trend?.name || "").trim();
    return { id: `xt:${norm(name)}`, src: "xtrends", title: name, at: null, weight: lg(Number(t?.tweet_volume || t?.trend?.target?.tweet_volume) || 1000) };
  }).filter((x: Item) => x.title);
}
export async function fromPulse(): Promise<Item[]> {
  const v: any = await redis().get("rn:pl:view").catch(() => null);
  return ((v?.rising || []) as any[]).filter((x) => Number(x.x) >= 8).slice(0, 12).map((x) => ({ id: `pl:${norm(x.term)}`, src: "pulse", title: `rising on X: ${x.term} (${x.posts15} posts in 15 min, ${x.x}x usual)`, at: null, weight: lg(Number(x.now) || 1) }));
}
/** The posts that most often become coins: the market movers' own accounts, and any post from a 100K+ account. */
export async function fromPosts(): Promise<Item[]> {
  const { recentTweets } = await import("./wire");
  const ts = await recentTweets(3 * 3600_000).catch(() => [] as any[]);
  return (ts as any[])
    .filter((t) => VIPS.includes(String(t.h || "").toLowerCase()) || Number(t.f) >= 100_000)
    .slice(0, 40)
    .map((t) => ({ id: `tw:${t.id}`, src: "post", title: `@${t.h} (${Math.round((Number(t.f) || 0) / 1000)}K followers): ${String(t.text || "").replace(/\s+/g, " ").slice(0, 240)}`, at: Number(t.at) || null, weight: lg(Number(t.f) || 1) + (VIPS.includes(String(t.h || "").toLowerCase()) ? 3 : 0) }));
}

// ---------------------------------------------------------------- the forecaster
const SYSTEM = `You are SEER, the watchlist writer of a pump.fun memecoin trading desk.
You get items: events coming up, trending searches, rising X topics and posts from big accounts. For each item, decide whether people are likely to launch a memecoin about it on pump.fun in the next days (a famous person, product, event, animal, catchphrase, meme or news moment that crypto traders would recognise). Most items will not be. Be strict: only items a trader would actually make a coin of.
For each item that will be: the exact coin names and tickers people would launch it under (what they would type into pump.fun: short, catchy, literal; 2 to 6 names, 2 to 6 tickers of 3 to 10 letters), the tier (1 = a market mover like Elon Musk, Trump or a global event; 2 = a big story; 3 = a niche one), the moment it happens if known (ISO time) and how many hours to keep watching (6 to 72).
Example: "Tesla: the new Roadster demo streams Thursday 7:55pm CST" -> names ["Flying Tesla Roadster","Tesla Roadster","Flying Roadster","Roadster"], tickers ["FTR","ROADSTER","FLYING","TROAD"], tier 1.
Answer with JSON only: {"arm":[{"id":"<item id>","names":[...],"tickers":[...],"tier":1,"at":"<ISO or null>","hours":48,"why":"<one short line>"}]}`;

export function checkArm(x: any, items: Map<string, Item>, now = Date.now()): Armed | null {
  const it = items.get(String(x?.id || ""));
  if (!it) return null;
  const clean = (a: any, max: number, re: RegExp) => (Array.isArray(a) ? a : []).map((s) => String(s || "").trim()).filter((s) => s && s.length <= max && re.test(s)).slice(0, 8);
  const names = clean(x.names, 40, /[a-z0-9]/i);
  const tickers = clean(x.tickers, 10, /^[a-z0-9$]{3,10}$/i).map((t) => t.replace(/^\$/, ""));
  if (!names.length && !tickers.length) return null;
  const tier = ([1, 2, 3].includes(Number(x.tier)) ? Number(x.tier) : 3) as 1 | 2 | 3;
  const at0 = x.at ? Date.parse(String(x.at)) : NaN;
  const at = Number.isFinite(at0) ? at0 : it.at;
  const hours = Math.max(6, Math.min(72, Number(x.hours) || 24));
  // watch until the event plus a day, or for the hours given (whichever is later), at most 8 days out
  const until = Math.min(now + 8 * 86400_000, Math.max(now + hours * 3600_000, at ? at + 24 * 3600_000 : 0));
  return { id: it.id, title: it.title.slice(0, 160), src: it.src, names, tickers, tier, at: at || null, until, armedAt: now, why: String(x.why || "").slice(0, 160), hits: 0, first: null };
}

export const seerStats = { runs: 0, items: 0, armed: 0, lastAt: 0, lastErr: "", src: {} as Record<string, number> };
let lastSlow = 0;

/** One pass (worker, every 10 minutes): collect, forecast what is new, arm it. */
export async function seerTick(now = Date.now(), forecast = ask) {
  const r = redis();
  const slow = now - lastSlow > 30 * 60_000; // Launch Library allows 15 calls an hour, X trends cost credits
  if (slow) lastSlow = now;
  const jobs: [string, () => Promise<Item[]>][] = [
    ["polymarket", fromPolymarket],
    ["gtrends", fromGoogleTrends],
    ["pulse", fromPulse],
    ["post", fromPosts],
    ...(slow ? ([["launch", fromLaunches], ["xtrends", fromXTrends]] as [string, () => Promise<Item[]>][]) : []),
  ];
  const got = await Promise.all(jobs.map(([k, f]) => f().then((x) => ((seerStats.src[k] = x.length), x)).catch((e) => ((seerStats.lastErr = `${k}: ${String(e?.message || e).slice(0, 60)}`), [] as Item[]))));
  const all = got.flat();
  const seen = ((await r.hmget<Record<string, number>>(SEEN_KEY, ...(all.length ? all.map((x) => x.id) : ["-"])).catch(() => null)) || {}) as Record<string, number | null>;
  const fresh = all.filter((x) => !seen[x.id]).sort((a, b) => b.weight - a.weight).slice(0, 25);
  seerStats.runs++;
  seerStats.lastAt = now;
  seerStats.items = all.length;
  let armedNow = 0;
  if (fresh.length && llmOn()) {
    const items = new Map(fresh.map((x) => [x.id, x]));
    const text = await forecast(SYSTEM, [{ type: "text", text: `Now: ${new Date(now).toISOString()}\n\nItems:\n${fresh.map((x) => `- id ${x.id} [${x.src}]${x.at ? ` (time ${new Date(x.at).toISOString()})` : ""}: ${x.title}`).join("\n")}` }], 2500, 90_000, model()).catch(() => null);
    const j = json<{ arm?: any[] }>(text);
    for (const x of j?.arm || []) {
      const a = checkArm(x, items, now);
      if (a && arm(a, now)) armedNow++;
    }
    const p = r.pipeline();
    for (const x of fresh) p.hset(SEEN_KEY, { [x.id]: now });
    await p.exec().catch(() => null);
    if (!text) seerStats.lastErr = "no answer from the forecaster";
  }
  seerStats.armed = ARMED.size;
  await r.set(VIEW_KEY, { at: now, stats: { ...seerStats }, armed: [...ARMED.values()].sort((a, b) => a.tier - b.tier || b.armedAt - a.armedAt).slice(0, 40).map((a) => ({ id: a.id, title: a.title, src: a.src, tier: a.tier, at: a.at, until: a.until, names: a.names, tickers: a.tickers, hits: a.hits, first: a.first, why: a.why })) }, { ex: 3600 }).catch(() => null);
  // the seen list never grows without end: once a day it starts over (an item still trending is forecast again)
  if (now % (24 * 3600_000) < 10 * 60_000) await r.del(SEEN_KEY).catch(() => null);
  return { items: all.length, fresh: fresh.length, armed: armedNow, total: ARMED.size };
}

/** Tests only. */
export const _seerReset = () => (ARMED.clear(), MATCHED.clear(), reindex());
