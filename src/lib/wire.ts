// WIRE: the social monitor. Tracks X accounts whose posts spawn coins, finds the pump.fun launches born from each
// post, picks the real one out of the copies, and hands it to the desk as its own strategy (sleeve "wire").
// It learns per account: how often a post sparks a launch, how often the picked coin runs, and what the desk made on
// it. It grows its own account list from what actually moves coins, and mutes accounts that never do.
// Data: twitterapi.io filter rules push tweets to /api/x/hook within seconds (X_API_KEY + the webhook URL set in the
// twitterapi.io dashboard). Without a key WIRE stays idle.
import { getLaunch, getLaunches, putLaunch } from "./launches";
import { enqueueMind, noteKolCall, noteStudy } from "./mind";
import { enqueueLens } from "./lens";
import { redis } from "./redis";
import { X_SEED } from "@/config/x-accounts";
import { memo, memoPatch } from "./memo";
import { listCached } from "./lcache";
import { X_BUDGET, xAllowed, xCost, xSpend, xSpendView } from "./xcredits";
import { agentLog } from "./agents";
import { K } from "./redis";
import { getSettings } from "./settings";
import { notePulse } from "./pulse";
import { j7Covered, j7State } from "./j7";
import { pulseView } from "./pulse";

export type XTweet = { id: string; h: string; name?: string; f: number; at: number; text: string; terms: string[]; url: string; kind: "post" | "reply" | "quote" | "rt"; inner?: string; ca?: string; src?: string };
export type WireMatch = { tid: string; h: string; score: number; how: string; lagSec: number; text: string; pick?: boolean; f?: number; vamp?: boolean; trac?: { copies: number; sol: number } };
type Acc = { h: string; cat: string; tier: "seed" | "found" | "j7" | "muted"; added: number; why?: string; f?: number };
const CALLERS = new Set(["kol", "trader"]); // accounts whose CA posts are calls MIND looks at, and whose posts MIND studies

const ACC = "rn:x:acc"; // handle -> Acc
const ST = "rn:x:st"; // {h}:tweets|sparks|picks|runs|pnl (counters)
const TW = "rn:x:tw"; // newest first, last 400 tweets
// v0.1.42: its change counter: readers keep the list in memory and fetch only new posts (lib/lcache.ts listCached).
// WIRE re-read the last 200 posts every 15s: 21.6MB an hour on 8 Oct.
const TW_SEQ = "rn:x:tw:seq";
const tweetsCached = () => listCached<XTweet>(TW, TW_SEQ, 400, (t) => `${t.id}|${t.src || ""}`);
const SEEN = (id: string) => `rn:x:seen:${id}`;
const CAND = (tid: string) => `rn:x:cand:${tid}`; // mints that match a tweet, scored by match strength
const OPEN = "rn:x:open"; // tweets with candidates waiting for a pick, scored by first candidate time
const PICKED = (tid: string) => `rn:x:pk:${tid}`;
const SPARK = (tid: string) => `rn:x:sp:${tid}`;
const FOUND = "rn:x:found"; // candidate handles -> evidence points
const DIRTY = "rn:x:dirty"; // watchlist changed: rules need a sync
const RULES = "rn:x:rules"; // last synced rule ids
const RULE_LIST = "rn:x:rulelist"; // [{ id, tag, value }] of the synced rules (to pause and resume them)
export const X_PAUSED = "rn:x:paused"; // { hour, min }: rules switched off for the rest of that UTC hour
const VOL = (h: string) => `rn:x:vol:${h}`; // posts per watched account per UTC hour (from the webhook)
export const WIRE_Q = (m: string) => `w:${m}`; // desk queue member for a wire signal

export const xOn = () => !!process.env.X_API_KEY;
const API = "https://api.twitterapi.io";

const STOP = new Set(
  "the a an and or but if then so to of in on at by for with from as is are was were be been being it its this that these those i you he she we they me him her us them my your his our their what which who whom whose when where why how all any both each few more most other some such no nor not only own same than too very can will just don should now new one get got just like also into about over after before under again out up down off here there https http www com amp rt via today breaking just coming going come goes went make made said says say see seen look looks need want wants know think thing things time year years day days week people really good great best big biggest first last next much many every never always still even way back right left yes yeah lol lmao gm gn ser fren wow send sending sent ape aped aping pump pumping buy buying bought sell selling sold dump dumping rug rugged bullish bearish bull bear lfg huge massive gem gems chart charts coin coins token tokens holders hold holding launch launched market crypto have has had having does did doing done could would should might must shall may can't cant dont didnt doesnt isnt wasnt arent werent wont im ive youre theyre were thats theres what's there's lets let's also because while since until into onto upon than then them they their there these those this that with without within about above below between through during before after again further once more most some such only same very just really still even ever never always often every each other another any many much few less least own both either neither whether here where when why how who whom whose which what yes no not nor too also amp via rt new news update live watch thread video photo image breaking report reports reported says said told according official officially today tonight tomorrow yesterday week month year years hours minutes people person man woman guy guys everyone someone anyone nobody thing things stuff way ways part lot lots".split(" "),
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

let seeded = 0;
/** The whole account list, read at most once a minute per process (5,000+ accounts, about 800KB). */
// v0.1.40: 10 minutes (was 1). Every write to the account list patches this cache in the same process, and since
// v0.1.40 only the worker writes it (the X webhook queues its posts for the worker). The list is ~800KB.
const accsAll = () => memo("wire:acc", 600_000, async () => ((await redis().hgetall<Record<string, Acc>>(ACC)) || {}) as Record<string, Acc>);
/** WIRE's per-account counters, at most once a minute per process. */
const statsAll = () => memo("wire:st", 600_000, async () => ((await redis().hgetall<Record<string, number>>(ST)) || {}) as Record<string, number>);

export async function ensureSeed() {
  if (seeded === X_SEED.length) return;
  const r = redis();
  // new seeds in a later version are added to a running WIRE; accounts it already knows keep their record
  if (Number((await r.get("rn:x:seedn")) || 0) === X_SEED.length) {
    seeded = X_SEED.length;
    return;
  }
  const have = await accsAll();
  const now = Date.now();
  const obj: Record<string, Acc> = {};
  for (const s of X_SEED) {
    const k = s.h.toLowerCase();
    if (!have[k] || have[k].tier !== "seed") obj[k] = { ...(have[k] || {}), h: s.h, cat: s.cat, tier: "seed", added: have[k]?.added || now };
  }
  if (Object.keys(obj).length) {
    await r.hset(ACC, obj);
    memoPatch("wire:acc", obj);
    await r.set(DIRTY, 1);
  }
  await r.set("rn:x:seedn", X_SEED.length);
  seeded = X_SEED.length;
}

/** New posts from any source (J7 feed, twitterapi.io webhook): store, count, feed PULSE, act on posted CAs. */
export async function ingest(tweets: XTweet[]) {
  const r = redis();
  await ensureSeed();
  const accs = await accsAll();
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
    p.incr(TW_SEQ);
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
    // MIND's school: what the KOLs and traders it follows are saying
    if (acc && CALLERS.has(acc.cat) && t.kind !== "rt" && t.text.length >= 60) noteStudy(p, t.h, t.text, t.at);
    if (acc?.tier !== "muted" && t.kind !== "reply" && (acc?.tier === "seed" || t.f >= 50_000 || t.ca))
      agentLog(p, [{ agent: "WIRE", at: Date.now(), text: `@${t.h}${t.src && !["j7", "tapi"].includes(t.src) ? ` on ${t.src}` : ""}${t.kind === "rt" ? " reposted" : t.kind === "quote" ? " quoted" : ""}: "${t.text.slice(0, 90)}${t.text.length > 90 ? "…" : ""}"${t.ca ? " · posted a CA" : ` · watching launches for ${t.terms.slice(0, 4).join(", ") || "anything linked"}`}`, tone: t.ca ? "ok" : "info" }]);
  }
  if (Object.keys(newAccs).length) {
    p.hset(ACC, newAccs);
    memoPatch("wire:acc", newAccs);
  }
  p.ltrim(TW, 0, 399);
  await p.exec();
  for (const t of cas) await onCA(t).catch(() => {});
  // KOL and trader calls: a CA posted by a caller (or any 10k+ account) is a call MIND looks at, at any age, and the
  // caller is graded 6 hours later
  for (const t of cas) {
    const acc = accs[t.h.toLowerCase()] || newAccs[t.h.toLowerCase()];
    if (!t.ca || acc?.tier === "muted" || !(CALLERS.has(acc?.cat || "") || t.f >= 10_000)) continue;
    const rec: any = await getLaunch(t.ca).catch(() => null);
    await noteKolCall(t.h, t.ca, !!rec && !rec.outcome).catch(() => {});
    if (rec) {
      const q = r.pipeline();
      enqueueLens(q, t.ca, "wire");
      enqueueMind(q, t.ca, "kol");
      await q.exec();
    }
  }
  return { stored: n, cas: cas.length };
}

/** A tracked account posted a contract address. If the rats know the coin, it goes to the desk right away. */
async function onCA(t: XTweet) {
  const r = redis();
  const rec: any = await getLaunch(t.ca!);
  if (!rec || rec.outcome || rec.wire?.pick) return; // unknown coins are matched when the rats dig them (see matchOne)
  if (!(await r.set(PICKED(t.id), t.ca!, { nx: true, ex: 3 * 86400 }))) return;
  rec.wire = { tid: t.id, h: t.h, score: 1, how: "posted the CA", lagSec: Math.max(0, Math.round((t.at - rec.createdAt) / 1000)), text: t.text.slice(0, 160), pick: true };
  await putLaunch(r, rec, { keepTtl: true });
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
    if (score >= 0.5 && (!best || score > best.score)) best = { tid: t.id, h: t.h, score, how, lagSec: Math.max(0, lag), text: t.text.slice(0, 160), f: t.f };
  }
  return best;
}

export async function recentTweets(maxAgeMs = 3600_000) {
  // v0.1.40: read on every launch the stream delivers (~150KB each time); once per 15s per process now
  const all = (await tweetsCached()).slice(0, 200);
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
  const ids = ((await r.zrange<string[]>(OPEN, 0, now - 20_000, { byScore: true, offset: 0, count: 10 })) || []).map(String);
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
  // every 10 minutes is plenty for promoting and muting accounts (it read three big hashes every minute)
  if (!(await r.set("rn:x:curate", 1, { nx: true, ex: 600 }))) return [];
  const [accs, found, st] = await Promise.all([accsAll(), r.hgetall<Record<string, number>>(FOUND), statsAll()]);
  const A = (accs || {}) as Record<string, Acc>;
  const F = (found || {}) as Record<string, number>;
  // @mentions of unknown handles pile up forever; keep the ones with real evidence
  const weak = Object.entries(F).filter(([, v]) => Number(v) < 2).map(([h]) => h);
  if (Object.keys(F).length > 3000 && weak.length) for (let i = 0; i < weak.length; i += 500) await r.hdel(FOUND, ...weak.slice(i, i + 500)).catch(() => 0);
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
    memoPatch("wire:acc", upd);
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
  // v0.1.24 changed who gets a paid rule: resync once even if the list did not change
  const lastSync = await r.get<any>("rn:x:synced");
  // v0.1.35: also when the hourly budget changed (X_CREDITS_PER_HOUR) and every 6 hours, so the paid list follows
  // what the accounts really cost
  const stale = !lastSync || lastSync.v !== 35 || lastSync.budget !== X_BUDGET || Date.now() - Number(lastSync.at || 0) > 6 * 3600_000;
  if (!force && !(await r.get(DIRTY)) && !stale) return { synced: false, note: "up to date" };
  // the hourly cap switched the rules off: no new rules until the next hour
  const pz = await r.get<{ hour: string }>(X_PAUSED);
  if (!force && pz?.hour === new Date().toISOString().slice(0, 13)) return { synced: false, note: "paused this hour (budget reached)" };
  const A = ((await r.hgetall<Record<string, Acc>>(ACC)) || {}) as Record<string, Acc>;
  // J7 already watches its feed and pool for free: twitterapi.io only pays for our accounts J7 doesn't cover
  const cov = await j7Covered().catch(() => new Set<string>());
  // paid watching is earned: the seeds, then found accounts by the weight their results gave them, up to what the
  // hourly credit budget pays for. Before v0.1.24 every found account got a rule (~650 accounts, ~50 rules checked
  // every minute: over 100K credits an hour). The rest are still read for free through J7 and tweet links
  const S0 = ((await r.hgetall<Record<string, number>>(ST)) || {}) as Record<string, number>;
  const interval = Math.max(10, Number(process.env.X_RULE_INTERVAL || 60));
  // v0.1.35: sized on what the accounts really cost. Each rule is billed 15 credits per check (~13 handles per rule)
  // and every post it returns 15 more. On 7 Oct 104 accounts posted ~2,400 times an hour: ~36K credits an hour in
  // posts alone, against a 10K budget. The rules may now use ~60% of the budget (the rest is LENS, HOUND, OVERSEER),
  // priced at each account's measured posts per hour (the last 2 hours), and accounts that post more than 20 times an
  // hour without ever leading to a pick are left to J7 (free).
  const hNow = new Date().toISOString().slice(0, 13);
  const hPrev = new Date(Date.now() - 3600_000).toISOString().slice(0, 13);
  const [v1, v2] = await Promise.all([r.hgetall<Record<string, number>>(VOL(hNow)), r.hgetall<Record<string, number>>(VOL(hPrev))]);
  const mins = new Date().getUTCMinutes() + 1;
  const perHour = (h: string) => {
    const k = h.toLowerCase();
    const a = Number(v2?.[k] || 0);
    const b = Number(v1?.[k] || 0);
    return v2 ? a * 0.5 + (b * 60) / mins * 0.5 : (b * 60) / mins;
  };
  const checkPerAcct = ((3600 / interval) * 15) / 13;
  const room = X_BUDGET * 0.6;
  const handles: string[] = [];
  let spend = 0;
  const ranked = Object.values(A)
    .filter((a) => a.tier !== "muted" && a.tier !== "j7" && !cov.has(a.h.toLowerCase()))
    .filter((a) => a.tier === "seed" || Number(S0[`${a.h.toLowerCase()}:picks`] || 0) > 0 || Number(S0[`${a.h.toLowerCase()}:sparks`] || 0) >= 2 || (a.f ?? 0) >= 100_000)
    .sort((a, b) => (b.tier === "seed" ? 1 : 0) - (a.tier === "seed" ? 1 : 0) || weightOf(b, S0) - weightOf(a, S0));
  const capN = Number(process.env.X_RULE_ACCOUNTS || 1e9);
  let noisy = 0;
  for (const a of ranked) {
    if (handles.length >= capN) break;
    const ph = perHour(a.h);
    if (ph > 20 && !Number(S0[`${a.h.toLowerCase()}:picks`] || 0)) {
      noisy++;
      continue;
    }
    const cost = checkPerAcct + Math.max(3, ph) * 15; // an account never measured is priced at 3 posts an hour
    if (handles.length >= 2 && spend + cost > room) continue;
    spend += cost;
    handles.push(a.h);
  }
  // reposts carry no new post to make a coin from, and they are billed like posts
  const filter = (process.env.X_RULE_FILTER ?? "-is:retweet").trim();
  const chunks: string[] = [];
  let cur = "";
  const room255 = 255 - (filter ? filter.length + 3 : 0); // "(...) -is:retweet"
  for (const h of handles) {
    const part = `from:${h}`;
    if ((cur ? cur.length + 4 : 0) + part.length > room255) {
      chunks.push(cur);
      cur = part;
    } else cur = cur ? `${cur} OR ${part}` : part;
  }
  if (cur) chunks.push(cur);
  if (filter) for (let i = 0; i < chunks.length; i++) chunks[i] = `(${chunks[i]}) ${filter}`;
  const head = { "X-API-Key": process.env.X_API_KEY!, "content-type": "application/json" };
  // how often twitterapi.io checks each rule. Every check is billed (15 credits minimum, more when posts come back), so
  // 25 rules at 20s burned ~200K credits an hour. 60s by default; J7 already covers the big accounts in real time
  // remove EVERY rule of ours on the account, not only the ones we remember: a delete that failed once used to leave
  // its rule running (and billing) forever, and each later sync stacked a fresh set on top
  const listed: any = await fetch(`${API}/oapi/tweet_filter/get_rules`, { headers: head, cache: "no-store" }).then((x) => x.json()).catch(() => null);
  const mine = ((listed?.rules || []) as any[]).filter((x) => String(x?.tag || "").startsWith("ratnet-wire-")).map((x) => String(x.rule_id));
  const old = Array.from(new Set([...(((await r.get<string[]>(RULES)) || []) as string[]), ...mine]));
  let removed = 0;
  for (const id of old) {
    const ok: any = await fetch(`${API}/oapi/tweet_filter/delete_rule`, { method: "DELETE", headers: head, body: JSON.stringify({ rule_id: id }) }).then((x) => x.json()).catch(() => null);
    if (ok?.status === "success") removed++;
  }
  const ids: string[] = [];
  const list: { id: string; tag: string; value: string }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const tag = `ratnet-wire-${i}`;
    const res: any = await fetch(`${API}/oapi/tweet_filter/add_rule`, { method: "POST", headers: head, body: JSON.stringify({ tag, value: chunks[i], interval_seconds: interval }) }).then((x) => x.json()).catch(() => null);
    if (!res?.rule_id) continue;
    ids.push(res.rule_id);
    list.push({ id: String(res.rule_id), tag, value: chunks[i] });
    await fetch(`${API}/oapi/tweet_filter/update_rule`, { method: "POST", headers: head, body: JSON.stringify({ rule_id: res.rule_id, tag, value: chunks[i], interval_seconds: interval, is_effect: 1 }) }).catch(() => null);
  }
  await r.set(RULES, ids);
  await r.set(RULE_LIST, list);
  await r.del(X_PAUSED); // fresh rules start switched on
  await r.set("rn:x:synced", { at: Date.now(), n: ids.length, accounts: handles.length, interval, removed, found: mine.length, budget: X_BUDGET, est: Math.round(spend), noisy, filter, v: 35 });
  await r.del(DIRTY);
  return { synced: true, rules: ids.length, accounts: handles.length, interval, removed, foundOnAccount: mine.length, estPerHour: Math.round(spend), noisy };
}

/** Posts per watched account this hour (the webhook calls this), so the next sync prices each account. */
export async function noteVolume(tweets: XTweet[]) {
  if (!tweets.length) return;
  const r = redis();
  const k = VOL(new Date().toISOString().slice(0, 13));
  const by: Record<string, number> = {};
  for (const t of tweets) by[t.h.toLowerCase()] = (by[t.h.toLowerCase()] || 0) + 1;
  const p = r.pipeline();
  for (const [h, n] of Object.entries(by)) p.hincrby(k, h, n);
  p.expire(k, 3 * 3600);
  await p.exec().catch(() => null);
}

/**
 * The hard cap (v0.1.35). twitterapi.io bills the rules whatever RATNET does, so the hourly budget was only a
 * wish for them: on 7 Oct the budget said 10K an hour and the account spent ~45K. When this hour's spend reaches the
 * budget, every rule is switched off (is_effect 0) until the next UTC hour; J7 keeps the feed going for free.
 */
export async function xGuard() {
  if (!xOn()) return { guard: "no key" };
  const r = redis();
  const hour = new Date().toISOString().slice(0, 13);
  const [paused, list] = await Promise.all([r.get<{ hour: string; min: number }>(X_PAUSED), r.get<{ id: string; tag: string; value: string }[]>(RULE_LIST)]);
  const rules = (list || []) as { id: string; tag: string; value: string }[];
  if (!rules.length && !paused) return { guard: "no rules" };
  const head = { "X-API-Key": process.env.X_API_KEY!, "content-type": "application/json" };
  const interval = Math.max(10, Number(process.env.X_RULE_INTERVAL || 60));
  const set = async (on: 0 | 1) => {
    let ok = 0;
    for (const x of rules) {
      const res: any = await fetch(`${API}/oapi/tweet_filter/update_rule`, { method: "POST", headers: head, body: JSON.stringify({ rule_id: x.id, tag: x.tag, value: x.value, interval_seconds: interval, is_effect: on }) }).then((y) => y.json()).catch(() => null);
      if (res?.status === "success") ok++;
    }
    return ok;
  };
  if (paused?.hour && paused.hour !== hour) {
    await r.del(X_PAUSED);
    if ((paused as any).deleted) return { guard: "resumed", ...(await syncRules(true)) };
    const ok = await set(1);
    return { guard: "resumed", rules: ok };
  }
  if (paused?.hour === hour) return { guard: "paused this hour" };
  const used = await xSpendView();
  if (used.thisHour < X_BUDGET) return { guard: "ok", thisHour: used.thisHour };
  const ok = await set(0);
  // a rule that would not switch off is deleted (it would keep billing); the next hour builds the set again
  let deleted = false;
  if (ok < rules.length) {
    for (const x of rules) await fetch(`${API}/oapi/tweet_filter/delete_rule`, { method: "DELETE", headers: head, body: JSON.stringify({ rule_id: x.id }) }).catch(() => null);
    await r.set(RULE_LIST, []);
    deleted = true;
  }
  await r.set(X_PAUSED, { hour, min: new Date().getUTCMinutes(), deleted }, { ex: 26 * 3600 });
  const p = r.pipeline();
  agentLog(p, [{ agent: "WIRE", at: Date.now(), text: `X budget reached (${Math.round(used.thisHour / 100) / 10}K of ${Math.round(X_BUDGET / 100) / 10}K credits this hour): paid rules off until the next hour, J7 keeps watching`, tone: "info" }]);
  await p.exec();
  return { guard: "paused", rules: ok, thisHour: used.thisHour };
}

/** Per-account record: the weight WIRE gives an account's posts. Seeds start trusted, found accounts earn it. */
export function weightOf(a: Acc | undefined, S: Record<string, number>) {
  if (!a || a.tier === "muted") return 0;
  const h = a.h.toLowerCase();
  const picks = Number(S[`${h}:picks`] || 0);
  const runs = Number(S[`${h}:runs`] || 0);
  // big accounts found through tweet links start with more trust than unknown ones
  const reach = (a.f ?? 0) >= 1_000_000 ? 0.45 : (a.f ?? 0) >= 100_000 ? 0.32 : (a.f ?? 0) >= 20_000 ? 0.22 : 0;
  const prior = Math.max(reach, a.tier === "seed" ? (a.cat === "leader" || a.cat === "celeb" ? 0.5 : 0.3) : a.tier === "j7" ? 0.22 : 0.15);
  // shrunk toward the prior: 4 picks of evidence weigh as much as the prior
  return Math.round(((runs + prior * 4) / (picks + 4)) * 100) / 100;
}

export async function accountOf(h: string) {
  const r = redis();
  // only the two counters the weight needs (it read every account's counters on each call)
  const k = h.toLowerCase();
  const [a, st] = await Promise.all([r.hget<Acc>(ACC, k), r.hmget<Record<string, number>>(ST, `${k}:picks`, `${k}:runs`)]);
  return { acc: a || undefined, w: weightOf(a || undefined, (st || {}) as Record<string, number>) };
}

/** Everything for the page: latest tracked posts with the coins they spawned, and the account board. */
/** The board for the pages: the top `limit` accounts by results (the full list runs to thousands: ~1MB) plus counts. */
// v0.1.40: the pages read WIRE's view as one small key the worker writes every 2 minutes, instead of each server
// instance reading the whole account list (~800KB) and its counters every minute.
const VIEW = "rn:x:view";
export async function publishWireView() {
  const v = await wireView(100);
  await redis().set(VIEW, { ...v, at: Date.now() }, { ex: 1800 });
  return v.accounts.length;
}
export async function wireViewPublic(limit = 100) {
  const v = await memo("wire:view", 30_000, () => redis().get<Awaited<ReturnType<typeof wireView>> & { at: number }>(VIEW).catch(() => null));
  if (!v) return wireView(limit); // the worker has not written it yet
  return { ...v, accounts: (v.accounts || []).slice(0, limit) };
}
/** X webhook posts wait here for the worker (it holds WIRE's account list in memory). */
export const X_INQ = "rn:x:inq";
// v0.1.42: the oldest 200 from the tail (new posts are pushed at the head), removed only after they were ingested.
// Before, the newest 200 were taken and removed first: a failed ingest lost them, and under load the oldest posts
// waited behind every new one.
// A batch that fails 3 times in a row is dropped, so one bad post can never block the queue.
let DRAINING = false;
let DRAIN_FAILS = 0;
export async function drainXQueue() {
  if (DRAINING) return 0;
  DRAINING = true;
  const r = redis();
  let got: unknown[] = [];
  try {
    got = ((await r.lrange<XTweet>(X_INQ, -200, -1)) || []) as unknown[];
    if (!got.length) return 0;
    const tweets = got.filter((t): t is XTweet => !!t && typeof t === "object" && typeof (t as any).id === "string" && typeof (t as any).h === "string" && typeof (t as any).text === "string");
    if (tweets.length) await ingest(tweets.slice().reverse()); // oldest first
    await r.ltrim(X_INQ, 0, -(got.length + 1));
    DRAIN_FAILS = 0;
    return tweets.length;
  } catch (e) {
    if (got.length && ++DRAIN_FAILS >= 3) {
      DRAIN_FAILS = 0;
      await r.ltrim(X_INQ, 0, -(got.length + 1)).catch(() => null);
    }
    throw e;
  } finally {
    DRAINING = false;
  }
}

export async function wireView(limit = 100) {
  const r = redis();
  await ensureSeed();
  const [tw, accs, st, found] = await Promise.all([tweetsCached().then((x) => x.slice(0, 30)), accsAll(), statsAll(), memo("wire:found", 60_000, async () => ((await r.hgetall<Record<string, number>>(FOUND)) || {}) as Record<string, number>)]);
  const S = (st || {}) as Record<string, number>;
  const A = (accs || {}) as Record<string, Acc>;
  const tweets = ((tw || []) as XTweet[]).filter((t) => t.kind !== "reply").slice(0, 20);
  const picks = tweets.length ? ((await r.mget<(string | null)[]>(...tweets.map((t) => PICKED(t.id)))) || []) : [];
  const n = (h: string, k: string) => Number(S[`${h.toLowerCase()}:${k}`] || 0);
  const accounts = Object.values(A)
    .map((a) => ({ h: a.h, cat: a.cat, tier: a.tier, why: a.why, tweets: n(a.h, "tweets"), matches: n(a.h, "matches"), sparks: n(a.h, "sparks"), picks: n(a.h, "picks"), runs: n(a.h, "runs"), pnl: Math.round(n(a.h, "pnl") * 1000) / 1000, w: weightOf(a, S), f: a.f ?? null, calls: n(a.h, "kc"), callAvg: n(a.h, "kc") ? Math.round((Math.exp(n(a.h, "ks") / n(a.h, "kc")) - 1) * 1000) / 10 : null, call2x: n(a.h, "k2") }))
    .sort((a, b) => b.runs - a.runs || b.sparks - a.sparks || b.tweets - a.tweets);
  const cands = Object.entries((found || {}) as Record<string, number>).map(([h, pts]) => ({ h, pts: Number(pts) })).sort((a, b) => b.pts - a.pts).slice(0, 8);
  const [j7, pulse] = await Promise.all([j7State().catch(() => null), pulseView().catch(() => null)]);
  const counts = { total: accounts.length, active: accounts.filter((a) => a.tier !== "muted").length };
  return { on: xOn() || !!j7?.on, j7, pulse, tweets: tweets.map((t, i) => ({ ...t, picked: picks[i] || null })), accounts: accounts.slice(0, limit), counts, candidates: cands };
}


// ---------------------------------------------------------------- tweet links (any account)

const TLQ = "rn:x:tlq"; // "tweetId|mint" for launches that link a post, scored by launch time
const TLC = (id: string) => `rn:x:tl:${id}`; // fetched post (6h)
export const tweetIdOf = (...s: string[]) => {
  for (const x of s) {
    const m = /(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/(\d{8,25})/i.exec(x || "");
    if (m) return m[1];
  }
  return null;
};

/** A launch links a post that WIRE was not watching: queue it, the post gets fetched within seconds. */
export function noteTweetLink(p: { zadd: Function }, tid: string, mint: string, createdAt: number) {
  p.zadd(TLQ, { score: createdAt, member: `${tid}|${mint}` });
}

/** Fetch the posts that new launches link (twitterapi.io, one call for up to 50), treat each as a WIRE match:
 *  the post's author joins WIRE (big accounts start with more trust), copies named after it match too, and after
 *  30 seconds WIRE picks the leader as usual. */
export async function tweetLinks() {
  if (!xOn()) return { tlinks: 0 };
  const r = redis();
  const items = ((await r.zrange<string[]>(TLQ, 0, 49)) || []).map(String);
  if (!items.length) return { tlinks: 0 };
  await r.zrem(TLQ, ...items);
  const fresh = items;
  const ids = Array.from(new Set(fresh.map((x) => x.split("|")[0])));
  const cached = ((await r.mget<(XTweet | null)[]>(...ids.map(TLC))) || []) as (XTweet | null)[];
  const byId: Record<string, XTweet> = {};
  ids.forEach((id, i) => cached[i] && (byId[id] = cached[i]!));
  const need = ids.filter((id) => !byId[id]);
  // inside the hourly X budget like everything else that pays (posts already cached still count as matches)
  if (need.length && (await xAllowed(0.95))) {
    const res = await fetch(`${API}/twitter/tweets?tweet_ids=${need.join(",")}`, { headers: { "X-API-Key": process.env.X_API_KEY! }, cache: "no-store" }).catch(() => null);
    const j: any = res?.ok ? await res.json().catch(() => null) : null;
    await xSpend("tweet links", xCost((j?.tweets || []).length));
    for (const t of parseHook({ tweets: j?.tweets || [] })) {
      byId[t.id] = t;
      await r.set(TLC(t.id), t, { ex: 6 * 3600 });
    }
  }
  const accs = await accsAll();
  const p = r.pipeline();
  const newAccs: Record<string, Acc> = {};
  let n = 0;
  for (const it of fresh) {
    const [tid, mint] = it.split("|");
    const t = byId[tid];
    if (!t) continue;
    const rec: any = await getLaunch(mint);
    if (!rec || rec.wire) continue;
    const lag = Math.max(0, Math.round((rec.createdAt - t.at) / 1000));
    // a post from days ago is decoration, not the story
    if (lag > 6 * 3600) continue;
    const m: WireMatch = { tid: t.id, h: t.h, score: 1, how: "links the post", lagSec: lag, text: t.text.slice(0, 160), f: t.f };
    rec.wire = m;
    putLaunch(p, rec, { keepTtl: true });
    noteMatch(p, mint, rec.createdAt, m);
    const key = t.h.toLowerCase();
    if (!accs[key] && !newAccs[key]) newAccs[key] = { h: t.h, cat: "found", tier: "found", added: Date.now(), why: "a launch linked their post", f: t.f };
    else if (accs[key] && !accs[key].f) newAccs[key] = { ...accs[key], f: t.f };
    // the post joins WIRE's buffer, so copies named after it match too
    if (await r.set(SEEN(t.id), 1, { nx: true, ex: 3 * 86400 })) {
      p.lpush(TW, { ...t, src: "link" });
      p.incr(TW_SEQ);
      notePulse(p as any, t);
    }
    if (t.f >= 20_000) enqueueLens(p, mint, "wire");
    agentLog(p, [{ agent: "WIRE", at: Date.now(), mint, symbol: rec.symbol, text: `$${rec.symbol} links a post by @${t.h} (${t.f >= 1000 ? `${Math.round(t.f / 1000)}k` : t.f} followers, ${lag}s before launch): "${t.text.slice(0, 80)}"`, tone: t.f >= 100_000 ? "ok" : "info" }]);
    n++;
  }
  if (Object.keys(newAccs).length) {
    p.hset(ACC, newAccs);
    memoPatch("wire:acc", newAccs);
  }
  p.ltrim(TW, 0, 399);
  await p.exec();
  return { tlinks: n };
}

/** Every coin matched to a post so far, best match first. */
export async function candidatesOf(tid: string) {
  const flat = ((await redis().zrange<(string | number)[]>(CAND(tid), 0, 29, { rev: true, withScores: true })) || []) as (string | number)[];
  const out: { mint: string; score: number }[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ mint: String(flat[i]), score: Number(flat[i + 1]) });
  return out;
}
