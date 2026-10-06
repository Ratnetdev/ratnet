// WIRE's picker: when a post takes off, a dozen coins launch on it. Picking the right one is the whole game, and
// it is usually decided by volume, holder distribution and who was first. The picker scores every copy on those
// features with weights it LEARNS: two hours after each post it checks which copy actually ran furthest and moves
// its weights toward what the winner looked like (pairwise perceptron). The starting weights are a hint, not a law.
//
// Vamps: a later copy sometimes overtakes the first runner and sends harder. For 30 minutes after a pick the post
// stays on watch, and a copy that pulls clearly more SOL than the pick, faster, can be picked too (max 2 per post),
// only on posts with proven traction. Vamps run in their own PM sleeve, so they are sized by their own record.
import { redis, K } from "./redis";
import { agentLog } from "./agents";

export const PICK_FEATS = [
  { key: "first", label: "first coin on the post" },
  { key: "links", label: "links the post or posted CA" },
  { key: "match", label: "name match strength" },
  { key: "sol", label: "SOL in (log)" },
  { key: "pace", label: "SOL in per minute (log)" },
  { key: "uniq", label: "unique traders (log)" },
  { key: "top5", label: "top 5 holder share" },
  { key: "bundle", label: "bundle share" },
  { key: "late", label: "minutes after the first copy (log)" },
] as const;
// hint from the trenches: volume, spread-out holders and being first win most of the time
const PRIOR = [0.6, 0.5, 0.3, 1.0, 0.8, 0.6, -1.0, -1.0, -0.3];
const W_KEY = "rn:x:pickw";
const SET = (tid: string) => `rn:x:ps:${tid}`;
const DUE = "rn:x:psdue";
const VAMP = "rn:x:vamp"; // tid -> watch until
const VP = (tid: string) => `rn:x:vp:${tid}`; // mints already picked on a post
export const VAMP_WATCH_MS = 30 * 60_000;
export const VAMP_MAX = 2;

export type Cand = { mint: string; symbol: string; createdAt: number; score: number; how: string; progress: number; realSol: number; uniq?: number | null; top5?: number | null; bundle?: number | null };

export function featOf(c: Cand, firstAt: number, now: number) {
  const ageMin = Math.max(0.25, (now - c.createdAt) / 60_000);
  return [
    c.createdAt === firstAt ? 1 : 0,
    c.how === "links the post" || c.how === "posted the CA" ? 1 : 0,
    c.score,
    Math.log1p(Math.max(0, c.realSol)) / 4,
    Math.log1p(Math.max(0, c.realSol) / ageMin) / 3,
    c.uniq != null ? Math.log1p(c.uniq) / 5 : 0.4,
    c.top5 != null ? c.top5 : 0.5,
    c.bundle != null ? c.bundle : 0.3,
    Math.log1p(Math.max(0, (c.createdAt - firstAt) / 60_000)) / 3,
  ];
}

export async function loadW(): Promise<{ w: number[]; n: number; right: number }> {
  const m = await redis().get<{ w: number[]; n: number; right: number }>(W_KEY);
  return m && Array.isArray(m.w) && m.w.length === PRIOR.length ? m : { w: [...PRIOR], n: 0, right: 0 };
}
export const scoreOf = (w: number[], x: number[]) => x.reduce((a, v, i) => a + v * (w[i] || 0), 0);

/** Remember the copies of a post and what each looked like at pick time, for the lesson 2 hours later. */
export async function notePickSet(tid: string, h: string, picked: string, cands: { mint: string; symbol: string; x: number[] }[]) {
  const r = redis();
  await r.set(SET(tid), { at: Date.now(), h, picked, cands }, { ex: 86400 });
  await r.zadd(DUE, { score: Date.now() + 2 * 3600_000, member: tid });
  await r.zadd(VAMP, { score: Date.now() + VAMP_WATCH_MS, member: tid });
  await r.sadd(VP(tid), picked);
  await r.expire(VP(tid), 86400);
}

/** Posts still on vamp watch. */
export async function vampWatch() {
  const r = redis();
  await r.zremrangebyscore(VAMP, 0, Date.now());
  return ((await r.zrange<string[]>(VAMP, 0, 9)) || []).map(String);
}
export async function pickedOn(tid: string) {
  return ((await redis().smembers<string[]>(VP(tid))) || []).map(String);
}
export async function addVamp(tid: string, mint: string) {
  await redis().sadd(VP(tid), mint);
}

/** Two hours on: which copy ran furthest? Move the weights toward the winner. */
export async function pickLessons() {
  const r = redis();
  const due = ((await r.zrange<string[]>(DUE, 0, Date.now(), { byScore: true, offset: 0, count: 10 })) || []).map(String);
  if (!due.length) return { pickLessons: 0 };
  const m = await loadW();
  let n = 0;
  const evs: any[] = [];
  for (const tid of due) {
    await r.zrem(DUE, tid);
    const set = await r.get<{ h: string; picked: string; cands: { mint: string; symbol: string; x: number[] }[] }>(SET(tid));
    if (!set || set.cands.length < 2) continue;
    const recs = ((await r.mget<any[]>(...set.cands.map((c) => K.launch(c.mint)))) || []) as any[];
    // how far each copy went: bonded beats any curve %, then the highest curve it reached
    const reach = set.cands.map((c, i) => {
      const rec = recs[i];
      if (!rec) return 0;
      return rec.outcome === "BONDED" ? 100 + Math.min(100, 100 - (rec.bondSecs ?? 7200) / 72) : rec.peak ?? rec.pNow ?? 0;
    });
    const wi = reach.indexOf(Math.max(...reach));
    if (reach[wi] <= 0) continue;
    const win = set.cands[wi];
    const lr = 0.08;
    for (let j = 0; j < set.cands.length; j++) {
      if (j === wi || reach[j] >= reach[wi] * 0.8) continue;
      const o = set.cands[j];
      if (scoreOf(m.w, win.x) - scoreOf(m.w, o.x) < 0.5) for (let k = 0; k < m.w.length; k++) m.w[k] += lr * ((win.x[k] || 0) - (o.x[k] || 0));
    }
    m.n++;
    if (win.mint === set.picked) m.right++;
    n++;
    evs.push({ agent: "WIRE", at: Date.now(), mint: win.mint, symbol: win.symbol, text: `picker lesson on @${set.h}'s post: $${win.symbol} went furthest of ${set.cands.length} copies${win.mint === set.picked ? " (the one we picked)" : `, we picked $${set.cands.find((c) => c.mint === set.picked)?.symbol ?? "?"}`}. right on ${m.right} of ${m.n} posts`, tone: win.mint === set.picked ? "ok" : "bad" });
  }
  if (n) {
    m.w = m.w.map((v) => Math.round(v * 1000) / 1000);
    await r.set(W_KEY, m);
    const p = r.pipeline();
    agentLog(p, evs);
    await p.exec();
  }
  return { pickLessons: n };
}

export async function pickerView() {
  const m = await loadW();
  return { n: m.n, right: m.right, weights: PICK_FEATS.map((f, i) => ({ key: f.key, label: f.label, w: m.w[i], prior: PRIOR[i] })) };
}
