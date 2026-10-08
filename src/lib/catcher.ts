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
import { cachedRead, launchesCached, radarTop } from "./lcache";
import { memo, memoDrop } from "./memo";
import { acquire, release, type Lock } from "./lock";
import { bwLevel } from "./bwgov";
import { poolSnaps, poolWatch, asHot, type PoolSnap } from "./pools";
import { K, redis } from "./redis";
import { agentLog } from "./agents";
import { getSettings } from "./settings";
import { getCurves, pmap, solUsd } from "./solana";
import { BB, BB_RECENT, board, confluence, recentCoins, type Post } from "./board";
import { buyersOf } from "./hound";
import { momoView, type Hot } from "./momo";
import type { Launch } from "./digger";
import { enqueueMind } from "./mind";
import { enqueueLens } from "./lens";

const W = "rn:ct:w2"; // model (v2: + hist flag; v0.1.19 grows it with live-tape and pool inputs, learned weights kept)
const W2H = "rn:ct:w2h"; // the fast model: does it hit within 2 hours (labels 3x sooner)
const REC2 = "rn:ct:rec2"; // its prequential record
const DUE2 = "rn:ct:due2"; // id -> when its 2-hour horizon ends
const SNAP = "rn:ct:s"; // id -> Snap (pending)
const DUE = "rn:ct:due"; // id -> when its horizon ends
const WATCH = "rn:ct:watch"; // mint -> { pk, until, sym }
const PKS = "rn:ct:pks"; // snapshot id -> highest market cap since THAT snapshot (v0.1.28)
const RECM = "rn:ct:recm"; // coins already in the 6-hour record (one entry per coin)
const RECM2 = "rn:ct:recm2"; // same for the 2-hour record
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
  // v0.1.19: the live trade stream (worker, last 60 seconds) and the pool watch (every migration, once a minute)
  "rt_live", "log_b60", "log_u60", "net60", "sell_share60", "log_new60", "log_big60", "mc_ch60",
  "pool_seen", "log_liq", "log_v5_pool", "pool_buy_share",
] as const;
const D = CT_FEATURES.length;
export const CT_MIN = 300; // labels before the model trades
const LR = 0.03;
const L2 = 1e-4;

type Model = { w: number[]; mu: number[]; m2: number[]; n: number; pos: number; ver: number };
export type Snap = { id: string; mint: string; sym: string; at: number; stage: "curve" | "pool"; mc: number; x: number[]; p: number; p2?: number; prior: number; why: string[] };
export type CatchSig = { mint: string; sym: string; at: number; stage: "curve" | "pool"; mc: number; p: number; prior: number; by: "model" | "prior"; why: string[]; target: number };

const clip = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));
const l1 = (v: number) => Math.log10(1 + Math.max(0, v || 0));
const sig = (z: number) => 1 / (1 + Math.exp(-clip(z, -30, 30)));
const usdK = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}K`);

async function loadModel(key = W): Promise<Model> {
  const m = await redis().get<Model>(key);
  if (m && m.w?.length === D) return m;
  // a model from before new inputs were added keeps everything it learned; the new inputs start at zero weight
  if (m && m.w?.length && m.w.length < D) {
    const k = D - m.w.length;
    return { ...m, w: [...m.w, ...new Array(k).fill(0)], mu: [...m.mu, ...new Array(k).fill(0)], m2: [...m.m2, ...new Array(k).fill(Math.max(1, m.n))] };
  }
  return { w: new Array(D).fill(0), mu: new Array(D).fill(0), m2: new Array(D).fill(1), n: 0, pos: 0, ver: 1 };
}
/** Old snapshots were stored with fewer inputs: the missing ones read as 0. */
const pad = (x: number[]) => (x.length >= D ? x : [...x, ...new Array(D - x.length).fill(0)]);

/** Standardised input (running mean and variance per feature; bias stays 1). */
// v0.1.41: a variance floor and a cap at 5 deviations. Inputs that only exist live (the tape, tracked wallets, MIND,
// LENS) are constant in the historian's rows, so their variance was ~1/n: after 5,000 history rows one live row sat 71
// deviations out and a single label moved the weights by ~7 (every coin then scored 1.000). The history flag goes in
// as it is (0 or 1).
const CT_HIST = CT_FEATURES.indexOf("hist");
function z(m: Model, x0: number[]) {
  const x = pad(x0);
  return x.map((v, i) => {
    if (i === 0) return 1;
    if (i === CT_HIST) return v;
    const zz = (v - m.mu[i]) / Math.sqrt(Math.max(0.01, m.m2[i] / Math.max(1, m.n)));
    return Math.max(-5, Math.min(5, zz));
  });
}
export function predict(m: Model, x: number[]) {
  if (m.n < 30) return 0;
  const zz = z(m, x);
  return sig(zz.reduce((a, v, i) => a + v * m.w[i], 0));
}
function learn(m: Model, x0: number[], y: number, w = 1) {
  const x = pad(x0);
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
    f.rtLive || 0, l1(f.rtB60), l1(f.rtU60), Math.sign(f.rtNet60 || 0) * l1(Math.abs(f.rtNet60 || 0)), clip(f.rtSellShare ?? 0.5, 0, 1), l1(f.rtNew60), l1(f.rtBig60), clip(f.rtMcCh60 || 0, -60, 200) / 100,
    f.poolSeen || 0, l1(f.poolLiq), l1(f.poolV5), clip(f.poolBuyShare ?? 0.5, 0, 1),
  ];
}

/** Build one snapshot's features from everything the agents already know about the coin. */
async function features(c: Cand, rec: Launch | null, sol: number, prev: any, rt?: any, pl?: PoolSnap | null) {
  const now = Date.now();
  const posts = BBC.get(c.mint)?.posts ?? (await cachedRead(`bb:${c.mint}`, 15_000, () => board(c.mint)).catch(() => []));
  const cf = confluence(posts, now);
  const tracked = (await cachedRead(`hb:${c.mint}`, 60_000, () => buyersOf(c.mint)).catch(() => [])).filter((x: any) => x.side !== "sell" && now - x.at < 2 * 3600_000).length;
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
    // the 60-second flow picture (model inputs from v0.1.19)
    rtLive: rt && now - rt.at < 90_000 && rt.b60 != null ? 1 : 0,
    rtB60: rt && now - rt.at < 90_000 ? rt.b60 || 0 : 0,
    rtU60: rt && now - rt.at < 90_000 ? rt.u60 || 0 : 0,
    rtNet60: rt && now - rt.at < 90_000 ? (rt.bsol60 || 0) - (rt.ssol60 || 0) : 0,
    rtSellShare: rt && now - rt.at < 90_000 && (rt.b60 || 0) + (rt.s60 || 0) > 0 ? rt.s60 / (rt.b60 + rt.s60) : 0.5,
    rtNew60: rt && now - rt.at < 90_000 ? rt.new60 || 0 : 0,
    rtBig60: rt && now - rt.at < 90_000 ? rt.big60 || 0 : 0,
    rtMcCh60: rt && now - rt.at < 90_000 ? rt.mcCh60 || 0 : 0,
    // the pool watch: every migration's pool, once a minute
    poolSeen: pl && now - pl.at < 3 * 60_000 ? 1 : 0,
    poolLiq: pl ? pl.liq : 0,
    poolV5: pl ? pl.v5 : 0,
    poolBuyShare: pl && pl.b5 + pl.s5 > 0 ? pl.b5 / (pl.b5 + pl.s5) : 0.5,
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

/**
 * v0.1.29: the record from before v0.1.28 counted every look (one coin looked at 12 times as it ran was 12 hits) and
 * graded today's model instead of the score given at the time. That inflated record is what let CATCH trade. It is
 * moved aside once (kept as rn:ct:rec:v1 for reference) and the record starts over, honest. The models keep their
 * weights; only the record that decides whether they may trade starts again.
 */
async function resetRecordOnce() {
  const r = redis();
  if (await r.get("rn:ct:recv")) return;
  if (!(await r.set("rn:ct:recv", 2, { nx: true }))) return;
  const [a, b] = await Promise.all([r.hgetall<Record<string, number>>(REC), r.hgetall<Record<string, number>>(REC2)]);
  const p = r.pipeline();
  if (a && Object.keys(a).length) p.hset("rn:ct:rec:v1", a);
  if (b && Object.keys(b).length) p.hset("rn:ct:rec2:v1", b);
  p.del(REC, REC2, RECM, RECM2);
  await p.exec();
}

/** v0.1.41, once: both CATCH models and their records start over (they learned with unbounded inputs, see z()). */
let retrained = false;
async function retrainOnce() {
  if (retrained) return;
  const r = redis();
  if (await r.set("rn:fix:ct:0.1.41", Date.now(), { nx: true })) {
    await r.del(W, W2H, REC, REC2, RECM, RECM2, HIST);
    for (const k of [W, W2H]) memoDrop(`ct:model:${k}`);
    for (const k of [REC, REC2]) memoDrop(`ct:rec:${k}`);
  }
  retrained = true;
}

/** One pass: find candidates, snapshot them, score, signal the desk. Then follow peaks and learn from labels. */
// v0.1.40: the last look at each coin lives in memory (it is read and rewritten for ~240 coins every pass); it is
// written to Redis every 5 minutes so a restart keeps it. The live tape comes straight from the worker's memory when
// CATCH runs in the worker (lib: globalThis.__rnRt), instead of reading rn:rt for 240 coins every pass.
const LASTM = new Map<string, any>();
let lastLoadedAt = 0;
let lastSavedAt = 0;
async function lastFor(mints: string[]) {
  const now = Date.now();
  if (!lastLoadedAt || now - lastLoadedAt > 30 * 60_000) {
    const all = ((await redis().hgetall<Record<string, any>>(LAST).catch(() => null)) || {}) as Record<string, any>;
    for (const [k, v] of Object.entries(all)) if (!LASTM.has(k) || (LASTM.get(k)?.at ?? 0) < (v?.at ?? 0)) LASTM.set(k, v);
    lastLoadedAt = now;
  }
  return Object.fromEntries(mints.map((m) => [m, LASTM.get(m)]));
}
async function rtFor(mints: string[]) {
  // the live tape exists only in the worker's memory (v0.1.41: no Redis copy); elsewhere CATCH runs without it
  const local = (globalThis as any).__rnRt as ((ms: string[]) => Record<string, any>) | undefined;
  return local ? local(mints) : ({} as Record<string, any>);
}

// v0.1.41: BOARD posts per coin in memory, re-read only for coins that got a new post since the last pass
// (rn:bb:recent records every post time) or every 10 minutes. CATCH used to read 100 to 240 boards every 15s.
const BBC = new Map<string, { at: number; posts: Post[] }>();
let bbSeenAt = 0;
async function refreshBoards(mints: string[]) {
  const r = redis();
  const now = Date.now();
  const since = bbSeenAt ? bbSeenAt - 5_000 : 0;
  const changed = new Set(((await r.zrange<string[]>(BB_RECENT, since, now + 60_000, { byScore: true }).catch(() => [])) || []).map(String));
  bbSeenAt = now;
  const need = mints.filter((m) => {
    const h = BBC.get(m);
    return !h || changed.has(m) || now - h.at > 10 * 60_000;
  });
  if (need.length) {
    const p = r.pipeline();
    for (const m of need) p.hgetall(BB(m));
    const got = ((await p.exec().catch(() => [])) || []) as (Record<string, Post> | null)[];
    need.forEach((m, i) => BBC.set(m, { at: now, posts: Object.values(got[i] || {}) }));
  }
  if (BBC.size > 3000) for (const [k, v] of BBC) if (now - v.at > 30 * 60_000) BBC.delete(k);
}
// the watched coins and every snapshot's own peak, in memory too (re-read every 15 minutes); follow() used to read
// both whole hashes, thousands of entries, every minute
type Watch = { pk: number; until: number; sym: string };
let WATCHM: Map<string, Watch> | null = null;
let PKSM: Map<string, number> | null = null;
let followMemAt = 0;
async function followMem() {
  const now = Date.now();
  if (WATCHM && PKSM && now - followMemAt < 15 * 60_000) return;
  const r = redis();
  const [w, pk] = await Promise.all([r.hgetall<Record<string, Watch>>(WATCH), r.hgetall<Record<string, number>>(PKS)]);
  WATCHM = new Map(Object.entries((w || {}) as Record<string, Watch>));
  PKSM = new Map(Object.entries((pk || {}) as Record<string, number>).map(([k, v]) => [k, Number(v)]));
  followMemAt = now;
}
const ctModel = (k: string) => memo(`ct:model:${k}`, 30_000, () => loadModel(k));
const ctRec = (k: string) => memo(`ct:rec:${k}`, 30_000, async () => ((await redis().hgetall<Record<string, number>>(k)) || {}) as Record<string, number>);

export async function catchPass(force = false) {
  const r = redis();
  const now = Date.now();
  // v0.1.41: saving mode 3 (the day's Redis allowance is gone): CATCH waits, the desk keeps its positions
  if (bwLevel() >= 3) return { catch: "waiting: Redis saving mode 3" };
  if (!force && now - Number((await r.get(AT)) || 0) < 5_000) return { catch: "not due" };
  await r.set(AT, now);
  await resetRecordOnce();
  await retrainOnce().catch(() => null);
  const s = await getSettings();
  const c: any = s.desk;
  if (c.catchMode === "off") return { catch: "off" };
  const target = c.catchTargetUsd ?? 300_000;
  const sol = (await solUsd().catch(() => null)) || 150;

  // --- candidates: hot curves (fast and slow), migrated coins MOMO sees, and coins the agents agree on
  await r.zremrangebyscore(MIG, 0, now - 6 * 3600_000);
  // POOL WATCH: every migration of the last 2 hours, read in its pool once a minute (not only MOMO's list)
  await poolWatch().catch(() => null);
  const [radar, mv, recent, migRaw] = await Promise.all([
    radarTop(c.catchCurveTop ?? 60),
    momoView().catch(() => null),
    recentCoins(20 * 60_000, 40).catch(() => [] as string[]),
    r.zrange<string[]>(MIG, now - 2 * 3600_000, now, { byScore: true }),
  ]);
  const migs = ((migRaw || []) as string[]).map(String).reverse().slice(0, 150);
  const hotBy = new Map<string, Hot>();
  for (const h of mv?.hot || []) if (h.ageMin <= 24 * 60) hotBy.set(h.mint, h);
  const mints = Array.from(new Set([...migs, ...(radar || []), ...hotBy.keys(), ...recent])).slice(0, 240);
  if (!mints.length) {
    await follow(sol, target);
    return { catch: "no candidates" };
  }
  const [curves, recs, lastAll, rtAll] = await Promise.all([
    getCurves(mints).catch(() => ({} as Record<string, any>)),
    launchesCached(mints, 120_000),
    lastFor(mints),
    rtFor(mints),
  ]);
  const rtBy = (rtAll || {}) as Record<string, any>;
  const last = (lastAll || {}) as Record<string, any>;
  const migSet = new Set(migs);
  const pools = await poolSnaps(migs).catch(() => ({} as Record<string, PoolSnap | null>));
  const plOf = (m: string) => {
    const x = pools[m];
    return x && now - x.at < 3 * 60_000 && x.mc > 0 ? x : null;
  };
  // fresh migrations neither MOMO nor the pool watch has yet: read their pool straight from the chain
  const needPool = mints.filter((m) => migSet.has(m) && !hotBy.has(m) && !plOf(m) && !((curves as any)[m] && !(curves as any)[m].complete));
  const { priceOf } = await import("./desk");
  const poolPx = needPool.length ? await priceOf(needPool).catch(() => ({} as Record<string, any>)) : {};
  const model = await ctModel(W);
  const recStat = await ctRec(REC);
  const ready = model.n >= CT_MIN && model.pos >= 15;
  const cut = ready ? cutoff(recStat, c.catchMinHit ?? 0.08) : null;
  const pipe = r.pipeline();
  const scored: any[] = [];
  const signals: CatchSig[] = [];
  let snaps = 0;

  // candidates first, then every feature read in parallel (12 at a time): 200+ coins used to be read one by one
  const todo: { m: string; rec: Launch | null; cand: Cand; prev: any; hot?: Hot; pl: PoolSnap | null }[] = [];
  for (let i = 0; i < mints.length; i++) {
    const m = mints[i];
    const rec = recs[i] || null;
    const cv = (curves as any)[m];
    const pl = plOf(m);
    const hot = hotBy.get(m) || (pl ? asHot(m, pl, rec?.createdAt) : undefined);
    let cand: Cand | null = null;
    if (cv && !cv.complete && cv.priceSol > 0) cand = { mint: m, stage: "curve", prog: cv.progress, real: cv.realSol, mcSol: cv.mcapSol, supply: cv.supply };
    else if (hot && (/pump/i.test(hot.dex) || m.endsWith("pump"))) cand = { mint: m, stage: "pool", hot };
    else if ((poolPx as any)[m]?.grad) cand = { mint: m, stage: "pool", real: (poolPx as any)[m].real, mcSol: (poolPx as any)[m].px * 1e9 };
    if (!cand) continue;
    if (cand.stage === "curve" && (cand.prog || 0) < (c.catchMinCurve ?? 15)) continue;
    todo.push({ m, rec, cand, prev: last[m], hot, pl });
  }
  await refreshBoards(todo.map((t) => t.m)).catch(() => null);
  const feats = await pmap(todo, 12, (t) => features(t.cand, t.rec, sol, t.prev, rtBy[t.m], t.pl).catch(() => null));
  const model2 = await ctModel(W2H);
  const rec2 = await ctRec(REC2);
  const ready2 = model2.n >= CT_MIN && model2.pos >= 15;
  const cut2 = ready2 ? cutoff(rec2, c.catchMinHit ?? 0.08) : null;

  for (let j = 0; j < todo.length; j++) {
    const { m, rec, cand, prev, hot } = todo[j];
    const ft = feats[j];
    if (!ft) continue;
    // look again only when something moved: 8+ curve points, a new stage, or 4 minutes on the curve / 3 in the pool
    const moved = !prev || prev.stage !== cand.stage || (cand.stage === "curve" ? Math.abs((cand.prog || 0) - prev.prog) >= 8 || now - prev.at >= 4 * 60_000 : now - prev.at >= 3 * 60_000);
    const { f, x, mc, cf } = ft;
    LASTM.set(m, { at: now, prog: cand.prog ?? 100, mc, stage: cand.stage });
    const pr = priorScore(f);
    const p = predict(model, x);
    const p2 = predict(model2, x);
    const sym = rec?.symbol || hot?.symbol || m.slice(0, 4);
    scored.push({ mint: m, sym, stage: cand.stage, mc: Math.round(mc), p: Math.round(p * 1000) / 1000, p2: Math.round(p2 * 1000) / 1000, prior: pr.score, why: pr.why, conf: cf.pos, age: Math.round(f.ageMin), live: f.rtLive ? 1 : 0 });
    if (!moved || snaps >= (c.catchSnapsPerPass ?? 30) || mc <= 0) continue;
    // a snapshot to learn from (only while there is room to the target: a $280K coin "reaching $300K" teaches nothing)
    const goal = Math.max(target, mc * 2);
    if (mc < target * 0.6) {
      snaps++;
      const id = `${m}:${now.toString(36)}`;
      const snap: Snap = { id, mint: m, sym, at: now, stage: cand.stage, mc: Math.round(mc), x, p, p2, prior: pr.score, why: pr.why };
      pipe.hset(SNAP, { [id]: snap });
      pipe.hset(PKS, { [id]: Math.round(mc) });
      PKSM?.set(id, Math.round(mc));
      pipe.zadd(DUE, { score: now + (c.catchHorizonH ?? 6) * 3600_000, member: id });
      pipe.zadd(DUE2, { score: now + 2 * 3600_000, member: id });
      pipe.hset(WATCH, { [m]: { pk: mc, until: now + (c.catchHorizonH ?? 6) * 3600_000, sym } });
      WATCHM?.set(m, { pk: mc, until: now + (c.catchHorizonH ?? 6) * 3600_000, sym });
    }
    // the trade decision: the model once its record earned it, the prior before that
    const room = mc > 0 && mc <= goal / 2 && mc <= target / 2;
    // either model trades once its own record earned a band: the 6-hour model, or the fast 2-hour one (which gets
    // its labels 3x sooner, so it usually earns its band first)
    const by6 = !!cut && p >= cut.band;
    const by2 = !!cut2 && p2 >= cut2.band;
    const byModel = by6 || by2;
    // the prior keeps trading until a model has a band that earned it (a ready model with no good band yet is not
    // a reason to stop; the PM sleeve sizes CATCH by its real results either way)
    const byPrior = !cut && !cut2 && pr.score >= (c.catchPriorMin ?? 72);
    if (room && (byModel || byPrior) && !f.farm) signals.push({ mint: m, sym, at: now, stage: cand.stage, mc: Math.round(mc), p: Math.round((by2 && !by6 ? p2 : p) * 1000) / 1000, prior: pr.score, by: byModel ? "model" : "prior", why: pr.why, target: Math.round(goal) });
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
  if (now - lastSavedAt > 5 * 60_000) {
    lastSavedAt = now;
    for (const [k, v] of LASTM) if (now - (v?.at ?? 0) > 6 * 3600_000) LASTM.delete(k);
    const obj = Object.fromEntries(Array.from(LASTM.entries()).filter(([, v]) => now - (v?.at ?? 0) < 10 * 60_000));
    if (Object.keys(obj).length) pipe.hset(LAST, obj);
  }
  pipe.set(VIEW, { at: now, ready, n: model.n, pos: model.pos, cut, fast: { ready: ready2, n: model2.n, pos: model2.pos, cut: cut2 }, scanned: scored.length, pools: todo.filter((t) => t.pl).length, live: scored.filter((x) => x.live).length, top: scored.slice(0, 25) }, { ex: 600 });
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

// v0.1.42: the two CATCH models are trained by follow() and by the historian (learnHistory) in the same worker: both
// loaded, trained and saved without a lock, so either side's lessons could be overwritten. One lock now.
async function withModelLock<T>(fn: () => Promise<T>, waitMs: number): Promise<T | null> {
  const t0 = Date.now();
  let l: Lock | null = null;
  while (!l && Date.now() - t0 <= waitMs) {
    l = await acquire("rn:lock:ctmodel", 60_000);
    if (!l) await new Promise((res) => setTimeout(res, 250));
  }
  if (!l) return null;
  try {
    return await fn();
  } finally {
    await release(l);
  }
}

/** Follow the peak of every watched coin (once a minute) and label snapshots whose horizon ended or who hit. */
async function follow(sol: number, target: number) {
  const r = redis();
  const now = Date.now();
  // one follower a minute (v0.1.42: a single SET NX; the read-then-write let a burst pass and the regular pass both in)
  if (!(await r.set(PK_AT, now, { nx: true, px: 55_000 }).catch(() => null))) return {};
  return (await withModelLock(() => followHeld(sol, target, now), 5_000)) ?? { labelled: "busy" };
}
async function followHeld(sol: number, target: number, now: number) {
  const r = redis();
  await followMem();
  const watch = Object.fromEntries(WATCHM!) as Record<string, Watch>;
  const live = Object.entries(watch).filter(([, w]) => w.until > now - 60_000);
  const gone = Object.entries(watch).filter(([, w]) => w.until <= now - 60_000).map(([m]) => m);
  if (gone.length) {
    for (const m of gone) WATCHM!.delete(m);
    await r.hdel(WATCH, ...gone);
  }
  // peaks: curve price or the canonical pool, for up to 200 coins (one batched read each way)
  const { priceOf } = await import("./desk");
  // every watched coin (v0.1.42: was the first 200; the rest were labelled misses at their horizon even when they hit)
  const mints = live.map(([m]) => m).slice(0, 1500);
  const px = mints.length ? await priceOf(mints).catch(() => ({} as Record<string, any>)) : {};
  const upd: Record<string, any> = {};
  for (const m of mints) {
    const q = (px as any)[m];
    if (!q) continue;
    const mc = q.px * 1e9 * sol;
    if (mc > watch[m].pk) upd[m] = { ...watch[m], pk: Math.round(mc) };
  }
  if (Object.keys(upd).length) {
    for (const [m, w] of Object.entries(upd)) WATCHM!.set(m, w);
    await r.hset(WATCH, upd);
  }
  const mcNow: Record<string, number> = {};
  for (const m of mints) {
    const q = (px as any)[m];
    if (q) mcNow[m] = Math.round(q.px * 1e9 * sol);
  }
  // each snapshot keeps its own peak, measured from the moment it was taken. Before v0.1.28 every coin had one peak
  // that a new snapshot reset to the current price: an earlier snapshot's real 2x was wiped, and it was labelled a miss
  const pks = Object.fromEntries(PKSM!) as Record<string, number>;
  const pkUpd: Record<string, number> = {};
  const rose = new Set<string>();
  for (const [id, v] of Object.entries(pks)) {
    const now2 = mcNow[id.split(":")[0]];
    if (now2 && now2 > Number(v)) {
      pkUpd[id] = now2;
      rose.add(id);
    }
  }
  if (Object.keys(pkUpd).length) {
    for (const [id, v] of Object.entries(pkUpd)) PKSM!.set(id, v);
    await r.hset(PKS, pkUpd);
  }
  const pkOf = (id: string, m: string) => (pkUpd[id] ?? (pks[id] != null ? Number(pks[id]) : watch[m]?.pk ?? 0));

  // labels: due snapshots, plus any snapshot whose own peak rose this minute (it may have hit: early positive)
  const due = ((await r.zrange<string[]>(DUE, 0, now, { byScore: true })) || []) as string[];
  const early: string[] = Array.from(rose);
  // (snapshots from before v0.1.28 without their own peak are long resolved: no full read of the due list)
  // the fast model's labels: 2 hours after the look (or the moment the coin hits)
  const due2 = ((await r.zrange<string[]>(DUE2, 0, now, { byScore: true })) || []) as string[];
  const early2: string[] = Array.from(rose);

  const ids2 = Array.from(new Set([...due2, ...early2])).slice(0, 400);
  const ids6 = Array.from(new Set([...due, ...early])).slice(0, 400);
  const ids = Array.from(new Set([...ids6, ...ids2]));
  if (!ids.length) return { labelled: 0 };
  const snaps = ((await r.hmget<Record<string, Snap>>(SNAP, ...ids)) || {}) as Record<string, Snap | null>;
  const model = await loadModel();
  const inc: Record<string, number> = {};
  const done: string[] = [];
  const hist: any[] = [];
  let labelled = 0;
  // 2-hour labels first (they never delete the snapshot: the 6-hour label still needs it)
  const model2 = await loadModel(W2H);
  const inc2: Record<string, number> = {};
  const done2: string[] = [];
  let labelled2 = 0;
  const due2Set = new Set(due2);
  // still waiting on a 2-hour label? (a snapshot whose peak rose may have had its 2-hour label already)
  const pend2 = ids2.length ? (((await r.zmscore(DUE2, ids2).catch(() => null)) || []) as (number | null)[]) : [];
  const pend6 = ids6.length ? (((await r.zmscore(DUE, ids6).catch(() => null)) || []) as (number | null)[]) : [];
  // the record counts each coin once (its first resolved look): before v0.1.28 a coin looked at 12 times as it ran
  // filled a band with 12 hits, and the record looked far better than the trades it would have made
  const mintsOf = (xs: string[]) => Array.from(new Set(xs.map((id) => id.split(":")[0])));
  const m2 = mintsOf(ids2);
  const m6 = mintsOf(ids6);
  const in2 = m2.length ? (((await r.smismember(RECM2, m2).catch(() => null)) || []) as number[]) : [];
  const in6 = m6.length ? (((await r.smismember(RECM, m6).catch(() => null)) || []) as number[]) : [];
  const seen2 = new Set(m2.filter((_, i) => Number(in2[i])));
  const seen6 = new Set(m6.filter((_, i) => Number(in6[i])));
  const newM2: string[] = [];
  const newM6: string[] = [];
  for (let i = 0; i < ids2.length; i++) {
    const id = ids2[i];
    const sp = snaps[id];
    if (!sp) {
      done2.push(id);
      continue;
    }
    if (pend2[i] == null && !due2Set.has(id)) continue;
    const hit = pkOf(id, sp.mint) >= Math.max(target, sp.mc * 2);
    if (!hit && !due2Set.has(id)) continue;
    // graded on the score it gave at the look (what the desk acted on), not on today's model
    const pb = Math.min(9, Math.floor((sp.p2 ?? predict(model2, sp.x)) * 10));
    const k2 = (k: string) => (inc2[k] = (inc2[k] || 0) + 1);
    if (!seen2.has(sp.mint)) {
      seen2.add(sp.mint);
      newM2.push(sp.mint);
      k2(`p${pb}:n`);
      k2("all:n");
      if (hit) {
        k2(`p${pb}:hit`);
        k2("all:hit");
      }
    }
    learn(model2, sp.x, hit ? 1 : 0);
    labelled2++;
    done2.push(id);
  }
  const due6Set = new Set(due);
  for (let i = 0; i < ids6.length; i++) {
    const id = ids6[i];
    const sp = snaps[id];
    if (!sp) {
      done.push(id);
      continue;
    }
    if (pend6[i] == null && !due6Set.has(id)) continue;
    const goal = Math.max(target, sp.mc * 2);
    const peak = pkOf(id, sp.mint);
    const hit = peak >= goal;
    const over = due6Set.has(id);
    if (!hit && !over) continue; // early check only resolves positives
    const y = hit ? 1 : 0;
    // graded on the score stored at the look (the one the desk traded on), before learning from this label
    const pb = Math.min(9, Math.floor(sp.p * 10));
    const qb = Math.min(9, Math.floor(sp.prior / 10));
    const key = (k: string) => (inc[k] = (inc[k] || 0) + 1);
    if (!seen6.has(sp.mint)) {
      seen6.add(sp.mint);
      newM6.push(sp.mint);
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
    p.hdel(PKS, ...done);
    for (const id of done) PKSM?.delete(id);
  }
  if (newM6.length) p.sadd(RECM, newM6[0], ...newM6.slice(1));
  if (newM2.length) p.sadd(RECM2, newM2[0], ...newM2.slice(1));
  for (const [k, v] of Object.entries(inc)) p.hincrby(REC, k, v);
  if (labelled) p.set(W, model);
  if (done2.length) p.zrem(DUE2, ...done2);
  for (const [k, v] of Object.entries(inc2)) p.hincrby(REC2, k, v);
  if (labelled2) p.set(W2H, model2);
  if (hist.length) {
    p.lpush(HIST, ...hist);
    p.ltrim(HIST, 0, 199);
  }
  await p.exec();
  return { labelled, labelled2h: labelled2, model: model.n, model2h: model2.n };
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
    await new Promise((res) => setTimeout(res, 6_000));
  }
  return { passes, ...(last || {}) };
}

export async function catchSignal(mint: string) {
  return (await redis().get<CatchSig>(CT_SIG(mint))) || null;
}

/** For the page: the model's state, its honest record by score band, what it is looking at, and recent labels. */
export async function catchView() {
  const r = redis();
  const [v, rec, labels, m, m2, rec2] = await Promise.all([r.get<any>(VIEW), r.hgetall<Record<string, number>>(REC), r.lrange<any>(HIST, 0, 29), loadModel(), loadModel(W2H), r.hgetall<Record<string, number>>(REC2)]);
  const R2 = (rec2 || {}) as Record<string, number>;
  const R = (rec || {}) as Record<string, number>;
  const bands = Array.from({ length: 10 }, (_, b) => ({ b, n: Number(R[`p${b}:n`] || 0), hit: Number(R[`p${b}:hit`] || 0), qn: Number(R[`q${b}:n`] || 0), qhit: Number(R[`q${b}:hit`] || 0) }));
  const all = { n: Number(R["all:n"] || 0), hit: Number(R["all:hit"] || 0) };
  const hist = { n: Number(R["h:all:n"] || 0), hit: Number(R["h:all:hit"] || 0) };
  const stages = { curve: { n: Number(R["curve:n"] || 0), hit: Number(R["curve:hit"] || 0) }, pool: { n: Number(R["pool:n"] || 0), hit: Number(R["pool:hit"] || 0) } };
  return { live: v || null, hist, model: { n: m.n, pos: m.pos, ready: m.n >= CT_MIN && m.pos >= 15, need: CT_MIN, w: m.w.map((x) => Math.round(x * 1000) / 1000) }, bands, all, stages, recent: labels || [], features: CT_FEATURES, fast: { n: m2.n, pos: m2.pos, ready: m2.n >= CT_MIN && m2.pos >= 15, all: { n: Number(R2["all:n"] || 0), hit: Number(R2["all:hit"] || 0) }, hist: { n: Number(R2["h:all:n"] || 0), hit: Number(R2["h:all:hit"] || 0) }, bands: Array.from({ length: 10 }, (_, b) => ({ b, n: Number(R2[`p${b}:n`] || 0), hit: Number(R2[`p${b}:hit`] || 0) })) } };
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
export async function learnHistory(items: { f: Record<string, number>; y: boolean; y2?: boolean; w: number }[]) {
  if (!items.length) return 0;
  return (await withModelLock(() => learnHistoryHeld(items), 20_000)) ?? 0;
}
async function learnHistoryHeld(items: { f: Record<string, number>; y: boolean; y2?: boolean; w: number }[]) {
  const r = redis();
  const model = await loadModel();
  const model2 = await loadModel(W2H);
  const inc: Record<string, number> = {};
  const inc2: Record<string, number> = {};
  for (const it of items) {
    const x = toX({ ...it.f, hist: 1 });
    if (it.y2 != null) {
      const pb2 = Math.min(9, Math.floor(predict(model2, x) * 10));
      inc2[`h:p${pb2}:n`] = (inc2[`h:p${pb2}:n`] || 0) + 1;
      inc2["h:all:n"] = (inc2["h:all:n"] || 0) + 1;
      if (it.y2) {
        inc2[`h:p${pb2}:hit`] = (inc2[`h:p${pb2}:hit`] || 0) + 1;
        inc2["h:all:hit"] = (inc2["h:all:hit"] || 0) + 1;
      }
      learn(model2, x, it.y2 ? 1 : 0, it.w);
    }
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
  if (items.some((it) => it.y2 != null)) p.set(W2H, model2);
  for (const [k, v] of Object.entries(inc2)) p.hincrby(REC2, k, v);
  await p.exec();
  return items.length;
}

/** Peak market cap (USD) in [from, to] from hourly candles [{t, mc}] where mc is the candle high. */
export function peakIn(path: { t: number; mc: number }[], from: number, to: number) {
  let pk = 0;
  for (const c of path) if (c.t + 3600_000 > from && c.t <= to) pk = Math.max(pk, c.mc);
  return pk;
}
