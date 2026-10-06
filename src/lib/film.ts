// FILM: the film room. Like a fighter watching tape of his own fights, FILM goes back over every decision the agents
// made and scores it against what the coin did next:
//   - every skip (VET, FLOW, never-chase, priors): where was the coin 30 minutes, 2 hours and 24 hours later?
//   - every King call: the bonds it didn't like (misses), the BOND calls that died, and which of its reasons were wrong.
// The scoreboard shows, per rule and per reason, how often the decision was right. nano already learns from every
// outcome; the priors switch themselves off when FILM and COACH show they cost money; the rest is on the page so a
// human can see which rule to retune.
import { redis } from "./redis";
import { getCurves } from "./solana";
import { readPools } from "./pool";

const DUE = "rn:fm:due";
const DEC = (id: string) => `rn:fm:d:${id}`;
const RULES = "rn:fm:rules"; // {rule}:{h}:n|right|wrong|sum
const REASONS = "rn:fm:why"; // {reason}|{bucket}: bucket = miss (said no, it bonded) / right (said no, it died) / hit / false
const MISSES = "rn:fm:miss"; // last 100 bonds the King didn't call BOND
const TTL = 9 * 86400;
export const FILM_H = [
  { k: "30m", ms: 30 * 60_000 },
  { k: "2h", ms: 2 * 3600_000 },
  { k: "24h", ms: 24 * 3600_000 },
] as const;

type Pipe = { set: Function; zadd: Function; lpush: Function; ltrim: Function; hincrby: Function; hincrbyfloat?: Function };
export type Decision = { id: string; kind: "skip"; rule: string; v: string; mint: string; symbol: string; at: number; px0: number; checks: { k: string; ret: number; bonded: boolean }[] };

/** Normalise a reason ("curve only 12% full at minute 5" -> "curve only #% full at minute #") so it can be tallied. */
export const norm = (s: string) => s.replace(/"[^"]*"/g, '"…"').replace(/[0-9]+(\.[0-9]+)?/g, "#").replace(/\s+/g, " ").trim();

/** A skip by any agent: followed at 30m, 2h, 24h. */
export async function logSkip(rule: string, v: string, mint: string, symbol: string, px0: number) {
  if (!px0) return;
  const r = redis();
  const at = Date.now();
  const id = `${mint}:${at}`;
  const d: Decision = { id, kind: "skip", rule, v, mint, symbol, at, px0, checks: [] };
  const p = r.pipeline();
  p.set(DEC(id), d, { ex: TTL });
  for (const h of FILM_H) p.zadd(DUE, { score: at + h.ms, member: `${id}|${h.k}` });
  await p.exec();
}

/** The King's call meets its outcome (called from the digger when a coin resolves). */
export function reviewCall(
  p: Pipe,
  call: { mint: string; symbol: string; verdict: string; score: number; nano: { verdict: string; score: number } | null; counted: boolean; why?: { plus: string[]; minus: string[] }; progress: number; at: number },
  bonded: boolean,
  bondSecs: number | null,
): { text: string; tone: string } | null {
  if (!call.counted) return null;
  const said = call.verdict;
  const minus = (call.why?.minus || []).map(norm);
  const plus = (call.why?.plus || []).map(norm);
  // reasons against: were they right (it died) or wrong (it bonded anyway)?
  for (const m of minus) p.hincrby(REASONS, `${m}|${bonded ? "miss" : "right"}`, 1);
  // reasons for: did they hold up?
  for (const m of plus) p.hincrby(REASONS, `${m}|${bonded ? "hit" : "false"}`, 1);
  p.hincrby(REASONS, `__${said}|${bonded ? "bonded" : "died"}`, 1);
  if (bonded && said !== "BOND") {
    p.lpush(MISSES, { mint: call.mint, symbol: call.symbol, verdict: said, score: call.score, nano: call.nano, minus: call.why?.minus || [], plus: call.why?.plus || [], curve: call.progress, bondSecs, at: Date.now() });
    p.ltrim(MISSES, 0, 99);
    const nanoTxt = call.nano ? ` nano said ${call.nano.verdict} ${call.nano.score}${call.nano.verdict === "BOND" ? " (nano had it)" : ""}.` : "";
    return { text: `$${call.symbol} bonded but the King said ${said} ${call.score}${call.why?.minus?.length ? ` (against: ${call.why.minus.join("; ")})` : ""}.${nanoTxt} logged as a miss, nano learns from it`, tone: "bad" };
  }
  if (!bonded && said === "BOND") return { text: `$${call.symbol}: BOND ${call.score} died${call.why?.plus?.length ? ` (for: ${call.why.plus.join("; ")})` : ""}. logged as a false BOND`, tone: "bad" };
  return null;
}

const ret = (a: number, b: number) => (b > 0 ? Math.log(Math.max(1e-9, a) / b) : 0);

/** Review due skips. Returns log lines for the desk feed. */
export async function filmStep(max = 12) {
  const r = redis();
  const now = Date.now();
  const due = ((await r.zrange<string[]>(DUE, 0, now, { byScore: true, offset: 0, count: max })) || []).map(String);
  if (!due.length) return [] as { text: string; tone: string; mint: string; symbol: string }[];
  await r.zrem(DUE, ...due);
  const ids = Array.from(new Set(due.map((d) => d.split("|")[0])));
  const recs = ((await r.mget<(Decision | null)[]>(...ids.map(DEC))) || []) as (Decision | null)[];
  const by: Record<string, Decision> = {};
  ids.forEach((id, i) => recs[i] && (by[id] = recs[i]!));
  const mints = Array.from(new Set(Object.values(by).map((d) => d.mint)));
  const [curves, pools] = await Promise.all([getCurves(mints).catch(() => ({} as any)), readPools(mints).catch(() => ({} as any))]);
  const out: { text: string; tone: string; mint: string; symbol: string }[] = [];
  const p = r.pipeline();
  for (const item of due) {
    const [id, k] = item.split("|");
    const d = by[id];
    if (!d) continue;
    const cv = curves[d.mint];
    const pool = pools[d.mint];
    const onCurve = !!cv && !cv.complete && cv.priceSol > 0;
    const px = onCurve ? cv.priceSol : pool?.px || 0;
    const bonded = !!pool?.px && !onCurve;
    const lr = px ? ret(px, d.px0) : Math.log(0.05); // no price at all: treat as dead (-95%)
    const pc = Math.round((Math.exp(lr) - 1) * 1000) / 10;
    // a skip was right when the coin went nowhere or down; wrong when it ran 30%+ or bonded
    const wrong = pc >= 30 || bonded;
    const right = pc <= 0 && !bonded;
    d.checks = [...d.checks.filter((c) => c.k !== k), { k, ret: pc, bonded }];
    p.set(DEC(id), d, { keepTtl: true });
    p.hincrby(RULES, `${d.rule}:${k}:n`, 1);
    if (right) p.hincrby(RULES, `${d.rule}:${k}:right`, 1);
    if (wrong) p.hincrby(RULES, `${d.rule}:${k}:wrong`, 1);
    p.hincrbyfloat(RULES, `${d.rule}:${k}:sum`, lr);
    if (k !== "30m" && (wrong || k === "24h"))
      out.push({ mint: d.mint, symbol: d.symbol, tone: wrong ? "bad" : "ok", text: `$${d.symbol} skipped for ${d.rule.replace(/_/g, " ")} (${d.v}): ${pc >= 0 ? "+" : ""}${pc}% ${k} later${bonded ? ", bonded" : ""}. ${wrong ? "that skip cost us" : right ? "right call" : "no harm either way"}` });
  }
  await p.exec();
  return out;
}

/** The film room scoreboard. */
export async function filmStats() {
  const r = redis();
  const [rules, why, misses, pending] = await Promise.all([r.hgetall<Record<string, number>>(RULES), r.hgetall<Record<string, number>>(REASONS), r.lrange(MISSES, 0, 11), r.zcard(DUE)]);
  const R = (rules || {}) as Record<string, number>;
  const names = Array.from(new Set(Object.keys(R).map((k) => k.split(":")[0])));
  const ruleRows = names
    .map((rule) => {
      const h = (k: string) => {
        const n = Number(R[`${rule}:${k}:n`] || 0);
        return { n, right: Number(R[`${rule}:${k}:right`] || 0), wrong: Number(R[`${rule}:${k}:wrong`] || 0), avg: n ? Math.round((Math.exp(Number(R[`${rule}:${k}:sum`] || 0) / n) - 1) * 1000) / 10 : null };
      };
      const h2 = h("2h");
      // verdict on the rule from the 2h checks: is skipping these coins saving money?
      const verdict = h2.n < 10 ? "learning" : (h2.avg ?? 0) > 15 || h2.wrong / h2.n > 0.35 ? "costing" : (h2.avg ?? 0) < 0 ? "saving" : "neutral";
      return { rule, m30: h("30m"), h2, d1: h("24h"), verdict };
    })
    .sort((a, b) => b.h2.n + b.m30.n - (a.h2.n + a.m30.n));
  const W = (why || {}) as Record<string, number>;
  const reasons: Record<string, { miss: number; right: number; hit: number; false: number }> = {};
  const calls: Record<string, { bonded: number; died: number }> = {};
  for (const [k, v] of Object.entries(W)) {
    const [reason, b] = k.split("|");
    if (reason.startsWith("__")) {
      const verdict = reason.slice(2);
      (calls[verdict] ||= { bonded: 0, died: 0 })[b as "bonded" | "died"] = Number(v);
      continue;
    }
    (reasons[reason] ||= { miss: 0, right: 0, hit: 0, false: 0 })[b as "miss"] = Number(v);
  }
  const against = Object.entries(reasons)
    .filter(([, x]) => x.miss + x.right >= 5)
    .map(([reason, x]) => ({ reason, n: x.miss + x.right, wrong: x.miss, rate: Math.round((x.miss / (x.miss + x.right)) * 1000) / 10 }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 8);
  const forR = Object.entries(reasons)
    .filter(([, x]) => x.hit + x.false >= 5)
    .map(([reason, x]) => ({ reason, n: x.hit + x.false, held: x.hit, rate: Math.round((x.hit / (x.hit + x.false)) * 1000) / 10 }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 8);
  return { pending: pending || 0, rules: ruleRows, against, forR, calls, misses: misses || [] };
}
