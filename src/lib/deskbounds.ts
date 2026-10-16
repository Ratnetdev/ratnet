// v0.1.100 (audit): hard bounds on every desk setting that moves money. The admin route refuses a save outside them,
// and getSettings clamps what it reads, so a value written to Redis some other way (a leaked REST token) can never set
// maxSol 1000 or 100% slippage either.
export const BOUNDS: Record<string, [number, number]> = {
  start: [0.01, 1000], sizePct: [0.1, 25], kellyFrac: [0.05, 0.5], kellyMinPct: [0.1, 10], kellyMaxPct: [1, 20], minSol: [0.001, 5], maxSol: [0.001, 5], maxImpact: [0.1, 20], maxOpen: [0, 20],
  slippageBps: [50, 3000], maxPriorityLamports: [0, 20_000_000], jitoTipMinSol: [0, 0.01], jitoTipMaxSol: [0, 0.02],
  dailyLoss: [1, 60], sl: [-90, -1], momoSl: [-90, -1], ghostSol: [0, 1], flowWaitMs: [0, 10_000], catchFirstFrac: [0.05, 1], catchSendFrac: [0, 1], catchSl: [-90, -1], flashSl: [-90, -1], flashMaxOpen: [0, 10], flashFreshMs: [1000, 60_000], flashMaxCurve: [5, 95], flashMaxChase: [0, 300],
};

/** Clamp the desk's numbers into their bounds; a non-number falls back to the default. */
export function clampDesk<T extends Record<string, unknown>>(desk: T, def: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...desk };
  for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
    if (!(k in out)) continue;
    const v = Number(out[k]);
    out[k] = Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def[k];
  }
  return out as T;
}
