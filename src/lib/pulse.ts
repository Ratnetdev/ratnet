// PULSE: what X is talking about right now. Every post that reaches WIRE (J7's whole feed plus our own accounts) is
// counted per term in 5-minute and hourly buckets, weighted by reach. Terms running far above their usual pace are
// rising narratives. PULSE tells the King (+5 for a launch named after one), WIRE and the desk, and logs when a new
// narrative takes off. Sentiment is a simple trench lexicon per term (bullish vs bearish words in the posts).
import { redis } from "./redis";
import type { XTweet } from "./wire";

const B5 = (t: number) => `rn:pl:5:${Math.floor(t / 300_000)}`;
const BH = (t: number) => `rn:pl:h:${Math.floor(t / 3600_000)}`;
const VIEW = "rn:pl:view";
const WARM_HOURS = 3; // hours of history before PULSE calls anything rising
const SEEN = "rn:pl:top"; // terms already announced as rising (6h)
const BULL = /\b(moon|send|sending|pump|bull|bullish|ath|ape|aped|buy|buying|lfg|huge|massive|launch|launching|gem|100x|10x|win|winning|up only)\b/gi;
const BEAR = /\b(rug|rugged|dump|dumping|scam|bear|bearish|sell|selling|dead|crash|down|rekt|honeypot|exploit|hack|hacked)\b/gi;

type P = { incrbyfloat?: Function; hincrbyfloat: Function; expire: Function };

/** Count a post's terms (pipeline). */
export function notePulse(p: P, t: XTweet) {
  if (t.kind === "reply" || !t.terms.length) return;
  const w = 1 + Math.log10(1 + Math.max(0, t.f)) / 2; // a 1M-follower post counts 4x a fresh account
  const mood = (t.text.match(BULL) || []).length - (t.text.match(BEAR) || []).length;
  const k5 = B5(t.at);
  const kh = BH(t.at);
  for (const term of t.terms.slice(0, 6)) {
    p.hincrbyfloat(k5, term, w);
    p.hincrbyfloat(kh, term, w);
    if (mood) p.hincrbyfloat(kh, `${term}~m`, Math.sign(mood));
  }
  p.expire(k5, 3 * 3600);
  p.expire(kh, 26 * 3600);
}

export type Rising = { term: string; now: number; usual: number; x: number; mood: "bullish" | "bearish" | "mixed"; posts15: number };

/** Rebuild the rising list (once a minute). Returns newly rising terms for the log. */
export async function pulseTick() {
  const r = redis();
  const now = Date.now();
  const recentKeys = [0, 1, 2].map((i) => B5(now - i * 300_000));
  const hourKeys = Array.from({ length: 24 }, (_, i) => BH(now - (i + 1) * 3600_000));
  const [recent, hours, curH] = await Promise.all([
    Promise.all(recentKeys.map((k) => r.hgetall<Record<string, number>>(k))),
    Promise.all(hourKeys.map((k) => r.hgetall<Record<string, number>>(k))),
    r.hgetall<Record<string, number>>(BH(now)),
  ]);
  const last15: Record<string, number> = {};
  for (const h of recent) for (const [k, v] of Object.entries(h || {})) if (!k.includes("~")) last15[k] = (last15[k] || 0) + Number(v);
  const day: Record<string, number> = {};
  let hoursSeen = 0;
  for (const h of hours) {
    if (h && Object.keys(h).length) hoursSeen++;
    for (const [k, v] of Object.entries(h || {})) if (!k.includes("~")) day[k] = (day[k] || 0) + Number(v);
  }
  const moodOf = (term: string) => {
    let m = 0;
    for (const h of [curH, ...hours.slice(0, 2)]) m += Number((h || {})[`${term}~m`] || 0);
    return m > 1 ? "bullish" : m < -1 ? "bearish" : "mixed";
  };
  // warm-up: without a few hours of history every term looks like it is rising
  if (hoursSeen < WARM_HOURS) {
    await r.set(VIEW, { at: now, rising: [], warming: WARM_HOURS - hoursSeen }, { ex: 900 });
    return [];
  }
  const per15 = Math.max(1, hoursSeen) * 4; // 15-minute windows in the baseline
  const rising: Rising[] = Object.entries(last15)
    .map(([term, n]) => {
      const usual = (day[term] || 0) / per15;
      return { term, now: Math.round(n * 10) / 10, usual: Math.round(usual * 10) / 10, x: Math.round((n / (usual + 1)) * 10) / 10, mood: moodOf(term) as Rising["mood"], posts15: Math.round(n) };
    })
    .filter((x) => x.now >= 8 && x.x >= 3)
    .sort((a, b) => b.x * Math.log(1 + b.now) - a.x * Math.log(1 + a.now))
    .slice(0, 12);
  await r.set(VIEW, { at: now, rising }, { ex: 900 });
  const fresh: Rising[] = [];
  for (const x of rising.slice(0, 5)) if (await r.set(`${SEEN}:${x.term}`, 1, { nx: true, ex: 6 * 3600 })) fresh.push(x);
  return fresh;
}

export async function pulseView(): Promise<{ at: number; rising: Rising[]; warming?: number } | null> {
  return (await redis().get<{ at: number; rising: Rising[]; warming?: number }>(VIEW)) || null;
}

/** Is a new launch named after a rising narrative? */
export function pulseMatch(l: { name: string; symbol: string }, rising: Rising[]) {
  const n = (l.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const s = (l.symbol || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const x of rising) if (x.term.length >= 3 && (s === x.term || n === x.term || (x.term.length >= 5 && n.includes(x.term)))) return { term: x.term, x: x.x, mood: x.mood };
  return null;
}
