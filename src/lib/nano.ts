// Rat King nano: a model learned from scratch, live, on what the rats dig.
// Plain logistic regression trained one sample at a time (online SGD) the moment a launch resolves.
// No pretrained weights, no outside data. Every weight is public at /api/king/weights.

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
] as const;

export const NANO_MIN = 200; // labelled samples before nano starts making counted calls
const LR = 0.05;
const L2 = 1e-4;
const POS_WEIGHT = 8; // bonds are rare; weigh them up so the model does not just say "dies"
const EMA = 0.01;

export type NanoModel = {
  w: number[];
  n: number; // samples learned
  pos: number; // bonded samples learned
  loss: number; // EMA of log loss
  acc: number; // EMA of accuracy at 0.5
  updatedAt: number;
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
};

export function emptyModel(): NanoModel {
  return { w: NANO_FEATURES.map(() => 0), n: 0, pos: 0, loss: Math.log(2), acc: 0.5, updatedAt: 0 };
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
  ].map(r);
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function predict(m: NanoModel, x: number[]) {
  let z = 0;
  for (let i = 0; i < x.length; i++) z += (m.w[i] || 0) * x[i];
  return sigmoid(z);
}

export function nanoScore(m: NanoModel, x: number[]) {
  return Math.round(predict(m, x) * 100);
}

/** One SGD step on one resolved launch. Mutates and returns the model. */
export function learn(m: NanoModel, x: number[], bonded: boolean): NanoModel {
  if (m.w.length !== x.length) m.w = x.map((_, i) => m.w[i] || 0);
  const p = predict(m, x);
  const y = bonded ? 1 : 0;
  const wt = bonded ? POS_WEIGHT : 1;
  const g = (p - y) * wt;
  for (let i = 0; i < x.length; i++) {
    const reg = i === 0 ? 0 : L2 * m.w[i];
    m.w[i] = m.w[i] - LR * (g * x[i] + reg);
  }
  const eps = 1e-7;
  const ll = -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));
  m.loss = m.loss * (1 - EMA) + ll * EMA;
  m.acc = m.acc * (1 - EMA) + ((p >= 0.5) === bonded ? 1 : 0) * EMA;
  m.n += 1;
  if (bonded) m.pos += 1;
  m.updatedAt = Date.now();
  return m;
}
