// v0.1.120 TICK MODEL: learn from every moment of every coin, not from 3,000 King calls.
//
// GRID learns from ~3K calls in 14 days, a few dozen trades per strategy: days to tell an edge from luck, and the one
// that passed on 17 Oct (45 trips) was gone hours later. The firehose sees every trade of every live coin. Every 20
// seconds TICK reads every coin trading on its curve (its last 30s / 1 / 3 minutes, buyers, buy share, whales, proven
// wallets, KOL flow, the first 20 buyers, the dev, its age, origin, DexScreener, TikTok / Instagram) and predicts its
// log return over the next 2, 5 and 15 minutes. When the horizon has passed it grades the prediction against what the
// price did and learns from it (online gradient descent, the newest moments count most: it follows the regime).
// Hundreds of thousands of graded predictions a day instead of a few hundred calls.
//
// Honest by construction: every prediction is graded BEFORE the model learns from it (prequential), so its record
// (correlation with what happened, and the result of acting on it after costs) is out of sample. A prediction is only
// worth a trade when it beats that coin's round-trip cost at the desk's size (venue fees both ways, slippage on its
// curve, the fixed transaction costs). TICK books trade those on paper in GRID LIVE; the desk follows only through the
// exams, sized by its record and, from this build on, by how strong the prediction is.
import { redis } from "./redis";
import { GRID_SOL } from "./grid";
import { roundTripCost, type CostCfg } from "./costs";

export const HORIZONS = [2, 5, 15]; // minutes
const EVERY_MS = 20_000;
const MODEL_KEY = "rn:tick:model";
const VIEW_KEY = "rn:tick:view";
const COST: CostCfg = { paperPrioritySol: 0.0005 };
export const TICK_WARM = () => Math.max(1000, Number(process.env.TICK_WARM ?? 20000) || 20000);

/** What the worker knows about a coin right now (firehose, origin, DexScreener, TREND). Unknown: null. */
export type TickExtra = { u60: number | null; bs60: number | null; wh: number | null; pw: number | null; n60: number | null; kf: number | null; kx: number | null; e20: number | null; ds: boolean; og: { rank: number; cr: number } | null; dx: { paid: 0 | 1 | null } | null; tr: { tt: 0 | 1; ig: 0 | 1 } | null };
export const FEATURES = ["r30", "r60", "r180", "curve", "age", "buyers60", "buyShare60", "whales60", "proven", "trades60", "kols", "kolsOut", "first20Out", "devSold", "firstOfName", "creatorLaunches", "dexPaid", "social", "r60xBuyShare", "r60xAge", "fromHigh", "mcap"] as const;
const D = FEATURES.length + 1; // + the bias

type Pt = { t: number; px: number; p: number; real: number; mc: number; done: boolean };
type Coin = { at: number; sym: string; name: string; h: Pt[]; hi: number };
const COINS = new Map<string, Coin>();
type Pend = { mint: string; t: number; px: number; x: Float64Array; h: number; cost: number };
// one queue per horizon, in time order: the oldest is always due first
const PEND = new Map<number, Pend[]>(HORIZONS.map((h) => [h, []]));
const pendN = () => [...PEND.values()].reduce((a, q) => a + q.length, 0);

/** One model per horizon: weights, an online normaliser, and its out-of-sample record. */
type Model = { w: number[]; mu: number[]; va: number[]; n: number; ic: { sx: number; sy: number; sxx: number; syy: number; sxy: number; n: number }; act: { n: number; sum: number; wins: number }; top: { n: number; sum: number } };
const fresh = (): Model => ({ w: new Array(D).fill(0), mu: new Array(D - 1).fill(0), va: new Array(D - 1).fill(1), n: 0, ic: { sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, n: 0 }, act: { n: 0, sum: 0, wins: 0 }, top: { n: 0, sum: 0 } });
let MODELS: Record<number, Model> = Object.fromEntries(HORIZONS.map((h) => [h, fresh()]));
export const tickStats = { coins: 0, sampled: 0, graded: 0, pending: 0, signals: 0, lastAt: 0 };

// ---------------------------------------------------------------- the coins (firehose)
export function tickCreate(mint: string, at: number, sym = "", name = "") {
  if (!mint || COINS.has(mint)) return;
  if (COINS.size > 12_000) for (const [m, c] of COINS) if (!c.h.length || Date.now() - c.h[c.h.length - 1].t > 15 * 60_000) COINS.delete(m);
  COINS.set(mint, { at, sym: sym.slice(0, 16), name: name.slice(0, 64), h: [], hi: 0 });
}
/** Every curve update (worker: the firehose). One point per 5s, the last 10 minutes. */
export function tickCurve(mint: string, v: { progress: number; mcapSol: number; realSol: number; complete?: boolean }, now = Date.now()) {
  const c = COINS.get(mint);
  if (!c || !(v.mcapSol > 0)) return;
  const pt: Pt = { t: now, px: v.mcapSol, p: v.progress, real: v.realSol, mc: v.mcapSol, done: !!v.complete };
  const last = c.h[c.h.length - 1];
  if (last && now - last.t < 5_000) c.h[c.h.length - 1] = pt;
  else c.h.push(pt);
  while (c.h.length && now - c.h[0].t > 10 * 60_000) c.h.shift();
  c.hi = Math.max(...c.h.map((x) => x.px));
}
const pxAgo = (h: Pt[], now: number, ms: number) => {
  let x: Pt | null = null;
  for (const e of h) if (e.t <= now - ms) x = e;
  return x ?? h[0] ?? null;
};
const lr = (a: number, b: number) => (a > 0 && b > 0 ? Math.log(a / b) : 0);
const cap = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The feature vector of a coin right now (raw, before the normaliser). */
export function featuresOf(c: Coin, now: number, x: TickExtra): Float64Array {
  const last = c.h[c.h.length - 1];
  const r30 = lr(last.px, pxAgo(c.h, now, 30_000)?.px ?? last.px);
  const r60 = lr(last.px, pxAgo(c.h, now, 60_000)?.px ?? last.px);
  const r180 = lr(last.px, pxAgo(c.h, now, 180_000)?.px ?? last.px);
  const ageMin = Math.max(0, (now - c.at) / 60_000);
  const bs = x.bs60 ?? 0.5;
  const f = [
    cap(r30, -2, 2), cap(r60, -2, 2), cap(r180, -2, 2), last.p / 100, Math.log1p(ageMin), Math.log1p(x.u60 ?? 0), bs, Math.min(5, x.wh ?? 0), Math.min(5, x.pw ?? 0), Math.log1p(x.n60 ?? 0),
    Math.min(5, x.kf ?? 0), Math.min(5, x.kx ?? 0), x.e20 ?? 0.3, x.ds ? 1 : 0, x.og?.rank === 1 ? 1 : 0, Math.log1p(x.og?.cr ?? 0), x.dx?.paid === 1 ? 1 : 0, x.tr && (x.tr.tt === 1 || x.tr.ig === 1) ? 1 : 0,
    cap(r60, -2, 2) * (bs - 0.5), cap(r60, -2, 2) * Math.log1p(ageMin), c.hi > 0 ? lr(last.px, c.hi) : 0, Math.log(Math.max(1, last.mc)),
  ];
  return Float64Array.from(f);
}

// ---------------------------------------------------------------- the model (online linear regression, SGD)
const LR = () => Number(process.env.TICK_LR ?? 0.003) || 0.003;
const L2 = 1e-5;
const DECAY = 1e-4; // the normaliser forgets slowly (a regime shift moves the means)
function norm(m: Model, x: Float64Array, learn: boolean) {
  const z = new Float64Array(D);
  for (let k = 0; k < D - 1; k++) {
    if (learn) {
      const a = m.n < 1000 ? 1 / (m.n + 1) : DECAY;
      const d = x[k] - m.mu[k];
      m.mu[k] += a * d;
      m.va[k] = (1 - a) * m.va[k] + a * d * d;
    }
    z[k] = cap((x[k] - m.mu[k]) / Math.sqrt(m.va[k] + 1e-9), -6, 6);
  }
  z[D - 1] = 1;
  return z;
}
export function predict(m: Model, x: Float64Array) {
  const z = norm(m, x, false);
  let s = 0;
  for (let k = 0; k < D; k++) s += m.w[k] * z[k];
  return s;
}
/** Grade a prediction against what happened, then learn from it. */
export function learn(m: Model, x: Float64Array, y: number, cost: number) {
  const yc = cap(y, -1.5, 1.5);
  const p = predict(m, x); // before the update: out of sample
  const ic = m.ic;
  ic.n++, (ic.sx += p), (ic.sy += yc), (ic.sxx += p * p), (ic.syy += yc * yc), (ic.sxy += p * yc);
  if (ic.n > 50_000) for (const k of ["sx", "sy", "sxx", "syy", "sxy", "n"] as const) ic[k] *= 0.5; // the record follows the regime too
  if (m.n >= TICK_WARM() && p > cost) {
    m.act.n++;
    m.act.sum += yc - cost;
    if (yc > cost) m.act.wins++;
    if (m.act.n > 20_000) (m.act.n *= 0.5), (m.act.sum *= 0.5), (m.act.wins *= 0.5);
  }
  const z = norm(m, x, true);
  let s = 0;
  for (let k = 0; k < D; k++) s += m.w[k] * z[k];
  const g = s - yc;
  const rate = LR() / (1 + m.n / 2_000_000);
  for (let k = 0; k < D; k++) m.w[k] -= rate * (g * z[k] + (k < D - 1 ? L2 * m.w[k] : 0));
  m.n++;
  return p;
}
export function icOf(m: Model) {
  const { n, sx, sy, sxx, syy, sxy } = m.ic;
  if (n < 100) return null;
  const cov = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) ** 2;
  const vy = syy / n - (sy / n) ** 2;
  return vx > 0 && vy > 0 ? Math.round((cov / Math.sqrt(vx * vy)) * 1000) / 1000 : null;
}
export const tickReady = (h: number) => (MODELS[h]?.n ?? 0) >= TICK_WARM();
// v0.1.122: a horizon trades only while acting on it has paid after costs, graded out of sample. On 18 Oct every
// horizon lost 5 to 7% a trade on 16K+ acted predictions, and its books filled 1,348 paper trips in 16 hours. The model
// keeps learning and keeps grading what acting would have done, so a horizon comes back by itself once it pays
export const TICK_ACT_MIN = () => Math.max(100, Number(process.env.TICK_ACT_MIN ?? 2000) || 2000);
export const tickActs = (h: number) => {
  const a = MODELS[h]?.act;
  return !a || a.n < TICK_ACT_MIN() || a.sum / a.n > 0;
};

/** The round-trip cost of a trade of the desk's size on this coin now, as a log return. */
export const costOf = (pt: Pt, sol = GRID_SOL) => Math.log1p(roundTripCost(sol, pt.done, pt.real, pt.mc, COST));

// ---------------------------------------------------------------- the loop (worker, every 20s)
let lastRun = 0;
/**
 * Grade the predictions whose horizon has passed, learn, then sample every coin trading on its curve and predict.
 * Returns the signals: coins whose predicted return beats their cost (per horizon), for the TICK books.
 */
export function tickRun(extraOf: (mint: string, now: number, name: string, sym: string) => TickExtra | null, now = Date.now()) {
  const sig: { mint: string; sym: string; h: number; ev: number; cost: number }[] = [];
  if (now - lastRun < EVERY_MS) return sig;
  lastRun = now;
  // 1. grade
  for (const q of PEND.values()) {
    let k = 0;
    while (k < q.length && now - q[k].t >= q[k].h * 60_000) k++;
    for (const p of q.splice(0, k)) gradeOne(p);
  }
  function gradeOne(p: Pend) {
    const c = COINS.get(p.mint);
    const last = c?.h[c.h.length - 1];
    // a coin nobody traded since is still worth its last price on its curve (sellable there)
    const px = last ? last.px : p.px;
    learn(MODELS[p.h], p.x, lr(px, p.px), p.cost);
    tickStats.graded++;
  }
  // 2. sample and predict
  let n = 0;
  for (const [mint, c] of COINS) {
    const last = c.h[c.h.length - 1];
    if (!last || last.done || now - last.t > 60_000 || last.p < 1 || last.p > 97 || now - c.at > 6 * 3600_000) continue;
    const ex = extraOf(mint, now, c.name, c.sym);
    if (!ex) continue;
    const x = featuresOf(c, now, ex);
    const cost = costOf(last);
    for (const h of HORIZONS) {
      const q = PEND.get(h)!;
      if (q.length < 60_000) q.push({ mint, t: now, px: last.px, x, h, cost });
      if (tickReady(h) && tickActs(h)) {
        const ev = predict(MODELS[h], x) - cost;
        if (ev >= 0.001) sig.push({ mint, sym: c.sym, h, ev: Math.round(ev * 1000) / 1000, cost: Math.round(cost * 1000) / 1000 });
      }
    }
    n++;
  }
  tickStats.sampled += n;
  tickStats.coins = n;
  tickStats.pending = pendN();
  tickStats.signals += sig.length;
  tickStats.lastAt = now;
  return sig;
}

/** What the model learned and how it does (review, /api/desk/tick). */
export function tickView() {
  return {
    at: Date.now(),
    stats: { ...tickStats },
    warm: TICK_WARM(),
    models: HORIZONS.map((h) => {
      const m = MODELS[h];
      return {
        h,
        n: m.n,
        ready: tickReady(h),
        ic: icOf(m),
        act: { n: Math.round(m.act.n), avgPct: m.act.n ? Math.round((Math.exp(m.act.sum / m.act.n) - 1) * 1000) / 10 : null, winRate: m.act.n ? Math.round((m.act.wins / m.act.n) * 100) : null },
        // the features doing the most, signed: + = more of it, higher return (momentum on r60 if +, reversal if -)
        top: FEATURES.map((f, i) => ({ f, w: Math.round(m.w[i] * 10_000) / 10_000 })).sort((a, z) => Math.abs(z.w) - Math.abs(a.w)).slice(0, 8),
      };
    }),
  };
}
/** Worker, every 5 minutes: the models and the view to Redis. */
export async function tickSave() {
  const r = redis();
  await r.set(MODEL_KEY, { v: 1, f: FEATURES.length, models: MODELS }).catch(() => null);
  await r.set(VIEW_KEY, tickView(), { ex: 86400 }).catch(() => null);
}
/** Worker boot: the models learned so far (a deploy does not start them over). */
export async function tickLoad() {
  const x: any = await redis().get(MODEL_KEY).catch(() => null);
  if (x?.v === 1 && x.f === FEATURES.length && x.models) for (const h of HORIZONS) if (x.models[h]?.w?.length === D) MODELS[h] = x.models[h];
  return HORIZONS.map((h) => MODELS[h].n);
}

/** Tests only. */
export function _tickReset() {
  COINS.clear();
  for (const q of PEND.values()) q.length = 0;
  MODELS = Object.fromEntries(HORIZONS.map((h) => [h, fresh()]));
  lastRun = 0;
  Object.assign(tickStats, { coins: 0, sampled: 0, graded: 0, pending: 0, signals: 0, lastAt: 0 });
}
export const _models = () => MODELS;
