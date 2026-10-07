// Rat King nano: a model learned from scratch, live, on what the rats dig.
// Plain logistic regression trained one sample at a time (online SGD) the moment a launch resolves.
// No pretrained weights, no outside data. Weights are admin only (/api/king/weights?full=1, or the Strategy tab).

export const NANO_FEATURES = [
  { key: "bias", label: "bias" },
  { key: "curve5", label: "curve at 5m" },
  { key: "climb", label: "curve climb since dig" },
  { key: "dev_buy", label: "dev buy (log SOL)" },
  { key: "x", label: "X linked" },
  { key: "tg", label: "Telegram linked" },
  { key: "web", label: "website linked" },
  { key: "desc", label: "real description" },
  { key: "ticker", label: "clean ticker" },
  { key: "short_name", label: "short name" },
  { key: "dev_launches", label: "dev past launches (log)" },
  { key: "dev_bond_rate", label: "dev past bond rate" },
  { key: "hour_sin", label: "UTC hour (sin)" },
  { key: "hour_cos", label: "UTC hour (cos)" },
  // v0.1.4: what the TAPE, GRAPH and META agents see (zero when the coin was not taped)
  { key: "has_tape", label: "trades read" },
  { key: "velocity", label: "trades per minute (log)" },
  { key: "uniq", label: "unique traders (log)" },
  { key: "sol_per_buy", label: "SOL per buy" },
  { key: "buy_share", label: "buy share" },
  { key: "bundle_share", label: "bundle share of SOL in" },
  { key: "snipers", label: "snipers (log)" },
  { key: "top5", label: "top 5 early buyers share" },
  { key: "dev_sold", label: "dev already sold" },
  { key: "smart", label: "smart wallets early (log)" },
  { key: "cluster", label: "dev cluster edge (log)" },
  { key: "copy", label: "copy of a recent winner" },
  { key: "dup", label: "same ticker launches (log)" },
  { key: "meta", label: "hot meta lift (log)" },
  // v0.1.4b: farms, seasons, history
  { key: "farm", label: "block-0 farm pattern" },
  { key: "instant", label: "curve % in block 0-2" },
  { key: "organic", label: "organic traders (log)" },
  { key: "wash", label: "trades per trader" },
  { key: "size_cv", label: "buy size spread" },
  { key: "sol24", label: "SOL 24h trend" },
  { key: "sol7d", label: "SOL 7d trend" },
  { key: "lrate", label: "pump.fun launch rate (log)" },
  { key: "hist", label: "replayed from history" },
  // v0.1.10: the story behind the coin (WIRE, tweet links, PULSE)
  { key: "post", label: "born from a post" },
  { key: "post_reach", label: "post author reach (log)" },
  { key: "post_link", label: "links the post itself" },
  { key: "narrative", label: "rising narrative pace (log)" },
] as const;

export const NANO_MIN = 200; // labelled samples before nano starts making counted calls

// v2 learner (v0.1.29, King v1.1). What changed and why:
//  - inputs standardized (running mean and spread per input): a 0-1 flag and a log count now move the score on the
//    same scale; before, a few large inputs decided almost everything
//  - Adam with a small rate and a hard cap per step: v1 took steps of rate 0.05 x class weight up to 50 x boost 2.5,
//    so a single bond could swing the whole model
//  - one class weight for every source (live, replay, historian), from the model's own base rate (capped at 30)
//  - non-finite inputs and steps are refused; a shorter input is padded, weights are never truncated
//  - the market-shift boost needs a real shift on the class-weighted loss, lasts 200 lessons and fires at most once a
//    day (v1 sat in boost mode almost permanently)
export const NANO_V = 2;
const LR2 = 0.01;
const STEP_CAP = 0.05;
const GRAD_CAP = 5;
const Z_CAP = 5;
const PW_CAP = 30;
const L2 = 1e-4;
const EMA = 0.01;
const B1 = 0.9;
const B2 = 0.999;
const SLOW = 0.005;
const FAST = 0.05;
const SHIFT_RATIO = 1.3;
const BOOST_LESSONS = 200;
const BOOST_X = 2;
const SHIFT_GAP_MS = 24 * 3600_000;

export type NanoModel = {
  w: number[];
  n: number; // samples learned
  pos: number; // bonded samples learned
  loss: number; // EMA of log loss
  acc: number; // EMA of accuracy at 0.5
  updatedAt: number;
  lossFast?: number; // fast EMA of the class-weighted loss
  lossW?: number; // slow EMA of the class-weighted loss
  boost?: number; // lessons left at a raised rate after a shift
  shifts?: number;
  shiftAt?: number;
  v?: number; // learner version (2 = standardized inputs + Adam)
  mu?: number[]; // running mean per input
  va?: number[]; // running variance per input
  am?: number[]; // Adam first moment
  av?: number[]; // Adam second moment
  t?: number; // Adam steps
};

export type FeatureInput = {
  curve5: number;
  curve0: number;
  devBuySol: number;
  twitter: boolean;
  telegram: boolean;
  website: boolean;
  description: string;
  symbol: string;
  name: string;
  devN: number;
  devB: number;
  createdAt: number;
  tape?: { vel: number; uniq: number; solPerBuy: number; buyShare: number; bundleShare: number; sniperN: number; top5: number; devSold: number; instant?: number; organic?: number; wash?: number; sizeCv?: number; farm?: { farm: boolean } } | null;
  rg?: { sol24: number | null; sol7d: number | null; lrate: number | null } | null;
  hist?: boolean;
  smartN?: number;
  clRatio?: number;
  copy?: boolean;
  dup?: number;
  lift?: number;
  post?: { score: number; f: number; link: boolean } | null;
  pulseX?: number;
};

export function emptyModel(d: number = NANO_FEATURES.length): NanoModel {
  const z = () => Array.from({ length: d }, () => 0);
  return { w: z(), n: 0, pos: 0, loss: Math.log(2), acc: 0.5, updatedAt: 0, v: NANO_V, mu: z(), va: Array.from({ length: d }, () => 1), am: z(), av: z(), t: 0, lossW: Math.log(2), lossFast: Math.log(2), boost: 0, shifts: 0 };
}

const fin = (v: number) => (Number.isFinite(v) ? v : 0);
/** Make the model's arrays at least d long (new inputs start neutral); never shortens anything. */
function fit(m: NanoModel, d: number) {
  const grow = (a: number[] | undefined, fill: number) => {
    const out = Array.isArray(a) ? a.slice() : [];
    while (out.length < d) out.push(fill);
    return out;
  };
  m.w = grow(m.w, 0);
  m.mu = grow(m.mu, 0);
  m.va = grow(m.va, 1);
  m.am = grow(m.am, 0);
  m.av = grow(m.av, 0);
}
/** Standardized input i (the bias stays 1). */
function zOf(m: NanoModel, x: number[], i: number) {
  if (i === 0) return 1;
  const v = fin(x[i] ?? 0);
  if (m.v !== NANO_V) return v;
  const z = (v - (m.mu?.[i] ?? 0)) / Math.sqrt((m.va?.[i] ?? 1) + 1e-6);
  return Math.max(-Z_CAP, Math.min(Z_CAP, z));
}

export function features(i: FeatureInput): number[] {
  const h = new Date(i.createdAt).getUTCHours();
  const ang = (2 * Math.PI * h) / 24;
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return [
    1,
    Math.max(0, i.curve5) / 100,
    Math.max(0, i.curve5 - i.curve0) / 100,
    Math.log1p(Math.max(0, i.devBuySol)) / 2,
    i.twitter ? 1 : 0,
    i.telegram ? 1 : 0,
    i.website ? 1 : 0,
    (i.description || "").trim().length >= 40 ? 1 : 0,
    /^[A-Za-z0-9]{2,8}$/.test(i.symbol || "") ? 1 : 0,
    i.name && i.name.length <= 24 ? 1 : 0,
    Math.log1p(Math.max(0, i.devN)) / 5,
    i.devN > 0 ? Math.min(1, i.devB / i.devN) : 0,
    Math.sin(ang),
    Math.cos(ang),
    i.tape ? 1 : 0,
    i.tape ? Math.log1p(Math.max(0, i.tape.vel)) / 5 : 0,
    i.tape ? Math.log1p(i.tape.uniq) / 5 : 0,
    i.tape ? Math.min(5, i.tape.solPerBuy) / 5 : 0,
    i.tape ? i.tape.buyShare : 0,
    i.tape ? Math.min(1, i.tape.bundleShare) : 0,
    i.tape ? Math.log1p(i.tape.sniperN) / 3 : 0,
    i.tape ? i.tape.top5 : 0,
    i.tape && i.tape.devSold > 0 ? 1 : 0,
    Math.log1p(i.smartN || 0) / 2,
    i.clRatio ? Math.max(-1, Math.min(1, Math.log(Math.max(0.05, i.clRatio)) / 3)) : 0,
    i.copy ? 1 : 0,
    Math.log1p(Math.max(0, (i.dup || 1) - 1)) / 4,
    Math.min(1, Math.log(Math.max(1, i.lift || 1)) / 3),
    i.tape?.farm?.farm ? 1 : 0,
    i.tape?.instant != null ? Math.min(100, i.tape.instant) / 100 : 0,
    i.tape?.organic != null ? Math.log1p(i.tape.organic) / 4 : 0,
    i.tape?.wash != null ? Math.min(6, i.tape.wash) / 6 : 0,
    i.tape?.sizeCv != null ? Math.min(2, i.tape.sizeCv) / 2 : 0,
    i.rg?.sol24 != null ? Math.max(-1, Math.min(1, i.rg.sol24 / 20)) : 0,
    i.rg?.sol7d != null ? Math.max(-1, Math.min(1, i.rg.sol7d / 40)) : 0,
    i.rg?.lrate != null ? Math.log1p(i.rg.lrate) / 9 : 0,
    i.hist ? 1 : 0,
    i.post ? i.post.score : 0,
    i.post ? Math.log10(1 + Math.max(0, i.post.f)) / 7 : 0,
    i.post?.link ? 1 : 0,
    i.pulseX ? Math.log1p(i.pulseX) / 3 : 0,
  ].map(r);
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function predict(m: NanoModel, x: number[]) {
  let z = 0;
  const d = Math.max(x.length, m.w.length);
  for (let i = 0; i < d; i++) z += fin(m.w[i] || 0) * zOf(m, x, i);
  return sigmoid(z);
}

export function nanoScore(m: NanoModel, x: number[]) {
  return Math.round(predict(m, x) * 100);
}

/**
 * One lesson. `posWeight` is kept in the signature for old callers and ignored: v2 uses one class weight for every
 * source. A model from the v1 learner is started over (its weights were on raw inputs and do not carry over); the
 * nano models are migrated once at boot with a warm start (lib/digger.ts migrateNano).
 */
export function learn(m: NanoModel, x0: number[], bonded: boolean, _posWeight?: number, sampleWeight = 1, replay = false): NanoModel {
  if (m.v !== NANO_V) Object.assign(m, emptyModel(Math.max(x0.length, m.w?.length || 0)));
  const x = x0.map(fin);
  const d = Math.max(x.length, m.w.length);
  fit(m, d);
  const p = predict(m, x);
  const y = bonded ? 1 : 0;
  const pi = (m.pos + 1) / (m.n + 2);
  const pw = bonded ? Math.max(1, Math.min(PW_CAP, (1 - pi) / pi)) : 1;
  const wt = pw * Math.max(0, fin(sampleWeight));
  // running input stats (new lessons only): fast at first, then a slow 0.1% drift so the scale follows the market
  if (!replay) {
    const a = Math.max(1 / (m.n + 2), 0.001);
    for (let i = 1; i < d; i++) {
      const dlt = x[i] - m.mu![i];
      m.mu![i] += a * dlt;
      m.va![i] = Math.max(1e-4, (1 - a) * (m.va![i] + a * dlt * dlt));
    }
  }
  const lr = LR2 * (m.boost && m.boost > 0 ? BOOST_X : 1);
  const t = (m.t || 0) + 1;
  const nw = m.w.slice();
  const nm = m.am!.slice();
  const nv = m.av!.slice();
  for (let i = 0; i < d; i++) {
    const zi = zOf(m, x, i);
    let g = (p - y) * wt * zi + (i === 0 ? 0 : L2 * m.w[i]);
    g = Math.max(-GRAD_CAP, Math.min(GRAD_CAP, g));
    nm[i] = B1 * nm[i] + (1 - B1) * g;
    nv[i] = B2 * nv[i] + (1 - B2) * g * g;
    const mh = nm[i] / (1 - Math.pow(B1, t));
    const vh = nv[i] / (1 - Math.pow(B2, t));
    const step = Math.max(-STEP_CAP, Math.min(STEP_CAP, (lr * mh) / (Math.sqrt(vh) + 1e-8)));
    nw[i] = m.w[i] - step;
  }
  if (!nw.every(Number.isFinite) || !nm.every(Number.isFinite) || !nv.every(Number.isFinite)) return m; // refuse a broken step
  m.w = nw;
  m.am = nm;
  m.av = nv;
  m.t = t;
  if (replay) return m; // replays sharpen the weights; they are not new lessons
  const eps = 1e-7;
  const ll = -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));
  m.loss = m.loss * (1 - EMA) + ll * EMA;
  const llw = Math.min(10, ll * pw);
  m.lossW = (m.lossW ?? llw) * (1 - SLOW) + llw * SLOW;
  m.lossFast = (m.lossFast ?? llw) * (1 - FAST) + llw * FAST;
  if (m.boost && m.boost > 0) m.boost--;
  else if (m.n > 1000 && m.lossFast > (m.lossW ?? m.lossFast) * SHIFT_RATIO && Date.now() - (m.shiftAt || 0) > SHIFT_GAP_MS) {
    m.boost = BOOST_LESSONS;
    m.shifts = (m.shifts || 0) + 1;
    m.shiftAt = Date.now();
  }
  m.acc = m.acc * (1 - EMA) + ((p >= 0.5) === bonded ? 1 : 0) * EMA;
  m.n += 1;
  if (bonded) m.pos += 1;
  m.updatedAt = Date.now();
  return m;
}

/** What pushed one nano score: each feature's pull on the logit (w x), strongest first. For the scorecard. */
export function contributions(m: NanoModel, x: number[], n = 8): [string, number][] {
  return x
    .map((_, i) => [NANO_FEATURES[i]?.label || `f${i}`, Math.round((m.w[i] || 0) * zOf(m, x, i) * 100) / 100] as [string, number])
    .filter(([l, c], i) => i > 0 && c !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, n);
}
