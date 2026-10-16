// v0.1.95: COMPOUNDING SIZE. A strategy that passed its exam on live coins is sized by its own record: the share of the
// bank that grows it fastest over its trips (Kelly), taken at a quarter (fat tails, and a record of 30 to 120 trips is
// a small sample), bounded between kellyMinPct and kellyMaxPct of the bank. The bank is the desk's equity at the buy,
// so every win makes the next trade bigger and every loss makes it smaller. Strategies that have not passed keep the
// flat sizePct. The liquidity cap, maxSol and the daily loss stop still apply on top.

/** The fraction of the bank (0 to 1) that maximises the average log growth over these returns (-0.5 = lost half). */
export function kellyFrac(rets: number[]): number {
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, r) => a + r, 0) / rets.length;
  if (mean <= 0) return 0;
  let best = 0;
  let bestG = 0;
  for (let i = 1; i <= 200; i++) {
    const f = i / 200;
    let g = 0;
    for (const r of rets) {
      const v = 1 + f * Math.max(-1, r);
      if (v <= 0) {
        g = -Infinity;
        break;
      }
      g += Math.log(v);
    }
    if (g > bestG) (bestG = g), (best = f);
  }
  return best;
}

export type SizeCfg = { sizePct: number; kellyFrac?: number; kellyMinPct?: number; kellyMaxPct?: number };
export type SizePlan = { pct: number; kelly: number; n: number; why: string };
export const KELLY_MIN_TRIPS = 30;

/**
 * The bank share for one trade of a passed strategy, from its trips' net returns in % (after every cost). Its 2 best
 * trips are left out (the exams judge without them too: one lucky coin must not size every trade after it), and one
 * total loss is added (a rug it has not met yet: without it, a record whose worst trip is -12% asks for the whole bank).
 * Fewer than 30 trips: null, the flat sizePct applies.
 */
export function sizePlan(pcts: number[] | undefined, cfg: SizeCfg): SizePlan | null {
  if (!pcts || pcts.length < KELLY_MIN_TRIPS) return null;
  const rets = [...pcts.map((p) => p / 100).sort((a, z) => z - a).slice(2), -1];
  const k = kellyFrac(rets);
  const frac = cfg.kellyFrac ?? 0.25;
  const lo = cfg.kellyMinPct ?? 1;
  const hi = cfg.kellyMaxPct ?? 10;
  const raw = k * frac * 100;
  const pct = Math.round(Math.max(lo, Math.min(hi, raw)) * 10) / 10;
  const why = k <= 0 ? `no edge without its 2 best trips: ${lo}% of the bank` : `Kelly ${Math.round(k * 100)}% x ${frac} = ${raw.toFixed(1)}%${raw > hi ? `, capped at ${hi}%` : raw < lo ? `, floor ${lo}%` : ""}`;
  return { pct, kelly: Math.round(k * 1000) / 1000, n: pcts.length, why };
}
