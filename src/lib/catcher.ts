// CATCH: the sender catcher (23rd agent).
//
// The King answers "will it bond?" at minute 5. That is the wrong question for the money: most bonds die within 20
// minutes of migrating, and the trades that pay for everything are the senders, the coins that run to $300K-$1M.
// They come in two shapes:
//   fast  - the curve fills in seconds to a few minutes and the coin keeps going after migration;
//   slow  - it grinds for 30-60 minutes, migrates, and only then sends to $200K-$500K.
// Neither is caught by a single look at minute 5. CATCH looks again and again: at every step of a hot curve, at
// migration, and through the first two hours after it, each time asking one question:
//
//   from here, does this coin reach max($300K, 2x its current market cap) within 6 hours?
//
// Every look is a snapshot of ~30 features (where it is, how fast it is moving, who is in it, what the other agents
// on the BOARD think), scored now and labelled later by what the coin actually did. A logistic model learns from
// every label (online, like nano), scored *before* it trains on each one, so its record is honest. Until it has
// enough labels, a transparent prior score (speed, breadth, buy pressure, wallets, story) decides. Once ready, the
// model's own record picks the cutoff: the lowest score band whose hit rate is good enough to trade.
//
// Starting numbers (target, horizon, cutoffs) are hints in the desk config (catch*). The model, its cutoff and the PM
// sleeve size are learned. FILM follows every skip, the ghost desk takes what the desk can't.
import { K, redis } from "./redis";
import { agentLog } from "./agents";
import { getSettings } from "./settings";
import { getCurves, solUsd } from "./solana";
import { board, confluence, recentCoins } from "./board";
import { buyersOf } from "./hound";
import { momoView, type Hot } from "./momo";
import type { Launch } from "./digger";
import { enqueueMind } from "./mind";
import { enqueueLens } from "./lens";

const W = "rn:ct:w2"; // model (v2: + hist flag)
const SNAP = "rn:ct:s"; // id -> Snap (pending)
const DUE = "rn:ct:due"; // id -> when its horizon ends
const WATCH = "rn:ct:watch"; // mint -> { pk, until, sym }
const LAST = "rn:ct:last"; // mint -> last look { at, prog, real, mc, stage }
const REC = "rn:ct:rec"; // prequential record: p{bucket}:n / :hit, prior{bucket}:n / :hit, all:n / :hit
const VIEW = "rn:ct:view";
const HIST = "rn:ct:hist"; // resolved snapshots, newest first (for the page)
const AT = "rn:ct:at";
const MIG = "rn:ct:mig"; // fresh migrations: mint -> when (from the digger and the worker's PumpPortal feed)
const PK_AT = "rn:ct:pkat";
export const CT_SIG = (m: string) => `rn:ct:sig:${m}`; // what the desk reads for a CATCH signal
const COOL = (m: string) => `rn:ct:cool:${m}`;

export const CT_FEATURES = [
  "bias", "pool", "log_mc", "log_age", "prog", "vel", "log_sol", "log_mig", "fast_mig",
  "log_uniq", "log_organic", "buy_share", "bundle", "farm", "log_smart", "log_tracked",
  "king", "king_bond", "post", "log_wave", "narrative", "log_v5", "log_buyers5", "buy_ratio", "ch5", "ch1h",
  "conf_pos", "conf_neg", "dev_rate", "socials", "copy", "mind", "lens", "hist",
] as const;
const D = CT_FEATURES.length;
export const CT_MIN = 300; // labels before the model trades
const LR = 0.03;
const L2 = 1e-4;

type Model = { w: number[]; mu: number[]; m2: number[]; n: number; pos: number; ver: number };
export type Snap = { id: string; mint: string; sym: string; at: number; stage: "curve" | "pool"; mc: number; x: number[]; p: number; prior: number; why: string[] };
export type CatchSig = { mint: string; sym: string; at: number; stage: "curve" | "pool"; mc: number; p: number; prior: number; by: "model" | "prior"; why: string[]; target: number };

const clip = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));
const l1 = (v: number) => Math.log10(1 + Math.max(0, v || 0));
const sig = (z: number) => 1 / (1 + Math.exp(-clip(z, -30, 30)));
const usdK = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}K`);

async function loadModel(): Promise<Model> {
  const m = await redis().get<Model>(W);
  if (m && m.w?.length === D) return m;
  return { w: new Array(D).fill(0), mu: new Array(D).fill(0), m2: new Array(D).fill(1), n: 0, pos: 0, ver: 1 };
}

/** Standardised input (running mean and variance per feature; bias stays 1). */
function z(m: Model, x: number[]) {
  return x.map((v, i) => (i === 0 ? 1 : (v - m.mu[i]) / Math.sqrt(Math.max(1e-6, m.m2[i] / Math.max(1, m.n)) + 1e-6)));
}
export function predict(m: Model, x: number[]) {
  if (m.n < 30) return 0;
  const zz = z(m, x);
  return sig(zz.reduce((a, v, i) => a + v * m.w[i], 0));
}
function learn(m: Model, x: number[], y: number, w = 1) {
  // running stats first (Welford), then one SGD step with the rare class weighed up
  m.n++;
  for (let i = 1; i < D; i++) {
    const d = x[i] - m.mu[i];
    m.mu[i] += d / m.n;
    m.m2[i] += d * (x[i] - m.mu[i]);
  }
  if (y) m.pos++;
  const zz = z(m, x);
  const p = sig(zz.reduce((a, v, i) => a + v * m.w[i], 0));
  const pw = clip((m.n - m.pos) / Math.max(1, m.pos), 1, 25);
  const g = (p - y) * (y ? pw : 1) * clip(w, 0.05, 10);
  for (let i = 0; i < D; i++) m.w[i] -= LR * (g * zz[i] + (i ? L2 * m.w[i] : 0));
}

/** The transparent starting score (0-100): speed, breadth, buy pressure, wallets, story, the other agents. */
export function priorScore(f: Record<string, number>) {
  const why: string[] = [];
  let s = 30;
  if (f.pool) {
    // after migration: real money flowing now, broad and buy-heavy, and not already chased
    if (f.v5 >= 60_000) (s += 16), why.push(`${usdK(f.v5)} volume in 5m`);
    else if (f.v5 >= 25_000) (s += 9), why.push(`${usdK(f.v5)} volume in 5m`);
    if (f.buyers5 >= 120) (s += 10), why.push(`${f.buyers5} buyers in 5m`);
    else if (f.buyers5 >= 50) s += 5;
    if (f.buyRatio >= 1.3) (s += 8), why.push(`buyers ${f.buyRatio.toFixed(1)}x sellers`);
    else if (f.buyRatio < 0.9) (s -= 12), why.push("more sellers than buyers");
    if (f.migMin > 0 && f.migMin <= 10) (s += 10), why.push(`migrated ${Math.round(f.migMin)}m after launch`);
    else if (f.migMin > 0 && f.migMin <= 60) s += 4;
    if (f.ch5 > 80) (s -= 15), why.push(`already +${Math.round(f.ch5)}% in 5m`);
    if (f.ch1h < -35) (s -= 12), why.push(`${Math.round(f.ch1h)}% in 1h`);
    if (f.sol < 30) (s -= 10), why.push(`thin pool (${Math.round(f.sol)} SOL)`);
  } else {
    // on the curve: how fast it fills and how broad the buying is
    if (f.vel >= 8) (s += 16), why.push(`curve +${f.vel.toFixed(0)} pts/min`);
    else if (f.vel >= 3) (s += 9), why.push(`curve +${f.vel.toFixed(1)} pts/min`);
    else if (f.vel <= 0.3 && f.prog < 80) s -= 6;
    if (f.ageMin <= 5 && f.prog >= 50) (s += 8), why.push(`${Math.round(f.prog)}% full in ${Math.max(1, Math.round(f.ageMin))}m`);
    if (f.organic >= 60) (s += 8), why.push(`${f.organic} organic traders`);
    else if (f.uniq && f.uniq < 15) (s -= 8), why.push(`only ${f.uniq} traders`);
    if (f.buyShare >= 0.7) s += 4;
    if (f.bundle > 0.5) (s -= 12), why.push(`bundle ${Math.round(f.bundle * 100)}%`);
  }
  // the live tape from the worker (last 20 seconds of trades), when there is one
  if (f.rtB >= 10 && f.rtU >= 6 && f.rtNet >= 4) (s += 10), why.push(`live: ${f.rtB} buys in 20s, +${f.rtNet.toFixed(1)} SOL net`);
  else if (f.rtS >= 6 && f.rtS > f.rtB * 1.5) (s -= 8), why.push("selling right now");
  if (f.farm) (s -= 40), why.push("farm or bot coin");
  if (f.tracked >= 3) (s += 12), why.push(`${f.tracked} tracked wallets in`);
  else if (f.tracked >= 1) (s += 6), why.push(`${f.tracked} tracked wallet in`);
  if (f.smart >= 2) (s += 6), why.push(`${f.smart} smart wallets early`);
  if (f.kingBond) (s += 6), why.push("King BOND");
  if (f.post) (s += 5), why.push(f.wave >= 3 ? `post wave (${f.wave} coins)` : "born from a post");
  if (f.narrative >= 3) (s += 5), why.push("rising narrative");
  if (f.confPos >= 3) (s += 8), why.push(`${f.confPos} agent families agree`);
  if (f.confNeg >= 2) (s -= 8), why.push(`${f.confNeg} agent families against`);
  if (f.mind > 0.5) s += 5;
  if (f.mind < 0) s -= 5;
  if (f.copy) s -= 4;
  return { score: Math.round(clip(s, 0, 100)), why: why.slice(0, 5) };
}

type Cand = { mint: string; stage: "curve" | "pool"; hot?: Hot; prog?: number; real?: number; mcSol?: number; supply?: number };

/** Raw values -> model input (one place, so live looks and replayed history line up exactly). */
export function toX(f: Record<string, number>) {
  return [
    1, f.pool, l1(f.mc), l1(f.ageMin), f.prog / 100, clip(f.vel, -20, 50) / 10, l1(f.sol), l1(f.migMin), f.migMin > 0 && f.migMin <= 10 ? 1 : 0,
    l1(f.uniq), l1(f.organic), f.buyShare, f.bundle, f.farm, l1(f.smart), l1(f.tracked),
    f.king / 100, f.kingBond, f.post, l1(f.wave), l1(f.narrative), l1(f.v5), l1(f.buyers5), clip(f.buyRatio, 0, 5), clip(f.ch5, -100, 300) / 100, clip(f.ch1h, -100, 1000) / 100,
    f.confPos, f.confNeg, f.devRate, f.socials, f.copy, f.mind, f.lens, f.hist || 0,
  ];
}

/** Build one snapshot's features from everything the agents already know about the coin. */
async function features(c: Cand, rec: Launch | null, sol: number, prev: any, rt?: any) {
  const now = Date.now();
  const posts = await board(c.mint).catch(() => []);
  const cf = confluence(posts, now);
  const tracked = (await buyersOf(c.mint).catch(() => [])).filter((x: any) => x.side !== "sell" && now - x.at < 2 * 3600_000).length;
  const t: any = rec?.tape;
  const ageMin = rec ? (now - rec.createdAt) / 60_000 : (c.hot?.ageMin ?? 0);
  const mc = c.stage === "pool" ? (c.hot?.mc || (c.mcSol || 0) * sol) : (c.mcSol || 0) * sol;
  const migMin = rec?.completeAt && rec.createdAt ? (rec.completeAt - rec.createdAt) / 60_000 : c.stage === "pool" && c.hot ? 0 : 0;
  const vel = c.stage === "curve" && prev && prev.stage === "curve" && now - prev.at > 5_000 ? ((c.prog! - prev.prog) / ((now - prev.at) / 60_000)) : c.stage === "curve" && ageMin > 0 ? (c.prog || 0) / Math.max(1, ageMin) : (c.hot?.ch5 ?? 0) / 5;
  const mindPost = posts.find((x) => x.a === "MIND");
  const lensPost = posts.find((x) => x.a === "LENS");
  const f: Record<string, number> = {
    pool: c.stage === "pool" ? 1 : 0,
    mc,
    ageMin,
    prog: c.stage === "pool" ? 100 : c.prog || 0,
    vel,
    sol: c.stage === "pool" ? (c.real ?? (c.hot ? c.hot.liq / 2 / Math.max(1, sol) : 0)) : c.real || 0,
    migMin,
    uniq: t?.uniq || 0,
    organic: t?.organic || 0,
    buyShare: t?.buyShare ?? 0.5,
    bundle: t?.bundleShare || 0,
    farm: t?.farm?.farm ? 1 : 0,
    smart: rec?.g?.smartN || 0,
    tracked,
    king: rec?.call?.score || 0,
    kingBond: rec?.call?.verdict === "BOND" || rec?.call?.nano?.verdict === "BOND" ? 1 : 0,
    post: rec?.wire ? 1 : 0,
    wave: (rec?.wire as any)?.trac?.copies || 0,
    narrative: (rec as any)?.pulse?.x || 0,
    v5: c.hot?.v5 || 0,
    buyers5: c.hot?.buyers5 || 0,
    buyRatio: c.hot ? c.hot.buyers5 / Math.max(1, c.hot.sellers5) : 1,
    ch5: c.hot?.ch5 || 0,
    ch1h: c.hot?.ch1h || 0,
    confPos: cf.pos,
    confNeg: cf.neg,
    devRate: rec && rec.devN ? (rec.devB || 0) / rec.devN : 0,
    socials: rec ? [rec.twitter, rec.telegram, rec.website].filter(Boolean).length : 0,
    copy: (rec as any)?.meta?.copy ? 1 : 0,
    mind: mindPost ? mindPost.s : 0,
    lens: lensPost ? lensPost.s : 0,
    // live tape (prior score only; the model's inputs stay the same so its record stays comparable)
    rtB: rt && now - rt.at < 30_000 ? rt.b20 : 0,
    rtS: rt && now - rt.at < 30_000 ? rt.s20 : 0,
    rtU: rt && now - rt.at < 30_000 ? rt.u20 : 0,
    rtNet: rt && now - rt.at < 30_000 ? rt.bsol - rt.ssol : 0,
  };
  const x = toX(f);
  return { f, x, mc, cf };
}

/** Which score band the model trusts, from its own prequential record: the lowest band (>= 0.5 means 50%) whose
 *  snapshots hit at least `minHit`, with enough of them to mean something. */
function cutoff(rec: Record<string, number>, minHitAbs: number, minN = 25) {
  // senders are rare (well under 1 look in 50), so the bar is relative: at least `minHitAbs` and 6x the base rate
  const base = Number(rec["all:hit"] || 0) / Math.max(1, Number(rec["all:n"] || 0));
  const minHit = Math.max(minHitAbs, base * 6);
  for (let b = 3; b <= 9; b++) {
    let n = 0;
    let h = 0;
    for (let k = b; k <= 9; k++) {
      n += Number(rec[`p${k}:n`] || 0);
      h += Number(rec[`p${k}:hit`] || 0);
    }
    if (n >= minN && h / n >= minHit) return { band: b / 10, n, hit: h / n };
  }
  return null;
}

/** One pass: find candidates, snapshot them, score, signal the desk. Then follow peaks and learn from labels. */
export async function catchPass(force = false) {
  const r = redis();
  const now = Date.now();
  if (!force && now - Number((await r.get(AT)) || 0) < 10_000) return { catch: "not due" };
  await r.set(AT, now);
  const s = await getSettings();
  const c: any = s.desk;
  if (c.catchMode === "off") return { catch: "off" };
  const target = c.catchTargetUsd ?? 300_000;
  const sol = (await solUsd().catch(() => null)) || 150;

  // --- candidates: hot curves (fast and slow), migrated coins MOMO sees, and coins the agents agree on
  await r.zremrangebyscore(MIG, 0, now - 2 * 3600_000);
  const [radar, mv, recent, migRaw] = await Promise.all([
    r.zrange<string[]>(K.radar, 0, (c.catchCurveTop ?? 40) - 1, { rev: true }),
    momoView().catch(() => null),
    recentCoins(20 * 60_000, 40).catch(() => [] as string[]),
    r.zrange<string[]>(MIG, 0, 29, { rev: true }),
  ]);
  const migs = ((migRaw || []) as string[]).map(String);
  const hotBy = new Map<string, Hot>();
  for (const h of mv?.hot || []) if (h.ageMin <= 24 * 60) hotBy.set(h.mint, h);
  const mints = Array.from(new Set([...migs, ...(radar || []), ...hotBy.keys(), ...recent])).slice(0, 100);
  if (!mints.length) {
    await follow(sol, target);
    return { catch: "no candidates" };
  }
  const [curves, recs, lastAll, rtAll] = await Promise.all([
    getCurves(mints).catch(() => ({} as Record<string, any>)),
    r.mget<(Launch | null)[]>(...mints.map((m) => K.launch(m))),
    r.hmget<Record<string, any>>(LAST, ...mints),
    r.hmget<Record<string, any>>("rn:rt", ...mints).catch(() => null),
  ]);
  const rtBy = (rtAll || {}) as Record<string, any>;
  const last = (lastAll || {}) as Record<string, any>;
  // fresh migrations MOMO has not listed yet: read their pool straight from the chain
  const migSet = new Set(migs);
  const needPool = mints.filter((m) => migSet.has(m) && !hotBy.has(m) && !((curves as any)[m] && !(curves as any)[m].complete));
  const { priceOf } = await import("./desk");
  const poolPx = needPool.length ? await priceOf(needPool).catch(() => ({} as Record<string, any>)) : {};
  const model = await loadModel();
  const recStat = ((await r.hgetall<Record<string, number>>(REC)) || {}) as Record<string, number>;
  const ready = model.n >= CT_MIN && model.pos >= 15;
  const cut = ready ? cutoff(recStat, c.catchMinHit ?? 0.08) : null;
  const pipe = r.pipeline();
  const scored: any[] = [];
  const signals: CatchSig[] = [];
  let snaps = 0;

  for (let i = 0; i < mints.length; i++) {
    const m = mints[i];
    const rec = recs[i] || null;
    const cv = (curves as any)[m];
    const hot = hotBy.get(m);
    let cand: Cand | null = null;
    if (cv && !cv.complete && cv.priceSol > 0) cand = { mint: m, stage: "curve", prog: cv.progress, real: cv.realSol, mcSol: cv.mcapSol, supply: cv.supply };
    else if (hot && (/pump/i.test(hot.dex) || m.endsWith("pump"))) cand = { mint: m, stage: "pool", hot };
    else if ((poolPx as any)[m]?.grad) cand = { mint: m, stage: "pool", real: (poolPx as any)[m].real, mcSol: (poolPx as any)[m].px * 1e9 };
    if (!cand) continue;
    if (cand.stage === "curve" && (cand.prog || 0) < (c.catchMinCurve ?? 15)) continue;
    const prev = last[m];
    // look again only when something moved: 8+ curve points, a new stage, or 4 minutes on the curve / 5 in the pool
    const moved = !prev || prev.stage !== cand.stage || (cand.stage === "curve" ? Math.abs((cand.prog || 0) - prev.prog) >= 8 || now - prev.at >= 4 * 60_000 : now - prev.at >= 5 * 60_000);
    const { f, x, mc, cf } = await features(cand, rec, sol, prev, rtBy[m]);
    pipe.hset(LAST, { [m]: { at: now, prog: cand.prog ?? 100, mc, stage: cand.stage } });
    const pr = priorScore(f);
    const p = predict(model, x);
    const sym = rec?.symbol || hot?.symbol || m.slice(0, 4);
    scored.push({ mint: m, sym, stage: cand.stage, mc: Math.round(mc), p: Math.round(p * 1000) / 1000, prior: pr.score, why: pr.why, conf: cf.pos, age: Math.round(f.ageMin) });
    if (!moved || snaps >= (c.catchSnapsPerPass ?? 30) || mc <= 0) continue;
    // a snapshot to learn from (only while there is room to the target: a $280K coin "reaching $300K" teaches nothing)
    const goal = Math.max(target, mc * 2);
    if (mc < target * 0.6) {
      snaps++;
      const id = `${m}:${now.toString(36)}`;
      const snap: Snap = { id, mint: m, sym, at: now, stage: cand.stage, mc: Math.round(mc), x, p, prior: pr.score, why: pr.why };
      pipe.hset(SNAP, { [id]: snap });
      pipe.zadd(DUE, { score: now + (c.catchHorizonH ?? 6) * 3600_000, member: id });
      pipe.hset(WATCH, { [m]: { pk: mc, until: now + (c.catchHorizonH ?? 6) * 3600_000, sym } });
    }
    // the trade decision: the model once its record earned it, the prior before that
    const room = mc > 0 && mc <= goal / 2 && mc <= target / 2;
    const byModel = !!cut && p >= cut.band;
    // the prior keeps trading until the model has a band that earned it (a ready model with no good band yet is not
    // a reason to stop; the PM sleeve sizes CATCH by its real results either way)
    const byPrior = !cut && pr.score >= (c.catchPriorMin ?? 72);
    if (room && (byModel || byPrior) && !f.farm) signals.push({ mint: m, sym, at: now, stage: cand.stage, mc: Math.round(mc), p: Math.round(p * 1000) / 1000, prior: pr.score, by: byModel ? "model" : "prior", why: pr.why, target: Math.round(goal) });
  }

  // SYNC: where 3+ agent families agree, MIND and LENS take a look too (once per coin per 2 hours), and every CATCH
  // signal gets a MIND read, so the desk's trader's mind has an opinion on everything CATCH sends
  for (const x of scored) {
    if (x.conf >= 3 && (await r.set(`rn:ct:sync:${x.mint}`, 1, { nx: true, ex: 7200 }))) {
      enqueueMind(pipe, x.mint, "board");
      enqueueLens(pipe, x.mint, "wire");
    }
  }
  for (const g of signals) enqueueMind(pipe, g.mint, "catch");
  scored.sort((a, b) => (ready ? b.p - a.p : b.prior - a.prior));
  pipe.set(VIEW, { at: now, ready, n: model.n, pos: model.pos, cut, scanned: scored.length, top: scored.slice(0, 25) }, { ex: 600 });
  await pipe.exec();

  // --- signals to the desk (one per coin per 30 minutes)
  const sent: CatchSig[] = [];
  for (const g of signals.sort((a, b) => b.p - a.p || b.prior - a.prior).slice(0, 3)) {
    if (!(await r.set(COOL(g.mint), 1, { nx: true, ex: (c.catchCooldownMin ?? 30) * 60 }))) continue;
    const q = r.pipeline();
    q.set(CT_SIG(g.mint), g, { ex: 3600 });
    q.zadd(K.deskQ, { score: now, member: `c:${g.mint}` });
    agentLog(q, [{ agent: "CATCH", at: now, mint: g.mint, symbol: g.sym, text: `$${g.sym} moves like a sender (${g.by === "model" ? `P ${Math.round(g.p * 100)}%` : `score ${g.prior}`}, ${g.stage === "pool" ? "after migration" : "on the curve"} at ${usdK(g.mc)}): ${g.why.slice(0, 3).join(", ")}. sent to the desk`, tone: "ok", stance: 0.9 }]);
    await q.exec();
    sent.push(g);
  }
  const fol = await follow(sol, target);
  return { catch: `${scored.length} scanned, ${snaps} snapshots, ${sent.length} sent`, ready, ...fol };
}

/** Follow the peak of every watched coin (once a minute) and label snapshots whose horizon ended or who hit. */
async function follow(sol: number, target: number) {
  const r = redis();
  const now = Date.now();
  if (now - Number((await r.get(PK_AT)) || 0) < 55_000) return {};
  await r.set(PK_AT, now);
  const watch = ((await r.hgetall<Record<string, { pk: number; until: number; sym: string }>>(WATCH)) || {}) as Record<string, { pk: number; until: number; sym: string }>;
  const live = Object.entries(watch).filter(([, w]) => w.until > now - 60_000);
  const gone = Object.entries(watch).filter(([, w]) => w.until <= now - 60_000).map(([m]) => m);
  if (gone.length) await r.hdel(WATCH, ...gone);
  // peaks: curve price or the canonical pool, for up to 200 coins (one batched read each way)
  const { priceOf } = await import("./desk");
  const mints = live.map(([m]) => m).slice(0, 200);
  const px = mints.length ? await priceOf(mints).catch(() => ({} as Record<string, any>)) : {};
  const upd: Record<string, any> = {};
  for (const m of mints) {
    const q = (px as any)[m];
    if (!q) continue;
    const mc = q.px * 1e9 * sol;
    if (mc > watch[m].pk) upd[m] = { ...watch[m], pk: Math.round(mc) };
  }
  if (Object.keys(upd).length) await r.hset(WATCH, upd);
  const pk = (m: string) => upd[m]?.pk ?? watch[m]?.pk ?? 0;

  // labels: due snapshots, plus any snapshot whose coin already hit its goal (early positive)
  const due = ((await r.zrange<string[]>(DUE, 0, now, { byScore: true })) || []) as string[];
  const hitMints = new Set(Object.keys(upd));
  const early: string[] = [];
  if (hitMints.size) {
    const all = ((await r.zrange<string[]>(DUE, 0, -1)) || []) as string[];
    for (const id of all) if (hitMints.has(id.split(":")[0])) early.push(id);
  }
  const ids = Array.from(new Set([...due, ...early])).slice(0, 400);
  if (!ids.length) return { labelled: 0 };
  const snaps = ((await r.hmget<Record<string, Snap>>(SNAP, ...ids)) || {}) as Record<string, Snap | null>;
  const model = await loadModel();
  const inc: Record<string, number> = {};
  const done: string[] = [];
  const hist: any[] = [];
  let labelled = 0;
  for (const id of ids) {
    const sp = snaps[id];
    if (!sp) {
      done.push(id);
      continue;
    }
    const goal = Math.max(target, sp.mc * 2);
    const peak = pk(sp.mint);
    const hit = peak >= goal;
    const over = due.includes(id);
    if (!hit && !over) continue; // early check only resolves positives
    const y = hit ? 1 : 0;
    // prequential: grade the score it gave *before* learning from this label
    const pb = Math.min(9, Math.floor(predict(model, sp.x) * 10));
    const qb = Math.min(9, Math.floor(sp.prior / 10));
    const key = (k: string) => (inc[k] = (inc[k] || 0) + 1);
    key(`p${pb}:n`);
    key(`q${qb}:n`);
    key("all:n");
    key(`${sp.stage}:n`);
    if (y) {
      key(`p${pb}:hit`);
      key(`q${qb}:hit`);
      key("all:hit");
      key(`${sp.stage}:hit`);
    }
    learn(model, sp.x, y);
    labelled++;
    done.push(id);
    hist.push({ mint: sp.mint, sym: sp.sym, at: sp.at, stage: sp.stage, mc: sp.mc, peak: Math.round(peak), hit: !!y, p: Math.round(sp.p * 100) / 100, prior: sp.prior });
  }
  const p = r.pipeline();
  if (done.length) {
    p.zrem(DUE, ...done);
    p.hdel(SNAP, ...done);
  }
  for (const [k, v] of Object.entries(inc)) p.hincrby(REC, k, v);
  if (labelled) p.set(W, model);
  if (hist.length) {
    p.lpush(HIST, ...hist);
    p.ltrim(HIST, 0, 199);
  }
  await p.exec();
  return { labelled, model: model.n };
}

/** A coin just migrated: CATCH looks at it on the next pass (and the worker triggers that pass at once). */
export async function noteMigration(mint: string, at = Date.now()) {
  await redis().zadd(MIG, { score: at, member: mint });
}

/** Run passes for up to `ms` (every ~12s), side by side with the desk. */
export async function catchSession(ms = 50_000) {
  const t0 = Date.now();
  let last: any = null;
  let passes = 0;
  while (Date.now() - t0 < ms - 3_000) {
    last = await catchPass().catch((e) => ({ catch: "error", error: String(e?.message || e) }));
    passes++;
    await new Promise((res) => setTimeout(res, 12_000));
  }
  return { passes, ...(last || {}) };
}

export async function catchSignal(mint: string) {
  return (await redis().get<CatchSig>(CT_SIG(mint))) || null;
}

/** For the page: the model's state, its honest record by score band, what it is looking at, and recent labels. */
export async function catchView() {
  const r = redis();
  const [v, rec, labels, m] = await Promise.all([r.get<any>(VIEW), r.hgetall<Record<string, number>>(REC), r.lrange<any>(HIST, 0, 29), loadModel()]);
  const R = (rec || {}) as Record<string, number>;
  const bands = Array.from({ length: 10 }, (_, b) => ({ b, n: Number(R[`p${b}:n`] || 0), hit: Number(R[`p${b}:hit`] || 0), qn: Number(R[`q${b}:n`] || 0), qhit: Number(R[`q${b}:hit`] || 0) }));
  const all = { n: Number(R["all:n"] || 0), hit: Number(R["all:hit"] || 0) };
  const hist = { n: Number(R["h:all:n"] || 0), hit: Number(R["h:all:hit"] || 0) };
  const stages = { curve: { n: Number(R["curve:n"] || 0), hit: Number(R["curve:hit"] || 0) }, pool: { n: Number(R["pool:n"] || 0), hit: Number(R["pool:hit"] || 0) } };
  return { live: v || null, hist, model: { n: m.n, pos: m.pos, ready: m.n >= CT_MIN && m.pos >= 15, need: CT_MIN, w: m.w.map((x) => Math.round(x * 1000) / 1000) }, bands, all, stages, recent: labels || [], features: CT_FEATURES };
}


// ---------------------------------------------------------------- history: start trained, not from zero

/** Pump curve market cap in SOL at a given fill (constant product, 30 SOL virtual, 1.073B virtual tokens). */
export function curveMcSol(progress: number) {
  const sold = clip(progress, 0, 100) / 100 * 793.1e6;
  const vTok = 1073.0e6 - sold;
  const vSol = (30 * 1073.0e6) / vTok;
  return (vSol / vTok) * 1e9;
}

/**
 * HISTORIAN hands CATCH what it rebuilt for a past launch: the minute-5 look (curve, tape, King v0) and, for bonded
 * launches, the migration moment plus the hourly candles after it. Each becomes a labelled snapshot with the `hist`
 * flag on (so the model can tell replayed looks from live ones, where MOMO and the wallets also speak). History has
 * its own record (h:*), the live record stays live.
 */
export async function learnHistory(items: { f: Record<string, number>; y: boolean; w: number }[]) {
  if (!items.length) return 0;
  const r = redis();
  const model = await loadModel();
  const inc: Record<string, number> = {};
  for (const it of items) {
    const x = toX({ ...it.f, hist: 1 });
    const pb = Math.min(9, Math.floor(predict(model, x) * 10));
    inc[`h:p${pb}:n`] = (inc[`h:p${pb}:n`] || 0) + 1;
    inc["h:all:n"] = (inc["h:all:n"] || 0) + 1;
    if (it.y) {
      inc[`h:p${pb}:hit`] = (inc[`h:p${pb}:hit`] || 0) + 1;
      inc["h:all:hit"] = (inc["h:all:hit"] || 0) + 1;
    }
    learn(model, x, it.y ? 1 : 0, it.w);
  }
  const p = r.pipeline();
  p.set(W, model);
  for (const [k, v] of Object.entries(inc)) p.hincrby(REC, k, v);
  await p.exec();
  return items.length;
}

/** Peak market cap (USD) in [from, to] from hourly candles [{t, mc}] where mc is the candle high. */
export function peakIn(path: { t: number; mc: number }[], from: number, to: number) {
  let pk = 0;
  for (const c of path) if (c.t + 3600_000 > from && c.t <= to) pk = Math.max(pk, c.mc);
  return pk;
}
