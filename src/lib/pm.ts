// PM: the portfolio manager. The desk runs several strategies side by side, each with its own sleeve and record:
//   king  - BOND calls at minute 5 (and pullback entries on them)
//   early - minute-1 reads, once the early record earns them
//   wire  - coins born from posts by tracked X accounts (WIRE)
//   vamp  - a later copy on a hot post that out-pulls the first pick (WIRE vamp watch)
//   momo  - migrated coins pulling real volume right now (MOMO)
//   mind  - coins MIND (the trader's mind) calls SEND, once its own record has earned it (any age, curve or migrated)
// PM sizes each sleeve by how well it has been doing for the risk it takes (mean over spread of its last 30 trades),
// and pauses a sleeve for 2 hours after a bad run. More strategies that earn in different moments = a smoother curve.
import { redis } from "./redis";

export type Sleeve = "king" | "early" | "wire" | "vamp" | "momo" | "mind";
export const SLEEVES: Sleeve[] = ["king", "early", "wire", "vamp", "momo", "mind"];
const KEY = "rn:desk:pm";
const PRIOR: Record<Sleeve, number> = { king: 1, early: 0.7, wire: 0.8, vamp: 0.5, momo: 0.8, mind: 0.6 }; // weight before a sleeve has a record
const MIN_N = 6; // trades before the record moves the weight
const PAUSE_MS = 2 * 3600_000;

type S = { r: number[]; pausedUntil: number; n: number; wins: number; g?: number[] };
type PM = Record<Sleeve, S>;

export const sleeveOf = (how?: string, vamp?: boolean): Sleeve => (how === "early" ? "early" : how === "wire" ? (vamp ? "vamp" : "wire") : how === "mind" ? "mind" : how === "momo" ? "momo" : "king");

const empty = (): S => ({ r: [], pausedUntil: 0, n: 0, wins: 0 });
async function load(): Promise<PM> {
  const x = ((await redis().get<PM>(KEY)) || {}) as Partial<PM>;
  return { king: { ...empty(), ...(x.king || {}) }, early: { ...empty(), ...(x.early || {}) }, wire: { ...empty(), ...(x.wire || {}) }, vamp: { ...empty(), ...(x.vamp || {}) }, momo: { ...empty(), ...(x.momo || {}) }, mind: { ...empty(), ...(x.mind || {}) } };
}

function stats(s: S) {
  const r = s.r;
  const n = r.length;
  const mean = n ? r.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd };
}

export function weightOf(sl: Sleeve, s: S) {
  const { n, mean, sd } = stats(s);
  if (n < MIN_N) return PRIOR[sl];
  // risk-adjusted: average log return per unit of spread, shrunk toward the prior while the record is short
  const edge = mean / (sd + 0.25);
  const k = Math.min(1, n / 30);
  const raw = 1 + 1.5 * edge;
  return Math.round(Math.max(0.25, Math.min(2, PRIOR[sl] * (1 - k) + raw * k)) * 100) / 100;
}

/** Size multiplier for a sleeve right now (0 while paused). */
export async function sleeveWeight(sl: Sleeve) {
  const pm = await load();
  const s = pm[sl];
  if (s.pausedUntil > Date.now()) return { w: 0, paused: true, until: s.pausedUntil };
  return { w: weightOf(sl, s), paused: false, until: 0 };
}

/** A trade in a sleeve closed: log return log(back / cost). Returns a line for the log when something changed. */
export async function onClose(sl: Sleeve, logRet: number): Promise<string | null> {
  const pm = await load();
  const s = pm[sl];
  const before = weightOf(sl, s);
  s.r = [...s.r, Math.max(-3, Math.min(3, logRet))].slice(-30);
  s.n++;
  if (logRet > 0) s.wins++;
  let note: string | null = null;
  // brake: the last 6 trades of the sleeve lost more than 60% of one position's stake in total
  const last = s.r.slice(-6);
  if (last.length >= 6 && last.reduce((a, b) => a + b, 0) < Math.log(0.4) && s.pausedUntil < Date.now()) {
    s.pausedUntil = Date.now() + PAUSE_MS;
    note = `${sl} sleeve paused for 2 hours after a bad run (last 6 trades ${Math.round((Math.exp(last.reduce((a, b) => a + b, 0)) - 1) * 100)}%)`;
  }
  const after = weightOf(sl, s);
  if (!note && Math.abs(after - before) >= 0.1) note = `${sl} sleeve weight ${before} → ${after} (${s.r.length} trades on record)`;
  await redis().set(KEY, pm);
  return note;
}

/** Ghost desk result for a sleeve. A paused sleeve whose ghost trades keep winning is let back in early. */
export async function onGhost(sl: Sleeve, logRet: number): Promise<string | null> {
  const pm = await load();
  const s = pm[sl];
  s.g = [...(s.g || []), Math.max(-3, Math.min(3, logRet))].slice(-8);
  let note: string | null = null;
  const last = s.g.slice(-4);
  if (s.pausedUntil > Date.now() && last.length >= 4 && last.reduce((a, b) => a + b, 0) > 0) {
    s.pausedUntil = 0;
    note = `${sl} sleeve back on early: its last 4 ghost trades made money while it was paused`;
  }
  await redis().set(KEY, pm);
  return note;
}

export async function pmView() {
  const pm = await load();
  const now = Date.now();
  return SLEEVES.map((sl) => {
    const s = pm[sl];
    const { n, mean } = stats(s);
    const g = s.g || [];
    return { ghost: g.length, ghostAvg: g.length ? Math.round((Math.exp(g.reduce((a, b) => a + b, 0) / g.length) - 1) * 1000) / 10 : null, sleeve: sl, trades: s.n, wins: s.wins, winRate: s.n ? Math.round((s.wins / s.n) * 1000) / 10 : null, avg: n ? Math.round((Math.exp(mean) - 1) * 1000) / 10 : null, w: weightOf(sl, s), paused: s.pausedUntil > now ? s.pausedUntil : null };
  });
}

// ---------------------------------------------------------------- exit profiles per sleeve
// How each strategy's coins actually move while held: how high they peak and how fast. Tweet coins and vamps often
// dump right after the first push; King calls can run for hours. Once a sleeve has 12+ closed trades (real or ghost),
// its initials sit at 80% of its typical peak (never above the desk's own setting) and, when its coins peak fast,
// its time stop shortens. Learned from the trades, not set by hand.
const PX = "rn:desk:pmx";
type Prof = { pk: number[]; ttp: number[] };
export type ExitProfile = { n: number; medPk: number; medTtp: number; initials: number | null; timeStop: number | null };
const med = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

export async function noteExit(sl: Sleeve, peakMult: number, ttpMin: number) {
  const r = redis();
  const cur = ((await r.hget<Prof>(PX, sl)) || { pk: [], ttp: [] }) as Prof;
  cur.pk = [...cur.pk, Math.round(Math.max(0.01, peakMult) * 100) / 100].slice(-30);
  cur.ttp = [...cur.ttp, Math.round(Math.max(0, ttpMin) * 10) / 10].slice(-30);
  await r.hset(PX, { [sl]: cur });
}

export async function exitProfiles(initialsAt: number, timeStop: number): Promise<Record<string, ExitProfile>> {
  const all = ((await redis().hgetall<Record<string, Prof>>(PX)) || {}) as Record<string, Prof>;
  const out: Record<string, ExitProfile> = {};
  for (const [sl, p] of Object.entries(all)) {
    const n = p.pk.length;
    const medPk = med(p.pk);
    const medTtp = med(p.ttp);
    out[sl] = {
      n,
      medPk,
      medTtp,
      initials: n >= 12 ? Math.max(30, Math.min(initialsAt, Math.round((medPk - 1) * 100 * 0.8))) : null,
      timeStop: n >= 12 && medTtp < 15 ? Math.max(8, Math.min(timeStop, Math.round(medTtp * 2.5))) : null,
    };
  }
  return out;
}
