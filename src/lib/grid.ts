// v0.1.71: GRID. The big search for a strategy that wins, run on the archive instead of waiting days of live paper.
// ARENA's 20 books all lose (last 30 trips each, -11% to -31% per trade after costs), so instead of guessing the next
// variant, GRID tries thousands of them on every archived call with a price path:
//   - filters: no filter, 18 single rules on the call (verdicts, scores, curve band, curve speed, buyers, SOL per buy,
//     bundles, snipers, smart wallets, dev sold, socials, age) and every pair of them (172 filters)
//   - entry timing: at the call, on confirmation (the curve climbs more first), on a dip, or 2 minutes later if still up
//   - exits: initials at 1.5x/2x/3x, trail 25/40%, stop 25/45%, time 15/60 min
// Every trade pays the desk's costs at the desk's size (venue fee, slippage on the curve, tip, priority fee, rent) and
// fills at the first price 2+ seconds after the signal (the desk is never at the signal's own price).
//
// Against fooling ourselves (with ~29,000 combinations, the best one on any data looks great by luck):
//   - calls split by time: settings ranked on the older 70% (train), judged only on the newest 30% (test)
//   - ranked only if train has 40+ trades, profit factor 1.1+ without the best trade, and BOTH halves of train positive
//   - "passes" = the test meets PROMOTE's bar: 20+ trips, 35%+ won, avg +2%+, PF 1.1+ without the best trade
//   - v0.1.112, and also: the exits one step away mostly in profit on the test (PLATEAU), the newest third of the test
//     in profit on its own (NEWEST SLICE), and a test t-stat above the luck bar the same search sets on shuffled
//     outcomes (NULL RUN)
// A pass is a candidate, not a strategy: it goes into ARENA next and must prove itself on live coins.
import { originHist } from "./origin";
import { dxAt, dxHistAll, dxQueue } from "./attention";
import { themeHeat, themeOf, themeQueue } from "./theme";
import { loadLiveFees, paperPriority } from "./livecost";
import { SITE } from "@/config/site";
import { ATA_RENT, sellProceeds, slipOf, txCost, venueFee, type CostCfg } from "./costs";

const D = (SITE as any).desk || {};
export const GRID_SOL = Number(D.minSol ?? 0.05); // the desk's trade size (5% of a 1 SOL paper desk)
// v0.1.96: the priority fee paper pays is what live transactions paid (lib/livecost.ts), the setting until there are 10
const COST: CostCfg = { jitoTipMinSol: D.jitoTipMinSol, jitoTipMaxSol: D.jitoTipMaxSol, get paperPrioritySol() { return paperPriority(D.paperPrioritySol); } };
const FILL_DELAY = 2_000;
const PATH_MS = 62 * 60_000; // the curve: the hour after the call
export const HOLD_MS = 6 * 3600_000; // v0.1.72: through the migration, up to 6 hours (lib/after.ts)

export type GCoin = {
  mint: string;
  symbol: string;
  at: number; // call time
  createdAt: number;
  verdict: string;
  score: number;
  nano: number | null;
  progress: number;
  rise60: number; // curve points gained in the minute before the call
  uniq: number | null;
  spb: number | null;
  bs: number | null;
  sn: number | null;
  sm: number;
  ds: boolean;
  soc: number;
  // v0.1.81 (FIREHOSE): proven wallets that bought, unique buyers / SOL buy share / 2+ SOL buys in the last minute
  pw?: number | null;
  u60?: number | null;
  bs60?: number | null;
  wh?: number | null;
  // v0.1.105 (FIREHOSE flows at the call): tracked KOL wallets that bought, the market cap ($) at the first KOL buy,
  // KOLs that already sold, and the share of the first 20 buyers that sold. From this build on; unknown never passes
  kf?: number | null;
  kmu?: number | null;
  kx?: number | null;
  e20?: number | null;
  // v0.1.101 SIGNAL PIPE: what the social agents knew at the call (call.sx). Unknown (null) never passes
  sx?: Sx | null;
  bonded?: boolean; // migrated (the senders: every coin that did millions in volume is one of these)
  bondSecs?: number | null;
  image?: string; // v0.1.109: for Claude's label (from the archived call)
  name?: string;
  // the path from the call on (ms after the call), mcSol, real SOL, migrated
  t: Int32Array;
  mc: Float32Array;
  real: Float32Array;
  prog: Float32Array;
  done: Uint8Array;
};

/**
 * v0.1.101: the social and narrative signals at the call. post/bigpost/pulse come from the launch record (known at
 * the dig, also in the archive for older calls); lens/xf/tg (LENS), kol/ftop (HOUND) and mind (MIND) only exist on
 * calls from this build on, and only when that agent had read the coin by minute 5 (never looked ahead).
 */
export type Sx = { post: 0 | 1 | null; bigpost: 0 | 1 | null; pulse: 0 | 1 | null; lens: number | null; xf: number | null; tg: number | null; kol: number | null; ftop: number | null; mind: string | null; seer?: { tier: number; rank: number } | null; og?: { rank: number; cr: number; alpha: 0 | 1 | null; beta: 0 | 1 | null } | null; dx?: { paid: 0 | 1 | null; boost: number | null } | null; ev?: { rank: number | null; md: 0 | 1 | null; rep: number | null; f: number } | null; th?: { m: number; t: string; heat: number } | null };
export type Pred = { id: string; label: string; ok: (c: GCoin) => boolean };
export const PREDS: Pred[] = [
  { id: "bond", label: "King BOND", ok: (c) => c.verdict === "BOND" },
  { id: "watch", label: "King WATCH or BOND", ok: (c) => c.verdict === "BOND" || c.verdict === "WATCH" },
  { id: "s60", label: "King score 60+", ok: (c) => c.score >= 60 },
  { id: "n50", label: "nano 50+", ok: (c) => (c.nano ?? 0) >= 50 },
  { id: "p4", label: "curve 4-15%", ok: (c) => c.progress >= 4 && c.progress < 15 },
  { id: "p15", label: "curve 15-35%", ok: (c) => c.progress >= 15 && c.progress < 35 },
  { id: "p35", label: "curve 35-70%", ok: (c) => c.progress >= 35 && c.progress <= 70 },
  { id: "p70", label: "curve 70%+ (near migration)", ok: (c) => c.progress > 70 },
  { id: "r5", label: "curve +5 pts in the minute before", ok: (c) => c.rise60 >= 5 },
  { id: "r15", label: "curve +15 pts in the minute before", ok: (c) => c.rise60 >= 15 },
  { id: "u20", label: "20+ unique buyers", ok: (c) => (c.uniq ?? 0) >= 20 },
  { id: "u50", label: "50+ unique buyers", ok: (c) => (c.uniq ?? 0) >= 50 },
  { id: "spb", label: "0.3+ SOL per buy", ok: (c) => (c.spb ?? 0) >= 0.3 },
  { id: "bs", label: "bundles under 20%", ok: (c) => c.bs != null && c.bs < 0.2 },
  { id: "sn", label: "3 snipers or fewer", ok: (c) => c.sn != null && c.sn <= 3 },
  { id: "sm", label: "a smart wallet bought", ok: (c) => c.sm >= 1 },
  { id: "nods", label: "dev has not sold", ok: (c) => !c.ds },
  { id: "soc", label: "has a social link", ok: (c) => c.soc >= 1 },
  { id: "young", label: "called within 2 min of launch", ok: (c) => c.at - c.createdAt <= 120_000 },
  // v0.1.81 (FIREHOSE): WALLETS and TAPE ALL. Unknown (no firehose at the time) never passes
  { id: "pw1", label: "a proven wallet bought", ok: (c) => (c.pw ?? 0) >= 1 },
  { id: "pw2", label: "2+ proven wallets bought", ok: (c) => (c.pw ?? 0) >= 2 },
  { id: "u25", label: "25+ buyers in the last minute", ok: (c) => (c.u60 ?? 0) >= 25 },
  { id: "bs70", label: "70%+ of the last minute's SOL was buying", ok: (c) => c.bs60 != null && c.bs60 >= 0.7 },
  { id: "wh", label: "a 2+ SOL buy in the last minute", ok: (c) => (c.wh ?? 0) >= 1 },
  // v0.1.101 SIGNAL PIPE: the social agents' reads, so GRID tests them like every other rule (appended: pair ids keep
  // their order). Unknown never passes
  { id: "post", label: "born from an X post", ok: (c) => c.sx?.post === 1 },
  { id: "bigpost", label: "the post's author has 100K+ followers, or the CA was posted", ok: (c) => c.sx?.bigpost === 1 },
  { id: "pulse", label: "matches a rising X topic", ok: (c) => c.sx?.pulse === 1 },
  { id: "lens60", label: "LENS score 60+", ok: (c) => (c.sx?.lens ?? -1) >= 60 },
  { id: "xf5k", label: "its X account has 5K+ followers", ok: (c) => (c.sx?.xf ?? -1) >= 5000 },
  { id: "tg500", label: "its Telegram has 500+ members", ok: (c) => (c.sx?.tg ?? -1) >= 500 },
  { id: "kol2", label: "2+ tracked KOL wallets bought", ok: (c) => (c.sx?.kol ?? -1) >= 2 },
  { id: "ftop", label: "a FOMO top trader bought", ok: (c) => (c.sx?.ftop ?? -1) >= 1 },
  { id: "mindpass", label: "MIND passed on it", ok: (c) => c.sx?.mind === "PASS" },
  { id: "mindwatch", label: "MIND rated it WATCH or SEND", ok: (c) => c.sx?.mind === "WATCH" || c.sx?.mind === "SEND" },
  // v0.1.102 SEER: on the watchlist before it was launched (lib/seer.ts)
  { id: "seer", label: "SEER foresaw it (on the watchlist before launch)", ok: (c) => !!c.sx?.seer },
  { id: "seertop", label: "SEER foresaw it, a tier-1 event or person", ok: (c) => c.sx?.seer?.tier === 1 },
  { id: "seerfirst", label: "the first coin for a SEER watchlist entry", ok: (c) => c.sx?.seer?.rank === 1 },
  // v0.1.103 ORIGIN (lib/origin.ts): first of its name, ticker and image in 7 days, or a copy; the biggest of its
  // name group or a beta under 10% of it; the creator's launches in the 7 days before. Unknown never passes
  { id: "first", label: "the first coin of its name, ticker and image (7 days)", ok: (c) => c.sx?.og?.rank === 1 },
  { id: "copy", label: "a copy (an earlier coin had its name, ticker or image)", ok: (c) => (c.sx?.og?.rank ?? 0) >= 2 },
  { id: "alpha", label: "the biggest coin of its name group right now", ok: (c) => c.sx?.og?.alpha === 1 },
  { id: "beta", label: "under 10% of its name group's biggest coin", ok: (c) => c.sx?.og?.beta === 1 },
  { id: "lowauto", label: "the creator's first launch in 7 days", ok: (c) => c.sx?.og?.cr === 0 },
  { id: "serial", label: "a launch factory (10+ launches in 7 days)", ok: (c) => (c.sx?.og?.cr ?? -1) >= 10 },
  // v0.1.104 ATTENTION (lib/attention.ts): DexScreener orders paid before the call. Unknown never passes
  { id: "dexpaid", label: "a DexScreener profile was paid before the call", ok: (c) => c.sx?.dx?.paid === 1 },
  { id: "boosted", label: "DexScreener boosts were bought before the call", ok: (c) => (c.sx?.dx?.boost ?? 0) > 0 },
  // v0.1.105 KOL and EXIT flows (lib/tapeall.ts, every trade on the firehose). Unknown never passes
  { id: "kol3", label: "3+ tracked KOL wallets bought", ok: (c) => (c.kf ?? -1) >= 3 },
  { id: "kolsmall", label: "the first KOL bought under $10K market cap", ok: (c) => c.kmu != null && c.kmu > 0 && c.kmu < 10_000 },
  { id: "kolout", label: "a KOL that bought has already sold", ok: (c) => (c.kx ?? -1) >= 1 },
  { id: "hold20", label: "the first 20 buyers mostly hold (20% or fewer sold)", ok: (c) => c.e20 != null && c.e20 <= 0.2 },
  { id: "exit20", label: "half or more of the first 20 buyers sold", ok: (c) => c.e20 != null && c.e20 >= 0.5 },
  // v0.1.107 EVENT: the post a coin was born from (WIRE). Unknown never passes
  { id: "firstpost", label: "the first coin for its post", ok: (c) => c.sx?.ev?.rank === 1 },
  { id: "bigfirst", label: "the first coin for a 100K+ account's post", ok: (c) => c.sx?.ev?.rank === 1 && (c.sx?.ev?.f ?? 0) >= 100_000 },
  { id: "mediapost", label: "its post had an image or video", ok: (c) => c.sx?.ev?.md === 1 },
  { id: "repeatpost", label: "the author posted about it 2+ times in the hour", ok: (c) => (c.sx?.ev?.rep ?? 0) >= 2 },
  // v0.1.109 IMAGE and THEME (lib/theme.ts): Claude's label of the picture and name; theme heat = labelled coins of the
  // same theme that migrated in the 6 hours before. Unknown never passes
  { id: "meme70", label: "Claude rates the meme 70+", ok: (c) => (c.sx?.th?.m ?? -1) >= 70 },
  { id: "thanimal", label: "theme: animal", ok: (c) => c.sx?.th?.t === "animal" },
  { id: "thpolitical", label: "theme: political", ok: (c) => c.sx?.th?.t === "political" },
  { id: "thai", label: "theme: AI", ok: (c) => c.sx?.th?.t === "ai" },
  { id: "thcelebrity", label: "theme: celebrity", ok: (c) => c.sx?.th?.t === "celebrity" },
  { id: "thculture", label: "theme: culture", ok: (c) => c.sx?.th?.t === "culture" },
  { id: "themehot", label: "2+ coins of its theme migrated in the last 6 hours", ok: (c) => (c.sx?.th?.heat ?? 0) >= 2 },
  // v0.1.112 GRID SCORE: every rule above combined into one score (lib: fitScore), fitted on the older calls only.
  // No model yet: never passes
  { id: "score10", label: "GRID SCORE top 10% (every signal combined)", ok: (c) => scoreTop(c, "thr10") },
  { id: "score20", label: "GRID SCORE top 20% (every signal combined)", ok: (c) => scoreTop(c, "thr20") },
  // v0.1.114 PROFIT SCORE: the same combination, its target the trade itself (made money after every cost), not the
  // migration (which the price had mostly paid for already: GRID SCORE's top calls migrated 7.8x more often and lost)
  { id: "pscore10", label: "PROFIT SCORE top 10% (every signal, fitted on trades that paid)", ok: (c) => scoreTop(c, "thr10", PSCORE) },
  { id: "pscore20", label: "PROFIT SCORE top 20% (every signal, fitted on trades that paid)", ok: (c) => scoreTop(c, "thr20", PSCORE) },
];

// ---------------------------------------------------------------- v0.1.112 GRID SCORE
// Roan's point (Grinold's Fundamental Law): many weak signals, combined, beat one strong one, but only the INDEPENDENT
// ones count (IR = IC x sqrt(N effective)). One logistic model over every rule, its target "the coin migrated", fitted
// with a ridge (rules that say the same thing share their weight instead of doubling it). Fitted on GRID's older 70%
// only; the newer 30% judges it like every other rule. Effective N = how many independent rules the menu really holds.
export const SCORE_RULES = new Set(["score10", "score20", "pscore10", "pscore20"]);
export type ScoreModel = { ids: string[]; w: number[]; b: number; thr10: number; thr20: number; at: number; auc?: number | null };
let SCORE: ScoreModel | null = null;
let PSCORE: ScoreModel | null = null;
export const scoreModel = () => SCORE;
export const profitModel = () => PSCORE;
const validModel = (m: ScoreModel | null | undefined) => (m && Array.isArray(m.ids) && Array.isArray(m.w) && m.ids.length === m.w.length && m.ids.length > 0 && Number.isFinite(m.thr10) && Number.isFinite(m.thr20) ? m : null);
export function setScoreModel(m: ScoreModel | null | undefined) {
  return (SCORE = validModel(m));
}
export function setProfitModel(m: ScoreModel | null | undefined) {
  return (PSCORE = validModel(m));
}
let PBY: Map<string, Pred> | null = null;
const predById = (id: string) => (PBY ??= new Map(PREDS.map((p) => [p.id, p]))).get(id);
/** The call's GRID SCORE (log-odds of migrating), or null without a model. */
export function scoreOf(c: GCoin, m: ScoreModel | null = SCORE): number | null {
  if (!m) return null;
  let s = m.b;
  for (let k = 0; k < m.ids.length; k++) if (predById(m.ids[k])?.ok(c)) s += m.w[k];
  return s;
}
function scoreTop(c: GCoin, thr: "thr10" | "thr20", m: ScoreModel | null = SCORE) {
  const s = scoreOf(c, m);
  return s != null && !!m && s >= m[thr];
}

/** Ridge logistic regression on 0/1 columns (Newton steps). cols[k][i] = rule k on coin i (i < n). */
export function fitLogit(cols: Uint8Array[], y: Uint8Array, n: number, lambda = 2, iters = 40) {
  const p = cols.length;
  const D = p + 1; // the intercept last
  const act: Int32Array[] = [];
  for (let i = 0; i < n; i++) {
    const a: number[] = [];
    for (let k = 0; k < p; k++) if (cols[k][i]) a.push(k);
    act.push(Int32Array.from(a));
  }
  let ys = 0;
  for (let i = 0; i < n; i++) ys += y[i];
  const base = Math.min(0.999, Math.max(0.001, ys / Math.max(1, n)));
  const w = new Float64Array(D);
  w[p] = Math.log(base / (1 - base));
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: D }, () => new Float64Array(D));
    const g = new Float64Array(D);
    for (let i = 0; i < n; i++) {
      let z = w[p];
      for (const k of act[i]) z += w[k];
      const q = 1 / (1 + Math.exp(-z));
      const e = y[i] - q;
      const v = Math.max(1e-6, q * (1 - q));
      const a = act[i];
      for (const k of a) {
        g[k] += e;
        for (const j of a) H[k][j] += v;
        H[k][p] += v;
        H[p][k] += v;
      }
      g[p] += e;
      H[p][p] += v;
    }
    for (let k = 0; k < p; k++) (g[k] -= lambda * w[k]), (H[k][k] += lambda);
    const step = solve(H, g);
    if (!step) break;
    // v0.1.112 fix (first live run, 17 Oct): a full Newton step overshoots when a rule (almost) separates the coins and
    // the fit swung between +15 and 0 on that rule, never settling. Damped: halve the step until the penalised
    // likelihood improves
    const f0 = objective(w);
    let t = 1;
    let moved = false;
    for (let h = 0; h < 30; h++, t /= 2) {
      const tw = Float64Array.from(w, (v, k) => v + t * step[k]);
      if (objective(tw) >= f0 - 1e-9) {
        w.set(tw);
        moved = true;
        break;
      }
    }
    let mx = 0;
    for (let k = 0; k < D; k++) mx = Math.max(mx, Math.abs(t * step[k]));
    if (!moved || mx < 1e-6) break;
  }
  return { w: Array.from(w.slice(0, p)), b: w[p] };
  function objective(v: Float64Array) {
    let f = 0;
    for (let i = 0; i < n; i++) {
      let z = v[p];
      for (const k of act[i]) z += v[k];
      // log(1 + e^z), without overflow
      f += y[i] * z - (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z)));
    }
    for (let k = 0; k < p; k++) f -= (lambda / 2) * v[k] * v[k];
    return f;
  }
}
/** Gaussian elimination with partial pivoting (A x = b), null if singular. */
function solve(A: Float64Array[], b: Float64Array): Float64Array | null {
  const n = b.length;
  const M = A.map((r, i) => {
    const x = new Float64Array(n + 1);
    x.set(r);
    x[n] = b[i];
    return x;
  });
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return Float64Array.from(M.map((r, i) => r[n] / r[i]));
}
/** How many independent rules a set of 0/1 columns holds: p^2 / sum of squared correlations (p if all independent, 1 if all the same). */
export function effectiveN(cols: Uint8Array[], n: number) {
  const p = cols.length;
  if (!p || n < 2) return 0;
  const m = cols.map((c) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += c[i];
    return s / n;
  });
  let sum = 0;
  for (let a = 0; a < p; a++)
    for (let b = 0; b < p; b++) {
      if (a === b) {
        sum += 1;
        continue;
      }
      let co = 0;
      for (let i = 0; i < n; i++) if (cols[a][i] && cols[b][i]) co++;
      const den = Math.sqrt(m[a] * (1 - m[a]) * m[b] * (1 - m[b]));
      const r = den > 0 ? (co / n - m[a] * m[b]) / den : 0;
      sum += r * r;
    }
  return Math.round(((p * p) / sum) * 10) / 10;
}
/** Area under the ROC curve: how often a migrated coin scores above one that did not (0.5 = no better than a coin flip). */
export function aucOf(s: number[], y: number[]) {
  const idx = s.map((_, i) => i).sort((a, b) => s[a] - s[b]);
  let pos = 0, neg = 0, rankSum = 0;
  for (let k = 0; k < idx.length; ) {
    let j = k;
    while (j + 1 < idx.length && s[idx[j + 1]] === s[idx[k]]) j++;
    const r = (k + j) / 2 + 1; // average rank of the ties
    for (let t = k; t <= j; t++) if (y[idx[t]]) (pos++, (rankSum += r));
    k = j + 1;
  }
  neg = idx.length - pos;
  return pos && neg ? Math.round(((rankSum - (pos * (pos + 1)) / 2) / (pos * neg)) * 1000) / 1000 : null;
}
/**
 * Fit the GRID SCORE on the older calls (index < cut) and judge it on the newer ones. Only rules that fire on 30+ and
 * miss 30+ of the older calls take part (a rule that never or always fires says nothing).
 * v0.1.114: lab = another target. The PROFIT SCORE uses "the reference trade made money after every cost" on the calls
 * that trade (use), and reports the newer calls' average trade in each band (pnl, in SOL on `cost`).
 */
export function fitScore(cs: GCoin[], hit: (boolean[] | undefined)[], cut: number, now = Date.now(), lab?: { y: Uint8Array; use: Uint8Array; pnl?: Float32Array; cost?: number; what?: string }) {
  const N = cs.length;
  const y = lab ? lab.y : Uint8Array.from(cs.map((c) => (c.bonded ? 1 : 0)));
  const use = (i: number) => !lab || !!lab.use[i];
  const trI: number[] = [];
  const teI: number[] = [];
  for (let i = 0; i < N; i++) if (use(i)) (i < cut ? trI : teI).push(i);
  const what = lab?.what || "migrations";
  const ids: string[] = [];
  const cols: Uint8Array[] = [];
  PREDS.forEach((p, k) => {
    const h = hit[k];
    if (!h || SCORE_RULES.has(p.id)) return;
    let n = 0;
    for (const i of trI) if (h[i]) n++;
    if (n < 30 || trI.length - n < 30) return;
    ids.push(p.id);
    cols.push(Uint8Array.from(h, (v) => (v ? 1 : 0)));
  });
  let ytr = 0;
  for (const i of trI) ytr += y[i];
  if (!ids.length || ytr < 10 || trI.length - ytr < 10) return { model: null, used: ids.length, effN: 0, top: [], test: null, why: !ids.length ? "no rule fires often enough" : `too few ${what} in the older calls` };
  const tcols = cols.map((c) => Uint8Array.from(trI, (i) => c[i]));
  const { w, b } = fitLogit(tcols, Uint8Array.from(trI, (i) => y[i]), trI.length);
  if (![...w, b].every(Number.isFinite)) return { model: null, used: ids.length, effN: 0, top: [], test: null, why: "the fit did not settle" };
  const sc = (i: number) => {
    let s = b;
    for (let k = 0; k < ids.length; k++) if (cols[k][i]) s += w[k];
    return s;
  };
  const tr = trI.map(sc).sort((a, z) => z - a);
  const thr10 = tr[Math.max(0, Math.floor(tr.length * 0.1) - 1)];
  const thr20 = tr[Math.max(0, Math.floor(tr.length * 0.2) - 1)];
  const model: ScoreModel = { ids, w: w.map((v) => Math.round(v * 1000) / 1000), b: Math.round(b * 1000) / 1000, thr10, thr20, at: now };
  // judged on the newer calls only
  const te = teI.map(sc);
  const yte = teI.map((i) => y[i]);
  const base = yte.length ? yte.reduce((a, v) => a + v, 0) / yte.length : 0;
  const cost = lab?.cost || 0;
  const avgOf = (ix: number[]) => (lab?.pnl && cost && ix.length ? Math.round((ix.reduce((a, i) => a + lab.pnl![i], 0) / ix.length / cost) * 1000) / 10 : null);
  const band = (thr: number) => {
    const ix = teI.filter((_, k) => te[k] >= thr);
    const s = ix.reduce((a, i) => a + y[i], 0);
    const n = ix.length;
    return { n, rate: n ? Math.round((s / n) * 1000) / 10 : 0, lift: n && base > 0 ? Math.round((s / n / base) * 100) / 100 : 0, avgPct: avgOf(ix) };
  };
  model.auc = aucOf(te, yte);
  const top = ids.map((id, k) => ({ id, odds: Math.round(Math.exp(w[k]) * 100) / 100 })).sort((a, z) => Math.abs(Math.log(z.odds)) - Math.abs(Math.log(a.odds))).slice(0, 8);
  return { model, used: ids.length, effN: effectiveN(tcols, trI.length), top, test: { n: te.length, base: Math.round(base * 1000) / 10, avgPct: avgOf(teI), auc: model.auc, top10: band(thr10), top20: band(thr20) }, why: "" };
}
/** v0.1.112 PLATEAU: the exits one step away (one setting changed to the next value on the menu). Runners have none. */
export function neighbourIdx(xi: number): number[] {
  const x = GEXITS[xi];
  if (!x || isRunner(x)) return [];
  const out: number[] = [];
  GEXITS.forEach((e, j) => {
    if (j === xi || isRunner(e)) return;
    const diff = [e.initials !== x.initials, e.trail !== x.trail, e.stop !== x.stop, e.timeMin !== x.timeMin, e.mig !== x.mig].filter(Boolean).length;
    if (diff !== 1) return;
    // initials has 3 values: only the next one up or down is a neighbour (1.5 and 3 are two steps apart)
    if (e.initials !== x.initials && Math.abs(INIT.indexOf(e.initials) - INIT.indexOf(x.initials)) !== 1) return;
    out.push(j);
  });
  return out;
}
const INIT = [1.5, 2, 3];

/** v0.1.101: the call's social read for GRID, from call.sx, or for calls before this build from the archived launch. */
export function sxOf(call: any, wire?: any, pulse?: any, og?: { rank: number; cr: number } | null, dx?: { paid: 0 | 1 | null; boost: number | null } | null, postRank?: number | null): Sx | null {
  // v0.1.103: older calls get their origin from the archive (as of their creation; alpha/beta need live prices: unknown)
  const ogH = og ? { rank: og.rank, cr: og.cr, alpha: null, beta: null } : null;
  // a CA posted can come long after the call (a later post): not counted for older calls, never a look ahead
  const w = wire && !/\bCA\b|posted the ca/i.test(String(wire.how || "")) ? wire : null;
  // v0.1.107: older calls get the post rank from the archive (coins matched to the same post, in creation order); media
  // and repeat posts exist from this build on
  const ev = w ? { rank: w.rank ?? postRank ?? null, md: w.md === undefined ? null : w.md ? (1 as const) : (0 as const), rep: w.rep ?? null, f: Number(w.f) || 0 } : null;
  // v0.1.104: DexScreener's order history (payment times, read as of the call) is the truth; the call's live read is
  // the fallback while the history is not fetched yet
  if (call?.sx) {
    let s = call.sx.og || !ogH ? (call.sx as Sx) : { ...(call.sx as Sx), og: ogH };
    if (s.ev === undefined && ev) s = { ...s, ev }; // calls from v0.1.101 to v0.1.106
    return dx ? { ...s, dx } : s;
  }
  if (wire === undefined && pulse === undefined && !ogH && !dx) return null;
  return { post: w ? 1 : 0, bigpost: w ? (Number(w.f) >= 100_000 ? 1 : 0) : 0, pulse: pulse ? 1 : 0, lens: null, xf: null, tg: null, kol: null, ftop: null, mind: null, og: ogH, dx: dx ?? null, ev };
}

export type Mode = { id: string; label: string; kind: "now" | "climb" | "dip" | "hold" | "mig"; a: number; win: number };
export const MODES: Mode[] = [
  { id: "now", label: "at the call", kind: "now", a: 0, win: 0 },
  { id: "c5", label: "once the curve gains 5 more points (within 3 min)", kind: "climb", a: 5, win: 3 },
  { id: "c10", label: "once the curve gains 10 more points (within 5 min)", kind: "climb", a: 10, win: 5 },
  { id: "c20", label: "once the curve gains 20 more points (within 10 min)", kind: "climb", a: 20, win: 10 },
  { id: "d15", label: "on a 15% dip (within 10 min)", kind: "dip", a: 0.15, win: 10 },
  { id: "d30", label: "on a 30% dip (within 10 min)", kind: "dip", a: 0.3, win: 10 },
  { id: "h2", label: "2 min after the call, if still above the call price", kind: "hold", a: 0, win: 2 },
  // v0.1.72: the senders were at ~80% curve when called and migrated ~8 minutes later: buy the migration itself
  { id: "mig", label: "when it migrates (within 30 min of the call)", kind: "mig", a: 0, win: 30 },
];

// v0.1.72: mig = what happens at the migration: "sell" (as before) or "hold" through it into the pool (up to 6 hours,
// the same initials, trail and stop on the pool price, at pool fees)
export type GExit = { initials: number; trail: number; stop: number; timeMin: number; mig: "sell" | "hold"; keep?: number; hours?: number };
/**
 * v0.1.89: RUNNER exits. The King's edge is in the right tail ($FTR 246x, $Nihilism 138x from the call on 15 Oct), and
 * the regular exits sell half at 1.5 to 3x and are out within the hour (6h in the pool). A runner exit sells most at
 * its first target and lets the rest (keep) ride a wide trail for up to `hours`, through the migration.
 */
export const isRunner = (x: Pick<GExit, "hours"> | null | undefined) => !!x && (x.hours ?? 0) > 0;
/** The share sold at the first target: half on the regular exits, all but `keep` on a runner. */
export const firstSell = (x: GExit) => (isRunner(x) ? Math.max(0, Math.min(1, 1 - (x.keep ?? 0.5))) : 0.5);
/** How long a position may be held at most (ms). */
export const holdMax = (x: GExit) => (isRunner(x) ? x.hours! * 3600_000 : x.mig === "hold" ? HOLD_MS : PATH_MS);
export const RUNNER_EXITS: GExit[] = [
  { initials: 2, trail: 0.5, stop: 0.35, timeMin: 60, mig: "hold", keep: 0.3, hours: 24 },
  { initials: 3, trail: 0.5, stop: 0.35, timeMin: 240, mig: "hold", keep: 0.3, hours: 24 },
  { initials: 3, trail: 0.6, stop: 0.4, timeMin: 240, mig: "hold", keep: 0.5, hours: 24 },
];
/** How far after the call GRID loads a coin's prices: a day, for the runner exits (v0.1.89) */
export const RUN_MS = 24 * 3600_000;
/** An exit from its key part ("2/0.5/0.35/60/hold/k0.3h24"), or null. */
export function exitOfPart(part: string | undefined): GExit | null {
  const m = String(part || "").split("/");
  if (m.length < 4) return null;
  const v = m.slice(0, 4).map(Number);
  if (!v.every(Number.isFinite)) return null;
  const x: GExit = { initials: v[0], trail: v[1], stop: v[2], timeMin: v[3], mig: m[4] === "hold" ? "hold" : "sell" };
  const r = /^k([0-9.]+)h([0-9.]+)$/.exec(m[5] || "");
  if (r) Object.assign(x, { keep: Number(r[1]), hours: Number(r[2]), mig: "hold" });
  return x;
}
export const GEXITS: GExit[] = [];
for (const mig of ["sell", "hold"] as const) for (const initials of [1.5, 2, 3]) for (const trail of [0.25, 0.4]) for (const stop of [0.25, 0.45]) for (const timeMin of [15, 60]) GEXITS.push({ initials, trail, stop, timeMin, mig });
// v0.1.89: the runner exits on GRID's menu too, after the regular ones (their numbers stay the same for RESEARCHER)
GEXITS.push(...RUNNER_EXITS);
export const exitText = (x: GExit) =>
  isRunner(x)
    ? `RUNNER: ${Math.round(firstSell(x) * 100)}% at ${x.initials}x, the rest rides a ${Math.round(x.trail * 100)}% trail for up to ${x.hours}h through the migration, stop -${Math.round(x.stop * 100)}%, out after ${x.timeMin}m without the first target`
    : `half at ${x.initials}x, trail ${Math.round(x.trail * 100)}%, stop -${Math.round(x.stop * 100)}%, out after ${x.timeMin}m without initials, ${x.mig === "hold" ? "holds through the migration (up to 6h)" : "sells at the migration"}`;

/** The tick the desk would fill at for a mode, or -1 (no entry). done: 0 curve, 1 the migration, 2 pool prices after it. */
export function entryIndex(c: GCoin, m: Mode): number {
  const n = c.t.length;
  if (!n) return -1;
  let trig = -1;
  if (m.kind === "mig") {
    for (let i = 0; i < n && c.t[i] <= m.win * 60_000; i++) {
      if (c.done[i] === 2) {
        trig = i;
        break;
      }
    }
    if (trig < 0) return -1;
    const want = c.t[trig] + FILL_DELAY;
    for (let j = trig; j < n; j++) if (c.t[j] >= want && c.done[j] === 2) return j;
    return -1;
  }
  if (m.kind === "now") {
    trig = 0;
    // the call needs a price close to it
    if (c.t[0] > 30_000) return -1;
  } else {
    const p0 = c.prog[0];
    const px0 = c.mc[0];
    for (let i = 1; i < n && c.t[i] <= m.win * 60_000; i++) {
      if (c.done[i]) return -1;
      if (m.kind === "climb" && c.prog[i] >= p0 + m.a) {
        trig = i;
        break;
      }
      if (m.kind === "dip" && c.mc[i] <= px0 * (1 - m.a)) {
        trig = i;
        break;
      }
    }
    if (m.kind === "hold") {
      // the last price at or before 2 minutes; enter if it is above the call's
      let k = -1;
      for (let i = 0; i < n && c.t[i] <= m.win * 60_000; i++) k = i;
      if (k < 0 || c.t[k] < 60_000 || !(c.mc[k] > px0) || c.done[k]) return -1;
      trig = k;
    }
    if (trig < 0) return -1;
  }
  // fill at the first price 2+ seconds after the signal
  const want = c.t[trig] + FILL_DELAY;
  for (let j = trig; j < n; j++) if (c.t[j] >= want) return c.done[j] ? -1 : j;
  return -1;
}

/** One round trip from fill tick j under exit x: P&L in SOL (null: no usable price). */
export function tradeFrom(c: GCoin, j: number, x: GExit, sol = GRID_SOL): number | null {
  const n = c.t.length;
  const px0 = c.mc[j] / 1e9;
  if (!(px0 > 0) || c.done[j] === 1) return null;
  const inPool = c.done[j] === 2; // bought after the migration (mode "mig")
  if (inPool && x.mig === "sell") return null;
  const fillPx = px0 * (1 + slipOf(sol, inPool, c.real[j]));
  let tokens = (sol * (1 - venueFee(inPool, c.mc[j]))) / fillPx;
  const cost = sol + txCost(sol, COST) + ATA_RENT;
  let back = 0;
  let peak = px0;
  let initials = false;
  const sell = (frac: number, k: number) => {
    const amt = frac >= 1 ? tokens : tokens * frac;
    back += sellProceeds(amt, c.mc[k] / 1e9, c.done[k] === 2, c.real[k], COST, frac >= 1);
    tokens -= amt;
  };
  const tEnd = c.t[j] + x.timeMin * 60_000;
  // the regular exits end where their paths used to end (the hour on the curve, 6h through the migration), now that
  // paths run a day long (v0.1.89)
  const hardEnd = c.t[j] + holdMax(x);
  let k = j;
  for (let i = j + 1; i < n; i++) {
    const d = c.done[i];
    // past the strategy's longest hold: out at the last price before it (first, now that paths run a day)
    if (c.t[i] > hardEnd) break;
    // the migration: sell there (as before), or ride on into the pool
    if (d && x.mig === "sell") return (sell(1, d === 1 ? i : k), back - cost);
    if (d === 1) continue; // the curve's last price; the pool prices follow
    k = i;
    const px = c.mc[i] / 1e9;
    if (!(px > 0)) continue;
    if (px > peak) peak = px;
    const xr = px / fillPx;
    if (!initials && xr >= x.initials) {
      sell(firstSell(x), i);
      initials = true;
      continue;
    }
    if (xr <= 1 - x.stop) return (sell(1, i), back - cost);
    if (initials && px <= peak * (1 - x.trail)) return (sell(1, i), back - cost);
    // a runner's kept part is not timed out after its first target: only the trail, the stop or its hours end it
    if (c.t[i] >= tEnd && (!initials || (!isRunner(x) && xr < 1.1))) return (sell(1, i), back - cost);
  }
  // the path ended (the coin stopped trading, or the time ran out): sold at the last price
  if (tokens > 1e-12) sell(1, k);
  return back - cost;
}

export type GStat = { n: number; wins: number; winRate: number; avgPct: number; pnl: number; pfLessBest: number };
const r1 = (v: number) => Math.round(v * 10) / 10;

type Acc = { n: number; w: number; s: number; ss: number; gw: number; gl: number; best: number; nA: number; sA: number; nB: number; sB: number };
const acc0 = (): Acc => ({ n: 0, w: 0, s: 0, ss: 0, gw: 0, gl: 0, best: -Infinity, nA: 0, sA: 0, nB: 0, sB: 0 });
function finish(a: Acc, cost: number): GStat & { t: number; halvesUp: boolean } {
  const gw = a.best > 0 ? a.gw - a.best : a.gw;
  const pf = a.gl > 0 ? gw / a.gl : gw > 0 ? 99 : 0;
  const mean = a.n ? a.s / a.n : 0;
  const sd = a.n > 1 ? Math.sqrt(Math.max(0, a.ss / a.n - mean * mean)) : 0;
  return {
    n: a.n,
    wins: a.w,
    winRate: a.n ? r1((a.w / a.n) * 100) : 0,
    avgPct: r1((mean / cost) * 100),
    pnl: Math.round(a.s * 1e4) / 1e4,
    pfLessBest: Math.round(pf * 100) / 100,
    t: sd > 0 ? (mean / sd) * Math.sqrt(a.n) : 0,
    halvesUp: a.nA >= 10 && a.nB >= 10 && a.sA > 0 && a.sB > 0,
  };
}
export const PASS = { minN: 20, minWin: 35, minAvg: 2, minPf: 1.1 };
export const RANK = { minN: 40, minPf: 1.1 };
const passes = (s: GStat) => s.n >= PASS.minN && s.winRate >= PASS.minWin && s.avgPct >= PASS.minAvg && s.pfLessBest >= PASS.minPf;

export type GRow = {
  key: string;
  filter: string;
  filterLabel: string;
  mode: string;
  modeLabel: string;
  exit: GExit;
  exitLabel: string;
  train: GStat;
  test: GStat;
  pass: boolean;
  senders: number; // migrated coins among its trades
  explore?: boolean; // v0.1.74: best on all calls, not ranked on train/test (only GRID LIVE judges it)
  seen?: { runs: number; ranked: number; passed: number }; // across earlier runs (gridHistory)
  // v0.1.112: the checks after the test. basic = the old pass (test meets PROMOTE's bar); t = the test's t-stat; bar =
  // the NULL RUN's luck bar it must beat; plateau = neighbouring exits in profit on the test; recent = the newest third
  checks?: { basic: boolean; t: number; bar: number; plateau: { n: number; up: number; ok: boolean }; recent: { n: number; pnl: number; ok: boolean } };
};
export const keyOf = (filter: string, mode: string, x: GExit) => `${filter}|${mode}|${x.initials}/${x.trail}/${x.stop}/${x.timeMin}/${x.mig}${isRunner(x) ? `/k${x.keep ?? 0.5}h${x.hours}` : ""}`;

/**
 * What the senders looked like at their call: of every migrated coin in the sample, how many the King called and how,
 * where the curve was, how long to migrate, and which rules were most over-represented among them (lift: how many times
 * more often a sender had the rule than an average call). The rules with the biggest lift are what to hunt.
 */
export function sendersStudy(cs: GCoin[], hit: boolean[][]) {
  const N = cs.length;
  const sIdx = cs.map((c, i) => (c.bonded ? i : -1)).filter((i) => i >= 0);
  const S = sIdx.length;
  const med = (a: number[]) => {
    const b = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
    return b.length ? b[Math.floor(b.length / 2)] : null;
  };
  const verdicts: Record<string, number> = {};
  for (const i of sIdx) verdicts[cs[i].verdict] = (verdicts[cs[i].verdict] || 0) + 1;
  const base = N ? S / N : 0;
  // v0.1.112: the score rules are left out (fitted on these same calls, their lift here would be in-sample; GRID SCORE
  // reports its own lift on the newer calls only)
  const lifts = PREDS.map((p, k) => ({ p, k })).filter(({ p }) => !SCORE_RULES.has(p.id)).map(({ p, k }) => {
    let n = 0, sn = 0;
    for (let i = 0; i < N; i++) if (hit[k][i]) (n++, cs[i].bonded && sn++);
    const rate = n ? sn / n : 0;
    return { id: p.id, label: p.label, calls: n, senders: sn, rate: Math.round(rate * 1000) / 10, lift: base > 0 ? Math.round((rate / base) * 100) / 100 : 0 };
  })
    .sort((a, b) => (b.calls >= 30 ? 1 : 0) - (a.calls >= 30 ? 1 : 0) || b.lift - a.lift); // under 30 calls: listed last (too few to read)
  const fast = sIdx.filter((i) => (cs[i].bondSecs ?? Infinity) <= 3600).length;
  return {
    calls: N,
    senders: S,
    rate: Math.round(base * 1000) / 10,
    fast, // migrated within an hour of launch
    verdicts,
    medCurve: med(sIdx.map((i) => cs[i].progress)),
    medMinsToBond: (() => {
      const m = med(sIdx.map((i) => (cs[i].bondSecs != null ? (cs[i].createdAt + cs[i].bondSecs! * 1000 - cs[i].at) / 60_000 : NaN)));
      return m == null ? null : Math.round(m * 10) / 10;
    })(),
    lifts, // v0.1.101: every rule (it was the top 8: the new social rules never showed)
  };
}

/** The whole search. Coins: calls with their paths (any order). */
export async function runGrid(coins: GCoin[], opts: { top?: number; sol?: number; nulls?: number; nullHist?: number[]; fitScore?: boolean } = {}) {
  // the worker's desk shares this thread: hand it the event loop between chunks of work
  const breathe = () => new Promise<void>((res) => setImmediate(res));
  await loadLiveFees().catch(() => null); // v0.1.96: costs as live pays them
  const t0 = Date.now();
  const sol = opts.sol ?? GRID_SOL;
  const cost = sol + txCost(sol, COST) + ATA_RENT;
  const cs = coins.filter((c) => c.t.length >= 2).sort((a, b) => a.at - b.at);
  const N = cs.length;
  const cut = Math.floor(N * 0.7);
  const half = Math.floor(cut / 2);
  // every (mode, exit) outcome per coin, once: NaN = no trade
  const M = MODES.length;
  const X = GEXITS.length;
  const out: Float32Array[] = [];
  const entered = new Int32Array(M);
  for (let m = 0; m < M; m++) {
    await breathe();
    const js = cs.map((c) => entryIndex(c, MODES[m]));
    for (const j of js) if (j >= 0) entered[m]++;
    for (let x = 0; x < X; x++) {
      // v0.1.92: every exit (paths run a day now; 6 exits at a time held the worker's loop for up to 1.4s)
      await breathe();
      const a = new Float32Array(N).fill(NaN);
      if (MODES[m].kind === "mig" && GEXITS[x].mig === "sell") {
        out.push(a); // buying the migration only makes sense holding into the pool
        continue;
      }
      for (let i = 0; i < N; i++) {
        if (js[i] < 0) continue;
        const p = tradeFrom(cs[i], js[i], GEXITS[x], sol);
        if (p != null && Number.isFinite(p)) a[i] = p;
      }
      out.push(a);
    }
  }
  // v0.1.112 GRID SCORE: every rule on the menu first, the score fitted on the older 70% (train) from them, then the
  // score's own rules (top 10% / top 20%) on every call. The newer 30% never reaches the fit
  const hit: boolean[][] = new Array(PREDS.length);
  PREDS.forEach((p, k) => {
    if (!SCORE_RULES.has(p.id)) hit[k] = cs.map((c) => p.ok(c));
  });
  await breathe();
  const score = fitScore(cs, hit, cut);
  if (opts.fitScore !== false) setScoreModel(score.model);
  // v0.1.114 PROFIT SCORE: the reference trade = buy at the call, the first runner exit (the King's edge is in the right
  // tail). Target: it made money after every cost. Only calls that trade take part
  const refM = MODES.findIndex((m) => m.id === "now");
  const refX = GEXITS.findIndex((x) => isRunner(x));
  const ref = out[refM * X + refX];
  const pscore = fitScore(cs, hit, cut, Date.now(), { y: Uint8Array.from(ref, (p) => (p > 0 ? 1 : 0)), use: Uint8Array.from(ref, (p) => (p === p ? 1 : 0)), pnl: ref, cost, what: "paying trades" });
  if (opts.fitScore !== false) setProfitModel(pscore.model);
  PREDS.forEach((p, k) => {
    if (SCORE_RULES.has(p.id)) hit[k] = cs.map((c) => p.ok(c));
  });
  // filters: none, every rule, every pair of rules (as coin index lists)
  const filters: { id: string; label: string; idx: Int32Array }[] = [];
  const mk = (id: string, label: string, ok: (i: number) => boolean) => {
    const idx: number[] = [];
    for (let i = 0; i < N; i++) if (ok(i)) idx.push(i);
    if (idx.length >= 20) filters.push({ id, label, idx: Int32Array.from(idx) });
  };
  mk("all", "every call", () => true);
  for (let a = 0; a < PREDS.length; a++) mk(PREDS[a].id, PREDS[a].label, (i) => hit[a][i]);
  for (let a = 0; a < PREDS.length; a++) for (let b = a + 1; b < PREDS.length; b++) {
    // the two score bands are one idea: top 10% is inside top 20%
    if (SCORE_RULES.has(PREDS[a].id) && SCORE_RULES.has(PREDS[b].id)) continue;
    mk(`${PREDS[a].id}+${PREDS[b].id}`, `${PREDS[a].label} + ${PREDS[b].label}`, (i) => hit[a][i] && hit[b][i]);
  }

  const stat = (o: Float32Array, idx: Int32Array, from: number, to: number) => {
    const a = acc0();
    for (const i of idx) {
      if (i < from || i >= to) continue;
      const p = o[i];
      if (p !== p) continue;
      a.n++;
      a.s += p;
      a.ss += p * p;
      if (p > 0) (a.w++, (a.gw += p));
      else a.gl -= p;
      if (p > a.best) a.best = p;
      if (i < half) (a.nA++, (a.sA += p));
      else (a.nB++, (a.sB += p));
    }
    return finish(a, cost);
  };
  type Cand = { f: number; m: number; x: number; tr: ReturnType<typeof stat> };
  let tried = 0;
  /** Rank every strategy on train (outs: the outcomes; the NULL RUN passes shuffled ones). */
  const search = async (outs: Float32Array[], count: boolean) => {
    const ranked: Cand[] = [];
    let best: Cand | null = null; // the best train result of all, ranked or not (for the summary)
    for (let f = 0; f < filters.length; f++) {
      if (f % 4 === 0) await breathe();
      for (let m = 0; m < M; m++) {
        for (let x = 0; x < X; x++) {
          if (count) tried++;
          const tr = stat(outs[m * X + x], filters[f].idx, 0, cut);
          if (tr.n < RANK.minN) continue;
          if (!best || tr.t > best.tr.t) best = { f, m, x, tr };
          if (tr.avgPct > 0 && tr.pfLessBest >= RANK.minPf && tr.halvesUp) ranked.push({ f, m, x, tr });
        }
      }
    }
    ranked.sort((a, b) => b.tr.t - a.tr.t);
    return { ranked, best };
  };
  /** One per filter + timing, and once per identical set of trades (the simpler one, ranked first on a tie, is kept). */
  const pick = (ranked: Cand[]) => {
    const seen = new Set<string>();
    const out: Cand[] = [];
    for (const c of ranked) {
      const k = `${c.f}:${c.m}`;
      const same = `${c.m}:${c.tr.n}:${c.tr.pnl}:${c.tr.wins}`;
      if (seen.has(k) || seen.has(same)) continue;
      seen.add(k);
      seen.add(same);
      out.push(c);
      if (out.length >= (opts.top ?? 25)) break;
    }
    return out;
  };
  // v0.1.112 PLATEAU and NEWEST SLICE: a real edge holds when the exit moves one step, and still pays on the newest
  // third of the test on its own
  const NB = GEXITS.map((_, xi) => neighbourIdx(xi));
  const recentFrom = cut + Math.floor(((N - cut) * 2) / 3);
  const checkOf = (c: Cand, outs: Float32Array[]) => {
    const idx = filters[c.f].idx;
    const te = stat(outs[c.m * X + c.x], idx, cut, N);
    let up = 0;
    for (const nx of NB[c.x]) {
      const s = stat(outs[c.m * X + nx], idx, cut, N);
      if (s.n > 0 && s.pnl > 0) up++;
    }
    const rc = stat(outs[c.m * X + c.x], idx, recentFrom, N);
    const n = NB[c.x].length;
    return { te, basic: passes(te), t: Math.round(te.t * 100) / 100, plateau: { n, up, ok: !n || up * 2 >= n }, recent: { n: rc.n, pnl: rc.pnl, ok: rc.n >= 5 && rc.pnl > 0 } };
  };
  const fullPass = (k: ReturnType<typeof checkOf>) => k.basic && k.plateau.ok && k.recent.ok;

  // v0.1.112 NULL RUN: the same search on shuffled outcomes (each call gets another call's trades), where no rule can
  // have an edge. Whatever still passes there passed by luck. Each null run gives the best luck t-stat among its passes
  // (0: nothing passed). The bar a real pass must beat is the 95th percentile of those over the last NULL_KEEP runs, so
  // at most 1 run in 20 of pure luck would get through
  const nullStats: number[] = [];
  for (let r = 0; r < Math.max(0, opts.nulls ?? 0); r++) {
    const perm = Int32Array.from({ length: N }, (_, i) => i);
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const outsP = out.map((o) => {
      const a = new Float32Array(N);
      for (let i = 0; i < N; i++) a[i] = o[perm[i]];
      return a;
    });
    await breathe();
    const { ranked: rk } = await search(outsP, false);
    let mx = 0;
    for (const c of pick(rk)) {
      const k = checkOf(c, outsP);
      if (fullPass(k)) mx = Math.max(mx, k.t, 0.01);
    }
    nullStats.push(Math.round(mx * 100) / 100);
  }
  const nullHist = [...(opts.nullHist || []).filter((v) => Number.isFinite(v)), ...nullStats].slice(-NULL_KEEP);
  const sortedNull = [...nullHist].sort((a, b) => a - b);
  const bar = !sortedNull.length ? 0 : sortedNull.length >= 10 ? sortedNull[Math.floor(0.95 * (sortedNull.length - 1))] : sortedNull[sortedNull.length - 1];

  const { ranked, best } = await search(out, true);
  // v0.1.74: EXPLORE. When nothing ranks (13-14 Oct: 0 of 56,448), GRID LIVE sat empty and no live evidence was
  // gathered at all. Explore rows are the best strategies on ALL calls (20+ trades, positive, PF 1+ without the best):
  // not proven by the train/test split, so they never count as passed here; GRID LIVE trades them in free slots and
  // its own 30-trip exam is the judge. Idle paper books gather nothing; an exploring book gathers evidence.
  const explorePool: Cand[] = [];
  for (let f = 0; f < filters.length; f++) {
    if (f % 20 === 0) await breathe();
    for (let m = 0; m < M; m++) {
      for (let x = 0; x < X; x++) {
        const al = stat(out[m * X + x], filters[f].idx, 0, N);
        if (al.n >= 20 && al.avgPct > 0 && al.pfLessBest >= 1) explorePool.push({ f, m, x, tr: al });
      }
    }
  }
  explorePool.sort((a, b) => b.tr.t - a.tr.t);
  const toRow = (c: Cand): GRow => {
    const k = checkOf(c, out);
    const { t: _t, halvesUp: _h, ...train } = c.tr;
    const { t: _t2, halvesUp: _h2, ...test } = k.te;
    const o = out[c.m * X + c.x];
    let senders = 0;
    for (const i of filters[c.f].idx) if (o[i] === o[i] && cs[i].bonded) senders++;
    const pass = fullPass(k) && k.t > bar;
    return { key: keyOf(filters[c.f].id, MODES[c.m].id, GEXITS[c.x]), filter: filters[c.f].id, filterLabel: filters[c.f].label, mode: MODES[c.m].id, modeLabel: MODES[c.m].label, exit: GEXITS[c.x], exitLabel: exitText(GEXITS[c.x]), train, test, pass, senders, checks: { basic: k.basic, t: k.t, bar, plateau: k.plateau, recent: k.recent } };
  };
  const rows: GRow[] = pick(ranked).map(toRow);
  const explore: GRow[] = [];
  const seenX = new Set<string>(rows.map((r) => `${r.filter}:${r.mode}`));
  for (const c of explorePool) {
    const k = `${filters[c.f].id}:${MODES[c.m].id}`;
    const same = `x${c.m}:${c.tr.n}:${c.tr.pnl}:${c.tr.wins}`;
    if (seenX.has(k) || seenX.has(same)) continue;
    seenX.add(k);
    seenX.add(same);
    const tr = stat(out[c.m * X + c.x], filters[c.f].idx, 0, cut);
    const r = toRow({ ...c, tr });
    explore.push({ ...r, pass: false, explore: true });
    if (explore.length >= 16) break;
  }
  // the honest baseline: every call, each timing, its best exit on train
  const base = MODES.map((_, m) => {
    let b: Cand | null = null;
    for (let x = 0; x < X; x++) {
      const tr = stat(out[m * X + x], filters[0].idx, 0, cut);
      if (tr.n >= 20 && (!b || tr.avgPct > b.tr.avgPct)) b = { f: 0, m, x, tr };
    }
    return b ? toRow(b) : null;
  }).filter((r): r is GRow => !!r);
  const passed = rows.filter((r) => r.pass);
  return {
    at: Date.now(),
    ms: Date.now() - t0,
    sol,
    coins: N,
    trainN: cut,
    testN: N - cut,
    from: cs[0]?.at ?? null,
    split: cs[cut]?.at ?? null,
    to: cs[N - 1]?.at ?? null,
    entered: MODES.map((m, i) => ({ mode: m.id, label: m.label, n: entered[i] })),
    pooled: cs.filter((c) => c.done.includes(2)).length, // v0.1.72: coins with pool prices after their migration
    tried,
    rankable: ranked.length,
    bestTrain: best ? toRow(best) : null,
    rows,
    explore,
    base,
    passed: passed.length,
    // v0.1.112: how many would have passed on the old bar (the test alone), before the plateau, the newest slice and the luck bar
    passedBasic: rows.filter((r) => r.checks?.basic).length,
    senders: sendersStudy(cs, hit),
    rules: { rank: RANK, pass: PASS },
    score: { used: score.used, effN: score.effN, top: score.top, test: score.test, why: score.why, model: score.model },
    pscore: { ref: keyOf("all", "now", GEXITS[refX]), used: pscore.used, effN: pscore.effN, top: pscore.top, test: pscore.test, why: pscore.why, model: pscore.model },
    nullRun: { runs: nullStats.length, kept: nullHist.length, lucky: nullHist.filter((v) => v > 0).length, luckRate: nullHist.length ? Math.round((nullHist.filter((v) => v > 0).length / nullHist.length) * 1000) / 10 : null, bar, thisRun: nullStats },
    nullHist,
  };
}
/** v0.1.112: null runs kept for the luck bar (3 a GRID run, hourly: about a day and a half). */
export const NULL_KEEP = 100;
export type GridView = Awaited<ReturnType<typeof runGrid>>;

// ---- loading from the archive (worker)
const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Calls since v0.1.66 (when every call worth testing got the hour after it), with their paths. */
export async function loadGrid(pool: any, days = 14, max = 25_000): Promise<GCoin[]> {
  const since = await pool.query(`select min(opened_at) as at from trips where build >= '0.1.66'`).catch(() => ({ rows: [] }));
  const from = Math.max(Date.now() - days * 86400_000, since.rows[0]?.at ? new Date(since.rows[0].at).getTime() : 0);
  const ls = await pool.query(
    `select mint, symbol, created_at, outcome, bond_secs, data->'call' as call, data->'wire' as wire, data->'pulse' as pulse from launches
     where created_at > $1 and created_at < now() - interval '70 minutes' and data->'call' is not null
     order by created_at desc limit $2`,
    [new Date(from).toISOString(), max],
  );
  const dxh = await dxHistAll(); // v0.1.104
  // v0.1.107: each archived coin's place among the coins matched to the same post (from a day before the window on)
  const postRank = new Map<string, number>();
  const pr = await pool
    .query(`select mint, created_at, data->'wire'->>'tid' as tid from launches where created_at > $1 and data->'wire' is not null order by created_at`, [new Date(from - 86400_000).toISOString()])
    .catch(() => ({ rows: [] as any[] }));
  const perPost = new Map<string, number>();
  for (const x of pr.rows) {
    if (!x.tid) continue;
    const n = (perPost.get(x.tid) || 0) + 1;
    perPost.set(x.tid, n);
    postRank.set(x.mint, n);
  }
  const coins = new Map<string, GCoin & { pre: { t: number; p: number }[]; tk: { t: number; mc: number; r: number; p: number; d: number }[] }>();
  for (const r of ls.rows) {
    const c = typeof r.call === "string" ? JSON.parse(r.call) : r.call;
    if (!c?.at || c.farm) continue;
    const tp = c.tp || {};
    const verdict = String(c.verdict || "DUST");
    const nanoV = c.nano?.verdict;
    const worth = (Number(c.progress) || 0) >= 4 || verdict !== "DUST" || (nanoV && nanoV !== "DUST") || (c.v1v && c.v1v !== "DUST");
    if (!worth) continue; // only these got the hour after the call (digger: followLonger)
    coins.set(r.mint, {
      mint: r.mint,
      symbol: r.symbol || "",
      at: Number(c.at),
      createdAt: new Date(r.created_at).getTime(),
      verdict,
      score: Number(c.score) || 0,
      nano: num(c.nano?.score),
      progress: Number(c.progress) || 0,
      rise60: 0,
      uniq: num(tp.uniq),
      spb: num(tp.spb),
      bs: num(tp.bs),
      sn: num(tp.sn),
      sm: Number(tp.sm) || 0,
      ds: !!tp.ds,
      soc: Number(c.soc) || 0,
      pw: num(tp.pw),
      u60: num(tp.u60),
      bs60: num(tp.bs60),
      wh: num(tp.wh),
      kf: num(tp.kf),
      kmu: num(tp.kmu),
      kx: num(tp.kx),
      e20: num(tp.e20),
      sx: sxOf(c, typeof r.wire === "string" ? JSON.parse(r.wire) : r.wire, typeof r.pulse === "string" ? JSON.parse(r.pulse) : r.pulse, originHist(r.mint), dxAt(dxh[r.mint], Number(c.at)), postRank.get(r.mint) ?? null),
      image: c.image ? String(c.image) : undefined,
      name: c.name ? String(c.name) : undefined,
      bonded: r.outcome === "BONDED",
      bondSecs: num(r.bond_secs),
      t: new Int32Array(0),
      mc: new Float32Array(0),
      real: new Float32Array(0),
      prog: new Float32Array(0),
      done: new Uint8Array(0),
      pre: [],
      tk: [],
    });
  }
  const mints = [...coins.keys()];
  for (let i = 0; i < mints.length; i += 1000) {
    const part = mints.slice(i, i + 1000);
    const ts = await pool.query(`select mint, at, progress, mc_sol, real_sol, complete, pool from ticks where mint = any($1) order by mint, at`, [part]);
    for (const t of ts.rows) {
      const c = coins.get(t.mint);
      if (!c) continue;
      const at = new Date(t.at).getTime();
      const p = Number(t.progress) || 0;
      if (at < c.at - 2_000) c.pre.push({ t: at, p });
      // the curve for the hour after the call; pool prices (after the migration) for up to 6 hours
      // v0.1.89: up to a day after the call (the runner exits; the firehose archives called coins that long)
      else if (at <= c.at + RUN_MS + 30 * 60_000) c.tk.push({ t: at - c.at, mc: Number(t.mc_sol) || 0, r: Number(t.real_sol) || 0, p, d: t.pool ? 2 : t.complete ? 1 : 0 });
    }
  }
  const res: GCoin[] = [];
  for (const c of coins.values()) {
    if (c.tk.length < 2) continue;
    // curve speed: points gained since the last reading a minute or more before the call
    const old = c.pre.filter((x) => x.t <= c.at - 60_000).pop();
    c.rise60 = c.progress - (old ? old.p : 0);
    const n = c.tk.length;
    const g: GCoin = { ...c, t: new Int32Array(n), mc: new Float32Array(n), real: new Float32Array(n), prog: new Float32Array(n), done: new Uint8Array(n) };
    c.tk.forEach((x, k) => {
      g.t[k] = Math.max(0, x.t);
      g.mc[k] = x.mc;
      g.real[k] = x.r;
      g.prog[k] = x.p;
      g.done[k] = x.d;
    });
    delete (g as any).pre;
    delete (g as any).tk;
    res.push(g);
    // v0.1.109: no label yet (calls from before this build): queued for one (an image read, within the daily cap)
    if (!themeOf(g.mint) && c.image) themeQueue({ mint: g.mint, image: String(c.image), name: String(c.name || ""), symbol: g.symbol, desc: "" }, false);
    // v0.1.106: GRID's own coins are the ones that need their DexScreener history (v0.1.104/105 queued 35K-71K calls
    // at boot, ~20 to 40 hours of fetching; these are ~3.4K)
    if (!dxh[g.mint]) dxQueue(g.mint, false);
  }
  // v0.1.109: the labels, and theme heat from the labelled coins of this window (migrations in the 6 hours before)
  const bonds = res.filter((x) => x.bonded && x.bondSecs != null && themeOf(x.mint)).map((x) => ({ t: themeOf(x.mint)!.t, at: x.createdAt + Number(x.bondSecs) * 1000 }));
  for (const x of res) {
    const l = themeOf(x.mint);
    if (!l) continue;
    const th = { m: l.m, t: l.t, heat: themeHeat(l.t, x.at, bonds) };
    x.sx = x.sx ? { ...x.sx, th } : { post: null, bigpost: null, pulse: null, lens: null, xf: null, tg: null, kol: null, ftop: null, mind: null, th };
  }
  return res;
}

/** The Telegram note for a run with candidates (null: nothing passed). */
export function gridMessage(v: GridView): string | null {
  const ps = v.rows.filter((r) => r.pass);
  if (!ps.length) return null;
  const esc = (s: string) => s.replace(/[<>&]/g, " ");
  const lines = ps.slice(0, 5).map((r) => `• ${esc(r.filterLabel)}, ${esc(r.modeLabel)}\n  ${esc(r.exitLabel)}\n  test: ${r.test.n} trips, ${Math.round(r.test.winRate)}% won, avg ${r.test.avgPct >= 0 ? "+" : ""}${r.test.avgPct}%, PF ${r.test.pfLessBest}`);
  return `🧪 <b>GRID found ${ps.length} candidate${ps.length > 1 ? "s" : ""}</b>\nRanked on ${v.trainN} older calls, held up on ${v.testN} newer ones it never saw:\n\n${lines.join("\n\n")}\n\nNext: into ARENA, to prove it on live coins.`;
}

// ---- learning across runs: a strategy that holds up run after run is worth far more than one lucky run
export type GHist = { runs: number; keys: Record<string, { first: number; last: number; ranked: number; passed: number; label: string }> };
export function gridHistory(prev: GHist | null, v: GridView): GHist {
  const h: GHist = { runs: (prev?.runs ?? 0) + 1, keys: { ...(prev?.keys || {}) } };
  for (const r of v.rows) {
    const k = h.keys[r.key] || { first: h.runs, last: h.runs, ranked: 0, passed: 0, label: "" };
    k.ranked++;
    if (r.pass) k.passed++;
    k.last = h.runs;
    k.label = `${r.filterLabel}, buy ${r.modeLabel}`;
    h.keys[r.key] = k;
  }
  // forget what has not ranked in the last 20 runs (keeps the record small)
  for (const [k, x] of Object.entries(h.keys)) if (h.runs - x.last >= 20) delete h.keys[k];
  return h;
}
/** Put each row's record across runs on it. */
export function withSeen(v: GridView, h: GHist) {
  for (const r of v.rows) {
    const k = h.keys[r.key];
    if (k) r.seen = { runs: h.runs - k.first + 1, ranked: k.ranked, passed: k.passed };
  }
  return v;
}

/**
 * The strategies that go to the live GRID books (lib/gridlive.ts), best first: passed on the newest calls (most passes
 * across runs first), then those positive on the newest calls with 10+ trades, then the best on the older calls that the
 * newest could not judge yet. A strategy that lost on the newest calls never goes live. At most `max`.
 */
export function liveCandidates(v: GridView, max = 8): GRow[] {
  const cons = (r: GRow) => (r.seen?.passed ?? 0) * 2 + (r.seen?.ranked ?? 0);
  const passed = v.rows.filter((r) => r.pass).sort((a, b) => cons(b) - cons(a) || b.test.avgPct - a.test.avgPct);
  const hopeful = v.rows.filter((r) => !r.pass && r.test.n >= 10 && r.test.avgPct > 0 && r.test.pfLessBest >= 1).sort((a, b) => cons(b) - cons(a) || b.test.avgPct - a.test.avgPct);
  // free slots: the best on the older calls that the newest calls could not judge yet (under 10 test trades). Paper
  // costs nothing, and a live record is the fastest way to judge them
  const unjudged = v.rows.filter((r) => !r.pass && r.test.n < 10 && r.test.avgPct >= 0);
  // v0.1.74: then exploring strategies (best on all calls), so no slot sits idle
  const ex = (v.explore || []).filter((r) => !v.rows.some((x) => x.key === r.key));
  return [...passed, ...hopeful, ...unjudged, ...ex].slice(0, max);
}
