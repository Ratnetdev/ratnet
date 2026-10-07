// BOARD: one shared page per coin where every agent keeps its current view, so they work as one desk instead of
// twenty separate scripts.
//
// Before: agents handed coins along fixed lines (KING -> desk, HOUND -> MIND, MOMO -> desk ...). A coin could have
// three tracked wallets in it, a rising narrative and LENS loving the site, and still nobody looked at all of it at
// once unless one agent's own trigger fired.
//
// Now: every agent line about a coin also lands here as a stance (-1 against, +1 for), automatically through
// agentLog, with the agent's family so near-duplicates don't double count (KING and nano, MIND and LENS ...).
// CATCH reads the board every few seconds, scores the coins where several families agree ("confluence"), and that
// score is both a feature in its model and a trigger: when enough independent agents agree, the coin gets a CATCH
// look right away, whichever agent spoke first.
import { redis } from "./redis";

export const BB = (m: string) => `rn:bb:${m}`; // agent -> Post (6h)
export const BB_RECENT = "rn:bb:recent"; // mint -> last post time
const TTL = 6 * 3600;

export type Post = { a: string; at: number; s: number; t: string; sym?: string };

// agents that hold a view on a coin, by family (independent sources of evidence)
export const FAMILY: Record<string, string> = {
  KING: "model", SCOUT: "model", CATCH: "model",
  TAPE: "flow", FLOW: "flow", MOMO: "flow",
  GRAPH: "wallets", HOUND: "wallets",
  WIRE: "social", PULSE: "social", BUZZ: "social",
  LENS: "look", MIND: "look",
};

const TONE: Record<string, number> = { win: 1, ok: 0.6, info: 0, bad: -0.6, loss: -0.6 };

/** Stance from an agent line: explicit `stance` wins; otherwise the tone. Neutral lines are not posted. */
export function stanceOf(e: { agent: string; tone: string; stance?: number }) {
  if (!FAMILY[e.agent]) return null;
  const s = e.stance ?? TONE[e.tone] ?? 0;
  return s === 0 ? null : Math.max(-1, Math.min(1, s));
}

type P = { hset: Function; expire: Function; zadd: Function };

/** Queue a post on a pipeline (called by agentLog for every line with a coin). */
export function postTo(p: P, mint: string, post: Post) {
  p.hset(BB(mint), { [post.a]: post });
  p.expire(BB(mint), TTL);
  p.zadd(BB_RECENT, { score: post.at, member: mint });
}

export async function board(mint: string): Promise<Post[]> {
  return Object.values(((await redis().hgetall<Record<string, Post>>(BB(mint))) || {}) as Record<string, Post>);
}

/**
 * Confluence: how many independent families lean the same way right now. Each family counts once (its strongest
 * fresh view), views fade over 45 minutes, and any hard negative (a farm, a rug flag) weighs double.
 */
export function confluence(posts: Post[], now = Date.now()) {
  const fam: Record<string, number> = {};
  for (const x of posts) {
    const f = FAMILY[x.a];
    if (!f) continue;
    const fade = Math.max(0, 1 - (now - x.at) / (45 * 60_000));
    if (fade <= 0) continue;
    const v = x.s * fade * (x.s < -0.8 ? 2 : 1);
    if (fam[f] == null || Math.abs(v) > Math.abs(fam[f])) fam[f] = v;
  }
  const vals = Object.values(fam);
  const pos = vals.filter((v) => v > 0.25).length;
  const neg = vals.filter((v) => v < -0.25).length;
  return { score: Math.round(vals.reduce((a, v) => a + v, 0) * 100) / 100, pos, neg, families: fam };
}

/** Coins with fresh posts, newest first (for CATCH's conductor pass and the /api/board view). */
export async function recentCoins(sinceMs = 30 * 60_000, max = 60) {
  const r = redis();
  await r.zremrangebyscore(BB_RECENT, 0, Date.now() - 6 * 3600_000);
  const raw = ((await r.zrange<(string | number)[]>(BB_RECENT, 0, max - 1, { rev: true, withScores: true })) || []) as (string | number)[];
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) if (Number(raw[i + 1]) >= Date.now() - sinceMs) out.push(String(raw[i]));
  return out;
}
