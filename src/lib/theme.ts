// v0.1.109 IMAGE and THEME: Claude reads the coin's picture and name, measured like everything else.
//
// For each call GRID can test (and the 14 days of older ones, once), Claude Haiku looks at the coin's image, name,
// ticker and description and answers two things: how strong the meme is (0 to 100) and its theme (animal, political,
// AI, celebrity, culture, crypto, other). These are labels, not opinions that trade: GRID tests them as rules on the
// newest calls it never saw, like every other rule. MIND's own BUY/WATCH verdict stays a feature (its record is
// inverted), the labels are what we keep from the models now.
// Theme heat: how many labelled coins of the same theme migrated in the 6 hours before the call (rotation tracking).
// Cost: an image read is about $0.002 with Haiku. A daily cap (THEME_PER_DAY, default 600, about $1.20) covers the
// live calls first, the older calls fill what is left.
import { redis } from "./redis";
import { ask, json, llmOn } from "./llm";

export const THEMES = ["animal", "political", "ai", "celebrity", "culture", "crypto", "other"] as const;
export type Theme = (typeof THEMES)[number];
export type Label = { m: number; t: Theme; s: string; at: number };
const HASH = "rn:th:h"; // mint -> Label
const DAYK = (d: string) => `rn:th:n:${d}`;
const MODEL = () => process.env.THEME_MODEL || "claude-haiku-4-5-20251001";
const PER_DAY = () => Math.max(0, Number(process.env.THEME_PER_DAY ?? 600) || 0);

const LABELS = new Map<string, Label>(); // this process: labels read or made
const BONDS: { t: Theme; at: number }[] = []; // labelled coins that migrated (live heat)
type Job = { mint: string; image: string; name: string; symbol: string; desc: string };
const Q: Job[] = [];
const QSET = new Set<string>();
let onLabel: ((mint: string, l: Label) => void) | null = null;
export const setOnLabel = (f: typeof onLabel) => (onLabel = f);
export const themeStats = { asked: 0, labelled: 0, failed: 0, capped: 0, queue: 0, lastErr: "" };

const SYSTEM = `You label pump.fun memecoins for a research dataset. You get the coin's image, name, ticker and description.
Answer with JSON only: {"meme": <0-100>, "theme": "<animal|political|ai|celebrity|culture|crypto|other>", "subject": "<2 to 5 words>"}.
meme = how strong a meme it is for crypto traders: a clear, funny or iconic picture and name that people would share and recognise (100), down to a generic, low-effort or unreadable one (0).
theme: animal (an animal or animal character), political (politicians, elections, governments), ai (AI, robots, agents, tech), celebrity (a real famous person or brand), culture (internet culture, a catchphrase, a show, a game, a moment), crypto (crypto itself: coins, chains, traders), other.`;

export function checkLabel(x: any, now = Date.now()): Label | null {
  const m = Math.round(Number(x?.meme));
  const t = String(x?.theme || "").toLowerCase() as Theme;
  if (!Number.isFinite(m) || m < 0 || m > 100 || !THEMES.includes(t)) return null;
  return { m, t, s: String(x?.subject || "").slice(0, 40), at: now };
}

/** A call worth labelling (live: queued in front; older calls: at the back). */
export function themeQueue(j: Job, front = true) {
  if (!j.mint || QSET.has(j.mint) || LABELS.has(j.mint)) return;
  QSET.add(j.mint);
  if (front) Q.unshift(j);
  else Q.push(j);
  if (Q.length > 5_000) QSET.delete(Q.pop()!.mint);
  themeStats.queue = Q.length;
}

/** Worker, every 6s: one label (10 a minute), within the day's cap. */
export async function themeDrain(forecast = ask, now = Date.now()) {
  const j = Q.shift();
  themeStats.queue = Q.length;
  if (!j) return null;
  QSET.delete(j.mint);
  if (!llmOn()) return null;
  const r = redis();
  const day = new Date(now).toISOString().slice(0, 10);
  const n = Number((await r.incr(DAYK(day)).catch(() => 0)) || 0);
  if (n === 1) r.expire(DAYK(day), 2 * 86400).catch(() => null);
  if (n > PER_DAY()) {
    themeStats.capped++;
    Q.unshift(j), QSET.add(j.mint); // tomorrow
    themeStats.queue = Q.length;
    return null;
  }
  themeStats.asked++;
  const blocks: any[] = [];
  if (/^https:\/\//.test(j.image)) blocks.push({ type: "image", source: { type: "url", url: j.image } });
  blocks.push({ type: "text", text: `Name: ${j.name.slice(0, 64)}\nTicker: ${j.symbol.slice(0, 16)}\nDescription: ${j.desc.slice(0, 280) || "(none)"}` });
  const l = checkLabel(json(await forecast(SYSTEM, blocks, 120, 30_000, MODEL()).catch(() => null)), now);
  if (!l) {
    themeStats.failed++;
    themeStats.lastErr = "no usable answer";
    return null;
  }
  LABELS.set(j.mint, l);
  if (LABELS.size > 50_000) LABELS.delete(LABELS.keys().next().value as string);
  themeStats.labelled++;
  await r.hset(HASH, { [j.mint]: l }).catch(() => null);
  try {
    onLabel?.(j.mint, l);
  } catch {}
  return l;
}

/** Worker boot: the labels made so far (GRID reads them; live heat from coins labelled before). */
export async function themeLoad() {
  const all = ((await redis().hgetall<Record<string, Label>>(HASH).catch(() => null)) || {}) as Record<string, Label>;
  for (const [m, l] of Object.entries(all)) if (l && THEMES.includes(l.t)) LABELS.set(m, l);
  return LABELS.size;
}
export const themeOf = (mint: string) => LABELS.get(mint) || null;
export const themeAll = () => LABELS;

/** A coin migrated (worker, firehose): if it carries a label, its theme heats up. */
export function themeBond(mint: string, at = Date.now()) {
  const l = LABELS.get(mint);
  if (!l) return;
  BONDS.push({ t: l.t, at });
  while (BONDS.length && at - BONDS[0].at > 24 * 3600_000) BONDS.shift();
}
/** Labelled coins of this theme that migrated in the 6 hours before `at`. */
export function themeHeat(t: Theme, at: number, bonds: { t: Theme; at: number }[] = BONDS) {
  return bonds.filter((b) => b.t === t && b.at < at && b.at >= at - 6 * 3600_000).length;
}

/** The call's read: the label (if made yet) and its theme's heat. */
export function themeAt(mint: string, at: number) {
  const l = LABELS.get(mint);
  return l ? { m: l.m, t: l.t, heat: themeHeat(l.t, at) } : null;
}

/** Tests only. */
export function _themeReset() {
  LABELS.clear();
  BONDS.length = 0;
  Q.length = 0;
  QSET.clear();
  Object.assign(themeStats, { asked: 0, labelled: 0, failed: 0, capped: 0, queue: 0, lastErr: "" });
}
