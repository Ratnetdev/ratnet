// WIRE: the social monitor. Tracks X accounts whose posts spawn coins, finds the pump.fun launches born from each
// post, picks the real one out of the copies, and hands it to the desk as its own strategy (sleeve "wire").
// It learns per account: how often a post sparks a launch, how often the picked coin runs, and what the desk made on
// it. It grows its own account list from what actually moves coins, and mutes accounts that never do.
// Data: twitterapi.io filter rules push tweets to /api/x/hook within seconds (X_API_KEY + the webhook URL set in the
// twitterapi.io dashboard). Without a key WIRE stays idle.
import { redis } from "./redis";
import { X_SEED } from "@/config/x-accounts";
import { agentLog } from "./agents";
import { K } from "./redis";
import { getSettings } from "./settings";
import { notePulse } from "./pulse";
import { j7Covered, j7State } from "./j7";
import { pulseView } from "./pulse";

export type XTweet = { id: string; h: string; name?: string; f: number; at: number; text: string; terms: string[]; url: string; kind: "post" | "reply" | "quote" | "rt"; inner?: string; ca?: string; src?: string };
export type WireMatch = { tid: string; h: string; score: number; how: string; lagSec: number; text: string; pick?: boolean };
type Acc = { h: string; cat: string; tier: "seed" | "found" | "j7" | "muted"; added: number; why?: string };

const ACC = "rn:x:acc"; // handle -> Acc
const ST = "rn:x:st"; // {h}:tweets|sparks|picks|runs|pnl (counters)
const TW = "rn:x:tw"; // newest first, last 400 tweets
const SEEN = (id: string) => `rn:x:seen:${id}`;
const CAND = (tid: string) => `rn:x:cand:${tid}`; // mints that match a tweet, scored by match strength
const OPEN = "rn:x:open"; // tweets with candidates waiting for a pick, scored by first candidate time
const PICKED = (tid: string) => `rn:x:pk:${tid}`;
const SPARK = (tid: string) => `rn:x:sp:${tid}`;
const FOUND = "rn:x:found"; // candidate handles -> evidence points
const DIRTY = "rn:x:dirty"; // watchlist changed: rules need a sync
const RULES = "rn:x:rules"; // last synced rule ids
export const WIRE_Q = (m: string) => `w:${m}`; // desk queue member for a wire signal

export const xOn = () => !!process.env.X_API_KEY;
const API = "https://api.twitterapi.io";

const STOP = new Set(
  "the a an and or but if then so to of in on at by for with from as is are was were be been being it its this that these those i you he she we they me him her us them my your his our their what which who whom whose when where why how all any both each few more most other some such no nor not only own same than too very can will just don should now new one get got just like also into about over after before under again out up down off here there https http www com amp rt via today breaking just coming going come goes went make made said says say see seen look looks need want wants know think thing things time year years day days week people really good great best big biggest first last next much many every never always still even way back right left yes yeah lol lmao gm gn ser fren wow send sending sent ape aped aping pump pumping buy buying bought sell selling sold dump dumping rug rugged bullish bearish bull bear lfg huge massive gem gems chart charts coin coins token tokens holders hold holding launch launched market crypto".split(" "),
);

/** The words a coin made from this post would be named after. */
export function termsOf(text: string): string[] {
  const t = text.replace(/https?:\/\/\S+/g, " ");
  const out: string[] = [];
  const add = (w: string) => {
    const k = w.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (k.length >= 3 && k.length <= 24 && !STOP.has(k) && !out.includes(k)) out.push(k);
  };
  (t.match(/\$[A-Za-z][A-Za-z0-9]{1,11}/g) || []).forEach((x) => add(x.slice(1)));
  (t.match(/#[A-Za-z0-9_]{2,30}/g) || []).forEach((x) => add(x.slice(1)));
  (t.match(/"([^"]{3,30})"/g) || []).forEach((x) => add(x.replace(/"/g, "")));
  const words = t.split(/[^A-Za-z0-9']+/).filter(Boolean);
  // capitalised words and pairs ("Kekius Maximus" -> kekiusmaximus) first, then the rest
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^[A-Z]/.test(w) && words[i + 1] && /^[A-Z]/.test(words[i + 1])) add(w + words[i + 1]);
  }
  words.filter((w) => /^[A-Z]/.test(w)).forEach(add);
  words.forEach(add);
  return out.slice(0, 14);
}

/** Accept the payload shapes twitterapi.io sends (a list, {tweets}, {tweet}) and normalise each tweet. */
export function parseHook(body: any): XTweet[] {
  const list: any[] = Array.isArray(body) ? body : body?.tweets || (body?.tweet ? [body.tweet] : body?.data ? [].concat(body.data) : []);
  const out: XTweet[] = [];
  for (const t of list) {
    if (!t?.id || !t?.author?.userName) continue;
    const rt = t.retweeted_tweet;
    const q = t.quoted_tweet;
    const kind: XTweet["kind"] = rt ? "rt" : q ? "quote" : t.isReply ? "reply" : "post";
    const text = String(rt?.text || t.text || "");
    const inner = q?.text ? String(q.text) : undefined;
    const at = Date.parse(t.createdAt) || Date.now();
    out.push({ id: String(t.id), h: String(t.author.userName), name: t.author.name, f: Number(t.author.followers || 0), at, text: text.slice(0, 400), terms: termsOf(`${text} ${inner || ""}`), url: t.url || `https://x.com/${t.author.userName}/status/${t.id}`, kind, inner: inner?.slice(0, 200), src: "tapi" });
  }
  return out;
}

export async function ensureSeed() {
  const r = redis();
  if (await r.exists(ACC)) return;
  const now = Date.now();
  const obj: Record<string, Acc> = {};
  for (const s of X_SEED) obj[s.h.toLowerCase()] = { h: s.h, cat: s.cat, tier: "seed", added: now };
  await r.hset(ACC, obj);
  await r.set(DIRTY, 1);
}

/** New posts from any source (J7 feed, twitterapi.io webhook): store, count, feed PULSE, act on posted CAs. */
export async function ingest(tweets: XTweet[]) {
  const r = redis();
  await ensureSeed();
  const accs = ((await r.hgetall<Record<string, Acc>>(ACC)) || {}) as Record<string, Acc>;
  const p = r.pipeline();
  const newAccs: Record<string, Acc> = {};
  const cas: XTweet[] = [];
  let n = 0;
  for (const t of tweets) {
    if (!t.terms?.length) t.terms = termsOf(`${t.text} ${t.inner || ""}`);
    const isNew = !!(await r.set(SEEN(t.id), 1, { nx: true, ex: 3 * 86400 }));
    // a later copy of a post can carry the contract address the first one didn't
    if (t.ca && (await r.set(SEEN(`${t.id}|ca`), 1, { nx: true, ex: 3 * 86400 }))) cas.push(t);
    if (!isNew) continue;
    n++;
    p.lpush(TW, t);
    p.hincrby(ST, `${t.h.toLowerCase()}:tweets`, 1);
    notePulse(p as any, t);
    const key = t.h.toLowerCase();
    // every account J7 or twitterapi.io sends us becomes one WIRE scores
    if (!accs[key] && !newAccs[key]) newAccs[key] = { h: t.h, cat: t.src && t.src !== "tapi" ? `j7${t.src !== "j7" ? `:${t.src}` : ""}` : "found", tier: "j7", added: Date.now(), why: `on the ${t.src && t.src !== "tapi" ? "J7" : "X"} feed` };
    for (const m of t.text.match(/@([A-Za-z0-9_]{2,15})/g) || []) {
      const h = m.slice(1).toLowerCase();
      if (!accs[h]) p.hincrby(FOUND, h, 1);
    }
    const acc = accs[key] || newAccs[key];
    if (acc?.tier !== "muted" && t.kind !== "reply" && (acc?.tier === "seed" || t.f >= 50_000 || t.ca))
      agentLog(p, [{ agent: "WIRE", at: Date.now(), text: `@${t.h}${t.src && !["j7", "tapi"].includes(t.src) ? ` on ${t.src}` : ""}${t.kind === "rt" ? " reposted" : t.kind === "quote" ? " quoted" : ""}: "${t.text.slice(0, 90)}${t.text.length > 90 ? "…" : ""}"${t.ca ? " · posted a CA" : ` · watching launches for ${t.terms.slice(0, 4).join(", ") || "anything linked"}`}`, tone: t.ca ? "ok" : "info" }]);
  }
  if (Object.keys(newAccs).length) p.hset(ACC, newAccs);
  p.ltrim(TW, 0, 399);
  await p.exec();
  for (const t of cas) await onCA(t).catch(() => {});
  return { stored: n, cas: cas.length };
}

/** A tracked account posted a contract address. If the rats know the coin, it goes to the desk right away. */
async function onCA(t: XTweet) {
  const r = redis();
  const rec = await r.get<any>(K.launch(t.ca!));
  if (!rec || rec.outcome || rec.wire?.pick) return; // unknown coins are matched when the rats dig them (see matchOne)
  if (!(await r.set(PICKED(t.id), t.ca!, { nx: true, ex: 3 * 86400 }))) return;
  rec.wire = { tid: t.id, h: t.h, score: 1, how: "posted the CA", lagSec: Math.max(0, Math.round((t.at - rec.createdAt) / 1000)), text: t.text.slice(0, 160), pick: true };
  await r.set(K.launch(rec.mint), rec, { keepTtl: true });
  await r.hincrby(ST, `${t.h.toLowerCase()}:picks`, 1);
  if (await r.set(SPARK(t.id), 1, { nx: true, ex: 3 * 86400 })) await r.hincrby(ST, `${t.h.toLowerCase()}:sparks`, 1);
  const { w } = await accountOf(t.h);
  const min = (await getSettings()).desk.wireMinW ?? 0.2;
  const p = r.pipeline();
  if (w >= min) p.zadd(K.deskQ, { score: Date.now(), member: WIRE_Q(rec.mint) });
  agentLog(p, [{ agent: "WIRE", at: Date.now(), mint: rec.mint, symbol: rec.symbol, text: `@${t.h} posted the CA of $${rec.symbol}. trust ${w}${w >= min ? ", sent to the desk" : ": learning only"}`, tone: w >= min ? "ok" : "info" }]);
  await p.exec();
}

const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Does a new launch come from a tracked post? Strongest: the coin links the post itself. */
export function matchOne(l: { mint: string; name: string; symbol: string; description: string; twitter: string; createdAt: number }, tweets: XTweet[]): WireMatch | null {
  let best: WireMatch | null = null;
  const sym = norm(l.symbol);
  const name = norm(l.name);
  const tw = (l.twitter || "").toLowerCase();
  const desc = (l.description || "").toLowerCase();
  for (const t of tweets) {
    const lag = Math.round((l.createdAt - t.at) / 1000);
    if (lag < -30 || lag > 3600) continue;
    let score = 0;
    let how = "";
    if (t.ca && t.ca === l.mint) [score, how] = [1, "posted the CA"];
    else if (tw.includes(`/status/${t.id}`) || desc.includes(`/status/${t.id}`)) [score, how] = [1, "links the post"];
    else {
      for (const term of t.terms) {
        if (term.length >= 3 && (sym === term || name === term)) {
          if (score < 0.85) [score, how] = [0.85, `named "${term}"`];
        } else if (term.length >= 5 && name.includes(term) && score < 0.55) [score, how] = [0.55, `name has "${term}"`];
      }
      if (score && tw.includes(`x.com/${t.h.toLowerCase()}`) || score && tw.includes(`twitter.com/${t.h.toLowerCase()}`)) score = Math.min(1, score + 0.1);
    }
    // the sooner after the post, the likelier it is the coin about it
    if (score) score = Math.round(score * (lag <= 300 ? 1 : lag <= 900 ? 0.85 : 0.65) * 100) / 100;
    if (score >= 0.5 && (!best || score > best.score)) best = { tid: t.id, h: t.h, score, how, lagSec: Math.max(0, lag), text: t.text.slice(0, 160) };
  }
  return best;
}

export async function recentTweets(maxAgeMs = 3600_000) {
  const all = ((await redis().lrange<XTweet>(TW, 0, 199)) || []) as XTweet[];
  return all.filter((t) => Date.now() - t.at <= maxAgeMs && t.kind !== "reply");
}

/** Record a match from the digger (pipeline). */
export function noteMatch(p: { zadd: Function; expire: Function; set: Function; hincrby: Function }, mint: string, createdAt: number, m: WireMatch) {
  p.zadd(CAND(m.tid), { score: m.score, member: mint });
  p.expire(CAND(m.tid), 6 * 3600);
  p.zadd(OPEN, { nx: true }, { score: createdAt, member: m.tid });
  p.hincrby(ST, `${m.h.toLowerCase()}:matches`, 1);
}

/** For tweets with launches: after 30s, pick the leader (most real SOL in, best match), once. */
export async function dueTweets() {
  const r = redis();
  const now = Date.now();
  const ids = ((await r.zrange<string[]>(OPEN, 0, now - 30_000, { byScore: true, offset: 0, count: 10 })) || []).map(String);
  const out: { tid: string; mints: { mint: string; score: number }[]; age: number }[] = [];
  for (const tid of ids) {
    if (await r.exists(PICKED(tid))) {
      await r.zrem(OPEN, tid); // a late copy re-opened a post that already has its coin
      continue;
    }
    const first = Number((await r.zscore(OPEN, tid)) || now);
    const flat = ((await r.zrange<(string | number)[]>(CAND(tid), 0, 29, { rev: true, withScores: true })) || []) as (string | number)[];
    const mints: { mint: string; score: number }[] = [];
    for (let i = 0; i < flat.length; i += 2) mints.push({ mint: String(flat[i]), score: Number(flat[i + 1]) });
    out.push({ tid, mints, age: now - first });
  }
  return out;
}
export async function closeTweet(tid: string, picked: string | null, h: string) {
  const r = redis();
  await r.zrem(OPEN, tid);
  if (picked) {
    await r.set(PICKED(tid), picked, { ex: 3 * 86400 });
    await r.hincrby(ST, `${h.toLowerCase()}:picks`, 1);
  }
  if (await r.set(SPARK(tid), 1, { nx: true, ex: 3 * 86400 })) await r.hincrby(ST, `${h.toLowerCase()}:sparks`, 1);
}

/** Outcome learning: a coin born from a tracked post bonded (or a desk trade on it closed). */
export function noteOutcome(p: { hincrby: Function; hincrbyfloat?: Function }, h: string, bonded: boolean) {
  if (bonded) p.hincrby(ST, `${h.toLowerCase()}:runs`, 1);
}
export async function notePnl(h: string, pnlSol: number) {
  await redis().hincrbyfloat(ST, `${h.toLowerCase()}:pnl`, pnlSol);
}

/** Discovery: the author of a post a bonded coin links to is evidence; two coins and the account joins the list. */
export function noteBondLink(p: { hincrby: Function }, twitterUrl: string) {
  const m = /(?:x|twitter)\.com\/([A-Za-z0-9_]{2,15})\/status\/\d+/i.exec(twitterUrl || "");
  if (m) p.hincrby(FOUND, m[1].toLowerCase(), 3);
}

/** Promote found accounts with enough evidence, mute dead ones. Runs once a minute. */
export async function curate() {
  const r = redis();
  await ensureSeed();
  const [accs, found, st] = await Promise.all([r.hgetall<Record<string, Acc>>(ACC), r.hgetall<Record<string, number>>(FOUND), r.hgetall<Record<string, number>>(ST)]);
  const A = (accs || {}) as Record<string, Acc>;
  const F = (found || {}) as Record<string, number>;
  const S = (st || {}) as Record<string, number>;
  const now = Date.now();
  const changes: string[] = [];
  const upd: Record<string, Acc> = {};
  for (const [h, pts] of Object.entries(F)) {
    if (A[h] || Number(pts) < 6) continue;
    upd[h] = { h, cat: "found", tier: "found", added: now, why: `${pts} evidence points (linked by bonded coins, mentioned by tracked accounts)` };
    changes.push(`added @${h}`);
  }
  for (const [h, a] of Object.entries(A)) {
    const tweets = Number(S[`${h}:tweets`] || 0);
    const sparks = Number(S[`${h}:sparks`] || 0);
    if ((a.tier === "found" || a.tier === "j7") && tweets >= 300 && sparks === 0) {
      upd[h] = { ...a, tier: "muted", why: `${tweets} posts, no coin sparked` };
      changes.push(`muted @${a.h}`);
    }
  }
  if (Object.keys(upd).length) {
    await r.hset(ACC, upd);
    await r.hdel(FOUND, ...Object.keys(upd));
    await r.set(DIRTY, 1);
  }
  return changes;
}

/** Push the watchlist to twitterapi.io as filter rules (from:a OR from:b ..., max 255 chars each). */
export async function syncRules(force = false) {
  if (!xOn()) return { synced: false, note: "no X_API_KEY" };
  const r = redis();
  await ensureSeed();
  if (!force && !(await r.get(DIRTY))) return { synced: false, note: "up to date" };
  const A = ((await r.hgetall<Record<string, Acc>>(ACC)) || {}) as Record<string, Acc>;
  // J7 already watches its feed and pool for free: twitterapi.io only pays for our accounts J7 doesn't cover
  const cov = await j7Covered().catch(() => new Set<string>());
  const handles = Object.values(A).filter((a) => a.tier !== "muted" && a.tier !== "j7" && !cov.has(a.h.toLowerCase())).map((a) => a.h);
  const chunks: string[] = [];
  let cur = "";
  for (const h of handles) {
    const part = `from:${h}`;
    if ((cur ? cur.length + 4 : 0) + part.length > 255) {
      chunks.push(cur);
      cur = part;
    } else cur = cur ? `${cur} OR ${part}` : part;
  }
  if (cur) chunks.push(cur);
  const head = { "X-API-Key": process.env.X_API_KEY!, "content-type": "application/json" };
  const interval = Number(process.env.X_RULE_INTERVAL || 1);
  // remove our old rules, then add the new set and switch each on
  const old = ((await r.get<string[]>(RULES)) || []) as string[];
  for (const id of old) await fetch(`${API}/oapi/tweet_filter/delete_rule`, { method: "DELETE", headers: head, body: JSON.stringify({ rule_id: id }) }).catch(() => null);
  const ids: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const tag = `ratnet-wire-${i}`;
    const res: any = await fetch(`${API}/oapi/tweet_filter/add_rule`, { method: "POST", headers: head, body: JSON.stringify({ tag, value: chunks[i], interval_seconds: interval }) }).then((x) => x.json()).catch(() => null);
    if (!res?.rule_id) continue;
    ids.push(res.rule_id);
    await fetch(`${API}/oapi/tweet_filter/update_rule`, { method: "POST", headers: head, body: JSON.stringify({ rule_id: res.rule_id, tag, value: chunks[i], interval_seconds: interval, is_effect: 1 }) }).catch(() => null);
  }
  await r.set(RULES, ids);
  await r.del(DIRTY);
  return { synced: true, rules: ids.length, accounts: handles.length };
}

/** Per-account record: the weight WIRE gives an account's posts. Seeds start trusted, found accounts earn it. */
export function weightOf(a: Acc | undefined, S: Record<string, number>) {
  if (!a || a.tier === "muted") return 0;
  const h = a.h.toLowerCase();
  const picks = Number(S[`${h}:picks`] || 0);
  const runs = Number(S[`${h}:runs`] || 0);
  const prior = a.tier === "seed" ? (a.cat === "leader" || a.cat === "celeb" ? 0.5 : 0.3) : a.tier === "j7" ? 0.22 : 0.15;
  // shrunk toward the prior: 4 picks of evidence weigh as much as the prior
  return Math.round(((runs + prior * 4) / (picks + 4)) * 100) / 100;
}

export async function accountOf(h: string) {
  const r = redis();
  const [a, st] = await Promise.all([r.hget<Acc>(ACC, h.toLowerCase()), r.hgetall<Record<string, number>>(ST)]);
  return { acc: a || undefined, w: weightOf(a || undefined, (st || {}) as Record<string, number>) };
}

/** Everything for the page: latest tracked posts with the coins they spawned, and the account board. */
export async function wireView() {
  const r = redis();
  await ensureSeed();
  const [tw, accs, st, found] = await Promise.all([r.lrange<XTweet>(TW, 0, 29), r.hgetall<Record<string, Acc>>(ACC), r.hgetall<Record<string, number>>(ST), r.hgetall<Record<string, number>>(FOUND)]);
  const S = (st || {}) as Record<string, number>;
  const A = (accs || {}) as Record<string, Acc>;
  const tweets = ((tw || []) as XTweet[]).filter((t) => t.kind !== "reply").slice(0, 20);
  const picks = tweets.length ? ((await r.mget<(string | null)[]>(...tweets.map((t) => PICKED(t.id)))) || []) : [];
  const n = (h: string, k: string) => Number(S[`${h.toLowerCase()}:${k}`] || 0);
  const accounts = Object.values(A)
    .map((a) => ({ h: a.h, cat: a.cat, tier: a.tier, why: a.why, tweets: n(a.h, "tweets"), matches: n(a.h, "matches"), sparks: n(a.h, "sparks"), picks: n(a.h, "picks"), runs: n(a.h, "runs"), pnl: Math.round(n(a.h, "pnl") * 1000) / 1000, w: weightOf(a, S) }))
    .sort((a, b) => b.runs - a.runs || b.sparks - a.sparks || b.tweets - a.tweets);
  const cands = Object.entries((found || {}) as Record<string, number>).map(([h, pts]) => ({ h, pts: Number(pts) })).sort((a, b) => b.pts - a.pts).slice(0, 8);
  const [j7, pulse] = await Promise.all([j7State().catch(() => null), pulseView().catch(() => null)]);
  return { on: xOn() || !!j7?.on, j7, pulse, tweets: tweets.map((t, i) => ({ ...t, picked: picks[i] || null })), accounts, candidates: cands };
}
