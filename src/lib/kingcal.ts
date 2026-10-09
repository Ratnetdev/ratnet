// Rat King v1: nano leads, and the BOND line is set by the data instead of by hand.
// Every lesson is scored by nano BEFORE nano learns from it (prequential: the model never grades itself on what it
// has already seen). Scores and outcomes go into 5-point buckets per day; over the last 7 days the BOND cutoff is the
// score that gives the best precision-weighted balance of hits and catches (F0.5), and WATCH is where the bond rate is
// at least twice the base rate. Recomputed every 10 minutes, public on /lab, the reasoning in the Strategy tab.
import { redis } from "./redis";

// v1.1 (v0.1.29): the rebuilt nano (standardized inputs, Adam) gets its own calibration from scratch. v1.0's lines were
// drawn on the old model's scores and mean nothing for the new one; v1.0's record stays on the board under its name.
export const KING_V1 = "v1.1";
const DAY = (t: number) => `rn:kcal2:${new Date(t).toISOString().slice(0, 10)}`;
const CAL = "rn:kcal2:now";
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

// v0.1.65: who makes the King's calls is decided by the honest record (BOND calls graded at their 2-hour label), not
// by v1's own calibration. On 9 Oct v1.1 had taken over on its calibration alone and called BOND on 570 coins with a
// 1.4% bond rate (below the 2.2% base rate), while v0.3's rules had 10.7% on 206. Every counted call now grades both
// verdicts (v0 and v1, the one that did not lead in shadow), and v1 leads only once its record matches v0's.
export const LEAD_KEY = "rn:king:leader";
export const LEAD_MIN_V1 = 150; // v1 BOND calls graded before it can lead
export const LEAD_MIN_V0 = 100;
export type Lead = { at: number; leader: "v0" | "v1"; v0: { n: number; hit: number; prec: number | null }; v1: { n: number; hit: number; prec: number | null }; why: string };
const prec = (h: number, n: number) => (n ? Math.round((h / n) * 1000) / 10 : null);
/** From the stat hash: shadow counters (both verdicts graded) plus the per-version honest record before v0.1.65. */
export function leaderOf(s: Record<string, unknown>, v0Version: string, v1Version = KING_V1): Lead {
  const n = (k: string) => Number(s[k] || 0);
  // once both have a fresh side-by-side record (same coins, graded the same way), only that counts; until then the
  // per-version record from before v0.1.65 is added (so v0 leads from the first minute instead of v1 by default)
  const fresh = n("lbv:v1:n") >= LEAD_MIN_V1 && n("lbv:v0:n") >= LEAD_MIN_V0;
  const v0 = fresh ? { n: n("lbv:v0:n"), hit: n("lbv:v0:hit") } : { n: n("lbv:v0:n") + n(`lb:${v0Version}:n`), hit: n("lbv:v0:hit") + n(`lb:${v0Version}:hit`) };
  const v1 = fresh ? { n: n("lbv:v1:n"), hit: n("lbv:v1:hit") } : { n: n("lbv:v1:n") + n(`lb:${v1Version}:n`), hit: n("lbv:v1:hit") + n(`lb:${v1Version}:hit`) };
  const p0 = prec(v0.hit, v0.n), p1 = prec(v1.hit, v1.n);
  let leader: "v0" | "v1" = "v0";
  let why: string;
  if (v1.n < LEAD_MIN_V1) why = `v0 rules lead: v1 has ${v1.n} graded BOND calls (needs ${LEAD_MIN_V1})`;
  else if (v0.n >= LEAD_MIN_V0 && (p1 ?? 0) < (p0 ?? 0)) why = `v0 rules lead: ${p0}% of their BOND calls bonded vs ${p1}% for v1`;
  else (leader = "v1"), (why = `v1 leads: ${p1}% of its BOND calls bonded vs ${p0 ?? "–"}% for v0`);
  return { at: Date.now(), leader, v0: { ...v0, prec: p0 }, v1: { ...v1, prec: p1 }, why };
}
