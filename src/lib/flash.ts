// FLASH (25th agent): the first-seconds read.
//
// The King calls at minute 5 and SCOUT reads at minute 1. That is late for the coins that matter most: the fast
// migrators fill their curve in seconds to a few minutes, and by minute 5 the price is already a multiple of where it
// started. FLASH reads every launch from the live trade stream at 15, 45 and 90 seconds (no chain reads at all: the
// worker hands it the trades it already streams) and asks the King's question early: will it bond within the hour?
//
// What it sees at each look: how far the curve is, how many wallets bought and sold, net SOL in, the dev's buy and
// whether the dev already sold, how much of the buying came in the first two seconds (snipers and bundles), how
// concentrated it is, the pace of the last ten seconds, plus what the rats know of the dev, the socials and the post
// it came from.
//
// Every look is scored *before* it is labelled (an honest record per look time and per score band) and labelled an
// hour after launch by what the chain says. One model learns all three look times (it knows which one it is looking
// at). FLASH trades nothing until its own record earns it: a look time trades only once a score band in it has 30+
// looks and a hit rate of 10%+ and 5x the base rate. Earlier looks are cheaper but noisier; the record decides which
// look time is worth acting on, nobody picks it by hand.
import { K, redis } from "./redis";
import { agentLog } from "./agents";
import { getSettings } from "./settings";
import type { Launch } from "./digger";

export const FL_STAGES = [15, 45, 90] as const;
export type FlStage = (typeof FL_STAGES)[number];
export const FL_FEATURES = [
  "bias", "s45", "s90", "prog", "log_mc", "log_buys", "log_sells", "log_uniq", "net_sol", "buy_share",
  "dev_sol", "dev_sold", "log_big", "first2s_share", "top3_share", "log_rate10",
  "log_dev_n", "dev_rate", "socials", "post", "fast_post", "narrative",
] as const;
const D = FL_FEATURES.length;
const W = "rn:fl:w";
const SNAP = "rn:fl:s"; // `${mint}:${stage}` -> Snap
const DUE = "rn:fl:due"; // id -> when its label is due (launch + 60 minutes)
const REC = "rn:fl:rec"; // s{stage}:p{band}:n / :hit, s{stage}:all:n / :hit
const VIEW = "rn:fl:view";
const HIST = "rn:fl:hist";
export const FL_SIG = (m: string) => `rn:fl:sig:${m}`;
const LABEL_MS = 60 * 60_000;
const LR = 0.03;
const L2 = 1e-4;
export const FL_MIN = 300;

export type FlashStats = { age: number; prog: number; mcSol: number; buys: number; sells: number; uniq: number; netSol: number; devSol: number; devSold: boolean; big: number; first2s: number; top3: number; rate10: number };
export type FlashLook = { mint: string; stage: FlStage; at: number; createdAt: number; st: FlashStats; sym?: string };
type Model = { w: number[]; mu: number[]; m2: number[]; n: number; pos: number };
type Snap = { id: string; mint: string; sym: string; stage: FlStage; at: number; createdAt: number; mcSol: number; x: number[]; p: number; prior: number };
export type FlashSig = { mint: string; sym: string; at: number; stage: FlStage; p: number; prior: number; by: "model" | "on"; mcSol: number; prog: number; why: string[] };

const clip = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));
const l1 = (v: number) => Math.log10(1 + Math.max(0, v || 0));
const sig = (z: number) => 1 / (1 + Math.exp(-clip(z, -30, 30)));

async function loadModel(): Promise<Model> {
  const m = await redis().get<Model>(W);
  if (m && m.w?.length === D) return m;
  return { w: new Array(D).fill(0), mu: new Array(D).fill(0), m2: new Array(D).fill(1), n: 0, pos: 0 };
}
function z(m: Model, x: number[]) {
  return x.map((v, i) => (i === 0 ? 1 : (v - m.mu[i]) / Math.sqrt(Math.max(1e-6, m.m2[i] / Math.max(1, m.n)) + 1e-6)));
}
export function predict(m: Model, x: number[]) {
  if (m.n < 50) return 0;
  return sig(z(m, x).reduce((a, v, i) => a + v * m.w[i], 0));
}
function learn(m: Model, x: number[], y: number) {
  m.n++;
  for (let i = 1; i < D; i++) {
    const d = x[i] - m.mu[i];
    m.mu[i] += d / m.n;
    m.m2[i] += d * (x[i] - m.mu[i]);
  }
  if (y) m.pos++;
  const zz = z(m, x);
  const p = sig(zz.reduce((a, v, i) => a + v * m.w[i], 0));
  const pw = clip((m.n - m.pos) / Math.max(1, m.pos), 1, 40);
  const g = (p - y) * (y ? pw : 1);
  for (let i = 0; i < D; i++) m.w[i] -= LR * (g * zz[i] + (i ? L2 * m.w[i] : 0));
}

/** Stream numbers + what the rats know of the launch -> model input. */
export function toX(stage: FlStage, st: FlashStats, rec: Launch | null) {
  const post = rec?.wire ? 1 : 0;
  return [
    1, stage === 45 ? 1 : 0, stage === 90 ? 1 : 0, clip(st.prog, 0, 100) / 100, l1(st.mcSol), l1(st.buys), l1(st.sells), l1(st.uniq),
    Math.sign(st.netSol) * l1(Math.abs(st.netSol)), st.buys + st.sells ? st.buys / (st.buys + st.sells) : 0.5,
    clip(st.devSol, 0, 20) / 5, st.devSold ? 1 : 0, l1(st.big), clip(st.first2s, 0, 1), clip(st.top3, 0, 1), l1(st.rate10),
    l1(rec?.devN || 0), rec && rec.devN ? (rec.devB || 0) / rec.devN : 0, rec ? [rec.twitter, rec.telegram, rec.website].filter(Boolean).length / 3 : 0,
    post, post && (rec?.wire?.lagSec ?? 999) <= 120 ? 1 : 0, (rec as any)?.pulse?.x ? 1 : 0,
  ];
}

/** The transparent starting score (shown before the model is ready, and the trigger in "on" mode). */
export function flashPrior(st: FlashStats, rec: Launch | null) {
  const why: string[] = [];
  let s = 25;
  if (st.prog >= 25) (s += 18), why.push(`curve ${Math.round(st.prog)}% in ${st.age}s`);
  else if (st.prog >= 10) (s += 9), why.push(`curve ${Math.round(st.prog)}% in ${st.age}s`);
  if (st.uniq >= 25) (s += 12), why.push(`${st.uniq} wallets`);
  else if (st.uniq >= 12) s += 6;
  if (st.netSol >= 8) (s += 8), why.push(`+${st.netSol.toFixed(1)} SOL net`);
  if (st.devSold) (s -= 30), why.push("dev already sold");
  if (st.first2s >= 0.6) (s -= 15), why.push(`${Math.round(st.first2s * 100)}% bought in the first 2s`);
  if (st.top3 >= 0.6) (s -= 10), why.push(`top 3 wallets ${Math.round(st.top3 * 100)}% of buying`);
  if (rec?.wire) (s += 10), why.push(`born from @${rec.wire.h}'s post`);
  if (rec && rec.devN >= 5 && !rec.devB) (s -= 15), why.push(`dev ${rec.devN} launches, none bonded`);
  if (rec && rec.devB > 0) (s += 8), why.push(`dev bonded ${rec.devB} before`);
  return { score: Math.round(clip(s, 0, 100)), why: why.slice(0, 4) };
}

/** Which score band a look time trusts, from its own record (lowest band with 30+ looks hitting 10%+ and 5x base). */
function cutoff(rec: Record<string, number>, stage: FlStage) {
  const base = Number(rec[`s${stage}:all:hit`] || 0) / Math.max(1, Number(rec[`s${stage}:all:n`] || 0));
  const minHit = Math.max(0.1, base * 5);
  for (let b = 2; b <= 9; b++) {
    let n = 0;
    let h = 0;
    for (let k = b; k <= 9; k++) {
      n += Number(rec[`s${stage}:p${k}:n`] || 0);
      h += Number(rec[`s${stage}:p${k}:hit`] || 0);
    }
    if (n >= 30 && h / n >= minHit) return { band: b / 10, n, hit: Math.round((h / n) * 1000) / 1000, base: Math.round(base * 1000) / 1000 };
  }
  return null;
}

/** The worker hands over a batch of looks (15s, 45s, 90s after launch). Score, snapshot, maybe signal the desk. */
export async function flashLook(looks: FlashLook[]) {
  if (!looks.length) return { looks: 0 };
  const r = redis();
  const s = await getSettings();
  const c: any = s.desk;
  const mode: "auto" | "on" | "off" = c.flashMode ?? "auto";
  const [model, recStat, recs] = await Promise.all([
    loadModel(),
    r.hgetall<Record<string, number>>(REC).then((x) => (x || {}) as Record<string, number>),
    r.mget<(Launch | null)[]>(...looks.map((l) => K.launch(l.mint))),
  ]);
  const cuts: Record<number, ReturnType<typeof cutoff>> = {};
  for (const st of FL_STAGES) cuts[st] = model.n >= FL_MIN && model.pos >= 15 ? cutoff(recStat, st) : null;
  const pipe = r.pipeline();
  const sigs: FlashSig[] = [];
  const view: any[] = [];
  for (let i = 0; i < looks.length; i++) {
    const lk = looks[i];
    const rec = recs[i] || null;
    if (rec?.outcome || rec?.completeAt) continue; // already bonded or resolved: nothing early about it
    const x = toX(lk.stage, lk.st, rec);
    const p = predict(model, x);
    const pr = flashPrior(lk.st, rec);
    const sym = rec?.symbol || lk.sym || lk.mint.slice(0, 4);
    const id = `${lk.mint}:${lk.stage}`;
    pipe.hset(SNAP, { [id]: { id, mint: lk.mint, sym, stage: lk.stage, at: lk.at, createdAt: lk.createdAt, mcSol: lk.st.mcSol, x, p, prior: pr.score } satisfies Snap });
    pipe.zadd(DUE, { score: lk.createdAt + LABEL_MS, member: id });
    // the speed panel shows when the first look lands (the 15s one), not the average of all three
    if (lk.stage === 15) pipe.lpush("rn:lat:flash", Math.round((lk.at - lk.createdAt) / 1000));
    view.push({ mint: lk.mint, sym, stage: lk.stage, p: Math.round(p * 1000) / 1000, prior: pr.score, prog: Math.round(lk.st.prog), uniq: lk.st.uniq, why: pr.why });
    const cut = cuts[lk.stage];
    const byModel = mode !== "off" && !!cut && p >= cut.band;
    const byOn = mode === "on" && !cut && pr.score >= (c.flashPriorMin ?? 75);
    const clean = !lk.st.devSold && lk.st.first2s < 0.7 && !(rec && rec.devN >= 5 && !rec.devB);
    if ((byModel || byOn) && clean) sigs.push({ mint: lk.mint, sym, at: Date.now(), stage: lk.stage, p: Math.round(p * 1000) / 1000, prior: pr.score, by: byModel ? "model" : "on", mcSol: lk.st.mcSol, prog: lk.st.prog, why: pr.why });
  }
  pipe.ltrim("rn:lat:flash", 0, 199);
  if (view.length) {
    const prev = ((await r.get<any>(VIEW)) || { top: [] }) as { top: any[] };
    const top = [...view, ...(prev.top || [])].filter((v, i, a) => a.findIndex((y) => y.mint === v.mint) === i).slice(0, 30);
    pipe.set(VIEW, { at: Date.now(), n: model.n, pos: model.pos, cuts, top }, { ex: 3600 });
  }
  for (const g of sigs.slice(0, 3)) {
    pipe.set(FL_SIG(g.mint), g, { ex: 600 });
    pipe.zadd(K.deskQ, { score: g.at, member: `f:${g.mint}` });
    agentLog(pipe, [{ agent: "FLASH", at: g.at, mint: g.mint, symbol: g.sym, text: `$${g.sym} at ${g.stage}s: ${g.by === "model" ? `P(bond) ${Math.round(g.p * 100)}%` : `score ${g.prior}`}, curve ${Math.round(g.prog)}%${g.why.length ? `, ${g.why.slice(0, 2).join(", ")}` : ""}. sent to the desk`, tone: "ok", stance: 0.8 }]);
  }
  await pipe.exec();
  return { looks: looks.length, sent: sigs.length };
}

export async function flashSignal(m: string) {
  return redis().get<FlashSig>(FL_SIG(m));
}

/** Label every look whose hour is up: did the coin bond (curve complete, not stuck) within 60 minutes of launch? */
export async function flashFollow() {
  const r = redis();
  const now = Date.now();
  if (now - Number((await r.get("rn:fl:at")) || 0) < 25_000) return { flash: "not due" };
  await r.set("rn:fl:at", now);
  const ids = ((await r.zrange<string[]>(DUE, 0, now, { byScore: true, offset: 0, count: 600 })) || []) as string[];
  if (!ids.length) return { labelled: 0 };
  const snaps = ((await r.hmget<Record<string, Snap>>(SNAP, ...ids)) || {}) as Record<string, Snap | null>;
  const mints = Array.from(new Set(ids.map((id) => id.split(":")[0])));
  const recArr = await r.mget<(Launch | null)[]>(...mints.map((m) => K.launch(m)));
  const recBy: Record<string, Launch | null> = {};
  mints.forEach((m, i) => (recBy[m] = recArr[i] || null));
  const model = await loadModel();
  const inc: Record<string, number> = {};
  const hist: any[] = [];
  let n = 0;
  for (const id of ids) {
    const sp = snaps[id];
    if (!sp) continue;
    const rec = recBy[sp.mint];
    // a full curve that later proved stuck (never migrated) is a miss, whatever order the flags arrived in
    const bonded = !!rec?.completeAt && !rec.stuck && rec.outcome !== "DIED" && rec.completeAt - sp.createdAt <= LABEL_MS + 60_000;
    const y = bonded ? 1 : 0;
    // graded on the score it gave at the look (what the desk acted on). Before v0.1.28 it was today's model's score,
    // so the record described a model that never made those calls
    const band = Math.min(9, Math.floor(sp.p * 10));
    const k = (x: string) => (inc[x] = (inc[x] || 0) + 1);
    k(`s${sp.stage}:p${band}:n`);
    k(`s${sp.stage}:all:n`);
    if (y) {
      k(`s${sp.stage}:p${band}:hit`);
      k(`s${sp.stage}:all:hit`);
      hist.push({ mint: sp.mint, sym: sp.sym, stage: sp.stage, p: Math.round(sp.p * 100) / 100, prior: sp.prior, mcSol: Math.round(sp.mcSol) });
    }
    learn(model, sp.x, y);
    n++;
  }
  const p = r.pipeline();
  p.zrem(DUE, ...ids);
  p.hdel(SNAP, ...ids);
  for (const [k, v] of Object.entries(inc)) p.hincrby(REC, k, v);
  p.set(W, model);
  if (hist.length) {
    p.lpush(HIST, ...hist);
    p.ltrim(HIST, 0, 99);
  }
  await p.exec();
  return { labelled: n, model: model.n };
}

export async function flashView() {
  const r = redis();
  const [v, rec, m, hist] = await Promise.all([r.get<any>(VIEW), r.hgetall<Record<string, number>>(REC), loadModel(), r.lrange<any>(HIST, 0, 19)]);
  const R = (rec || {}) as Record<string, number>;
  const stages = FL_STAGES.map((st) => ({ stage: st, n: Number(R[`s${st}:all:n`] || 0), hit: Number(R[`s${st}:all:hit`] || 0), cut: m.n >= FL_MIN && m.pos >= 15 ? cutoff(R, st) : null, bands: Array.from({ length: 10 }, (_, b) => ({ b, n: Number(R[`s${st}:p${b}:n`] || 0), hit: Number(R[`s${st}:p${b}:hit`] || 0) })) }));
  return { model: { n: m.n, pos: m.pos, ready: m.n >= FL_MIN && m.pos >= 15, need: FL_MIN }, stages, live: v || null, bonded: hist || [] };
}

// ---------------------------------------------------------------- the stream side (the worker keeps these in memory)

export type FlTrade = { t: number; side: "buy" | "sell"; sol: number; w: string };
export type FlCoin = { t0: number; mint: string; sym: string; creator: string; devSol: number; vSol: number; vTok: number; mcSol: number; trades: FlTrade[]; done: number[] };
/** A launch's first seconds, from the trades the worker streamed. */
export function streamStats(c: FlCoin, now: number): FlashStats {
  const age = Math.round((now - c.t0) / 1000);
  const others = c.trades.filter((x) => x.w !== c.creator);
  const buys = others.filter((x) => x.side === "buy");
  const sells = others.filter((x) => x.side === "sell");
  const buySol = buys.reduce((a, x) => a + x.sol, 0);
  const netSol = buySol - sells.reduce((a, x) => a + x.sol, 0);
  const devSold = c.trades.some((x) => x.w === c.creator && x.side === "sell");
  // SOL in the curve we never saw as a trade = bought in the launch block before our subscription (bundles, block-0
  // snipers): counted with the first 2 seconds of buying
  const curveSol = Math.max(0, c.vSol - 30);
  const unseen = Math.max(0, curveSol - c.devSol - netSol);
  const early = buys.filter((x) => x.t - c.t0 <= 2000).reduce((a, x) => a + x.sol, 0);
  const by = new Map<string, number>();
  for (const x of buys) by.set(x.w, (by.get(x.w) || 0) + x.sol);
  const top3 = [...by.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, x) => a + x, 0);
  const prog = c.vTok > 0 ? Math.max(0, Math.min(100, ((1_073_000_000 - c.vTok) / 793_100_000) * 100)) : 0;
  return {
    age,
    prog: Math.round(prog * 100) / 100,
    mcSol: Math.round(c.mcSol * 100) / 100,
    buys: buys.length,
    sells: sells.length,
    uniq: new Set(others.map((x) => x.w)).size,
    netSol: Math.round(netSol * 100) / 100,
    devSol: Math.round(c.devSol * 100) / 100,
    devSold,
    big: Math.round(Math.max(0, ...buys.map((x) => x.sol)) * 100) / 100,
    first2s: buySol + unseen > 0 ? Math.round(((early + unseen) / (buySol + unseen)) * 100) / 100 : 0,
    top3: buySol > 0 ? Math.round((top3 / buySol) * 100) / 100 : 0,
    rate10: buys.filter((x) => now - x.t <= 10_000).length,
  };
}

