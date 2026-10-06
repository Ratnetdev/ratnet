// Rat King v1: nano leads, and the BOND line is set by the data instead of by hand.
// Every lesson is scored by nano BEFORE nano learns from it (prequential: the model never grades itself on what it
// has already seen). Scores and outcomes go into 5-point buckets per day; over the last 7 days the BOND cutoff is the
// score that gives the best precision-weighted balance of hits and catches (F0.5), and WATCH is where the bond rate is
// at least twice the base rate. Recomputed every 10 minutes, public on /lab, the reasoning in the Strategy tab.
import { redis } from "./redis";

const DAY = (t: number) => `rn:kcal:${new Date(t).toISOString().slice(0, 10)}`;
const CAL = "rn:kcal:now";
const MIN_N = 1500; // labelled lessons in the window before v1 takes over
const MIN_POS = 15; // bonds among them
const MIN_ABOVE = 30; // lessons at or above a cutoff before it can be chosen

export type Cal = { at: number; ready: boolean; n: number; pos: number; base: number; bond: number | null; watch: number | null; prec: number | null; recall: number | null; table: { lo: number; n: number; b: number }[] };

export const bucketOf = (score: number) => Math.max(0, Math.min(19, Math.floor(score / 5)));

/** Pipeline: one labelled lesson, scored before learning. */
export function noteCal(p: { hincrby: Function; expire: Function }, score: number, bonded: boolean, at = Date.now()) {
  const k = DAY(at);
  const b = bucketOf(score);
  p.hincrby(k, `${b}:n`, 1);
  if (bonded) p.hincrby(k, `${b}:b`, 1);
  p.expire(k, 9 * 86400);
}

export async function computeCal(): Promise<Cal> {
  const r = redis();
  const now = Date.now();
  const days = await Promise.all(Array.from({ length: 7 }, (_, i) => r.hgetall<Record<string, number>>(DAY(now - i * 86400_000))));
  const table = Array.from({ length: 20 }, (_, i) => ({ lo: i * 5, n: 0, b: 0 }));
  for (const d of days)
    for (const [k, v] of Object.entries(d || {})) {
      const [i, f] = k.split(":");
      const row = table[Number(i)];
      if (row) f === "n" ? (row.n += Number(v)) : (row.b += Number(v));
    }
  const n = table.reduce((a, x) => a + x.n, 0);
  const pos = table.reduce((a, x) => a + x.b, 0);
  const base = n ? pos / n : 0;
  let best: { s: number; f: number; prec: number; recall: number } | null = null;
  let watch: number | null = null;
  for (let i = 19; i >= 0; i--) {
    const above = table.slice(i);
    const an = above.reduce((a, x) => a + x.n, 0);
    const ab = above.reduce((a, x) => a + x.b, 0);
    if (an < MIN_ABOVE || !pos) continue;
    const prec = ab / an;
    const recall = ab / pos;
    const f = prec + recall ? (1.25 * prec * recall) / (0.25 * prec + recall) : 0;
    if (prec >= 3 * base && (!best || f > best.f)) best = { s: i * 5, f, prec, recall };
    if (prec >= 2 * base) watch = i * 5;
  }
  const cal: Cal = {
    at: now,
    ready: n >= MIN_N && pos >= MIN_POS && !!best,
    n,
    pos,
    base: Math.round(base * 10000) / 100,
    bond: best ? best.s : null,
    watch: best && watch != null ? Math.min(watch, best.s) : null,
    prec: best ? Math.round(best.prec * 1000) / 10 : null,
    recall: best ? Math.round(best.recall * 1000) / 10 : null,
    table,
  };
  await r.set(CAL, cal);
  return cal;
}

export async function loadCal(): Promise<Cal | null> {
  return (await redis().get<Cal>(CAL)) || null;
}

/** Verdict from nano's score against the calibrated lines. */
export function v1Verdict(score: number, cal: Cal): "BOND" | "WATCH" | "DUST" {
  if (cal.bond != null && score >= cal.bond) return "BOND";
  if (cal.watch != null && score >= cal.watch) return "WATCH";
  return "DUST";
}

/** Class weight for a bond lesson: bonds are rare, so each one counts as much as the misses around it (capped). */
export function posWeight(n: number, pos: number) {
  if (n < 300 || pos < 5) return 8;
  return Math.max(4, Math.min(50, Math.round((n - pos) / pos)));
}
