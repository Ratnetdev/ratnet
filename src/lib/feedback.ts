// Stan's feedback on what the agents did: good or bad, a few tags, a note. Admin only. Stored per coin and tallied
// per tag, so the Strategy tab shows which mistakes keep coming back. The agents do not read it on their own yet:
// it is the record for tuning by hand (and later, a training signal).
import { redis } from "./redis";

const FB = (m: string) => `rn:fb:${m}`;
const ALL = "rn:fb:all";
const TAGS = "rn:fb:tags";

export const FB_TAGS = [
  "no socials",
  "fake socials",
  "bought the top",
  "chased",
  "dumped coin",
  "bundled",
  "bot volume",
  "dev rug",
  "sold too early",
  "held too long",
  "good narrative",
  "good entry",
  "good exit",
  "should have bought",
] as const;

export type Feedback = { id: string; mint: string; symbol: string; kind: "trade" | "call" | "skip"; ref: number | null; at: number; verdict: "good" | "bad"; tags: string[]; note: string };

export async function addFeedback(f: Omit<Feedback, "id" | "at">) {
  const r = redis();
  const fb: Feedback = { ...f, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now() };
  const p = r.pipeline();
  p.lpush(FB(f.mint), fb);
  p.ltrim(FB(f.mint), 0, 49);
  p.expire(FB(f.mint), 180 * 86400);
  p.lpush(ALL, fb);
  p.ltrim(ALL, 0, 499);
  for (const t of f.tags) p.hincrby(TAGS, `${f.verdict}:${t}`, 1);
  p.hincrby(TAGS, `${f.verdict}:*`, 1);
  await p.exec();
  return fb;
}

export async function feedbackFor(mint: string) {
  return (await redis().lrange<Feedback>(FB(mint), 0, 49)) || [];
}

export async function feedbackSummary() {
  const r = redis();
  const [list, tags] = await Promise.all([r.lrange<Feedback>(ALL, 0, 99), r.hgetall<Record<string, number>>(TAGS)]);
  const t = Object.entries(tags || {})
    .filter(([k]) => !k.endsWith(":*"))
    .map(([k, n]) => ({ verdict: k.split(":")[0], tag: k.split(":").slice(1).join(":"), n: Number(n) }))
    .sort((a, b) => b.n - a.n);
  return { good: Number((tags as any)?.["good:*"] || 0), bad: Number((tags as any)?.["bad:*"] || 0), tags: t, recent: list || [] };
}
