// The Rat Desk: fourteen agents that turn Rat King calls into trades, and keep learning from every one of them.
// Paper first. When it passes its own public exam and finds a funded wallet, it promotes itself to live.
// Positions are re-read from the bonding curve every 2 seconds inside the desk loop, so sells are fast.
//
// v0.1.4, built on research (sources in README and claude/ratnet-desk-research.md):
// - Exits: take initials at 2x, keep a moonbag, ladder out at market cap milestones by P(next milestone),
//   trail that widens as the coin runs, hard exit when the dev or insiders dump.
// - Entries: never chase. Every signal is followed in shadow with three pullback depths; pullback entries
//   unlock only when the shadow record proves they beat buying straight away.
// - Early entries: the minute-1 model's calls are shadowed until its record matches the minute-5 King.
// - COACH: watches every coin after the desk sold it and retunes the trail from what really happened.

import { getLaunch, getLaunches, putLaunch } from "./launches";
import { memo } from "./memo";
import { listCached, listDrop } from "./lcache";
import { ATA_RENT, roundTripCost, slipOf, sellProceeds, txCost, venueFee, type CostCfg } from "./costs";
import { shield } from "./shield";
import { dropPaths, labBest, labStep, notePath, tierOf, type ExitSet, type LabBest, type Tier } from "./exitlab";
import { flashSignal } from "./flash";
import { catchSignal } from "./catcher";
import { acquire, holds, release, renew, type Lock } from "./lock";
import { streamQuote } from "./streamlog";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { K, dayKey, redis } from "./redis";
import { conn, getCurves, safeErr, CurveView, solUsd, RPS } from "./solana";
import { getMarket } from "./market";
import { readPools, type PoolRead } from "./pool";
import { getSettings, saveSettings } from "./settings";
import { tokenAmounts, progressFromSol, readTape } from "./tape";
import { xMentions } from "./buzz";
import { levelOf, loadRunner, MILESTONES, pNext, RK, Run } from "./runner";
import { NANO_MIN, type NanoModel } from "./nano";
import { agentLog, type AgentEv } from "./agents";
import { coachStats, coachStep, follow, followsFor, tripId, type Check } from "./coach";
import { filmStats, filmStep, logSkip } from "./film";
import { exitProfiles, noteExit, onClose as pmClose, onGhost as pmGhost, pmClearPauses, pmDropWicks, pmView, sleeveOf, sleeveWeight, type ExitProfile } from "./pm";
import { accountOf, notePnl, wireViewPublic } from "./wire";
import { getHistory } from "./historian";
import { enqueueLens, lensDossier } from "./lens";
import { mindJudgement } from "./mind";
import { fastSwap, realDelta, warm, type ExecCfg } from "./exec";
import { momoSignal } from "./momo";
import { buyersOf, CLASS_LABEL } from "./hound";
import { loadModel } from "./digger";
import type { Launch } from "./digger";

export type Agent = "HISTORIAN" | "SCOUT" | "KING" | "TAPE" | "GRAPH" | "VET" | "FLOW" | "BUZZ" | "SIZE" | "EXEC" | "RISK" | "COACH" | "LEDGER" | "FILM" | "WIRE" | "PM" | "PULSE";
export const AGENTS: { id: Agent; role: string }[] = [
  { id: "HISTORIAN", role: "replays past launches to train the models" },
  { id: "SCOUT", role: "digs every launch, early read at minute 1" },
  { id: "KING", role: "calls it at minute 5" },
  { id: "TAPE", role: "reads every trade on the curve" },
  { id: "GRAPH", role: "traces dev funding and smart wallets" },
  { id: "VET", role: "checks dev, bundles, curve" },
  { id: "FLOW", role: "reads buy and sell pressure" },
  { id: "BUZZ", role: "X mentions and paid dex signals" },
  { id: "SIZE", role: "decides how much" },
  { id: "EXEC", role: "buys and sells" },
  { id: "RISK", role: "initials, ladder, trail, insider exits" },
  { id: "COACH", role: "reviews every exit and entry" },
  { id: "LEDGER", role: "keeps the books" },
  { id: "FILM", role: "reviews every decision against what happened next" },
  { id: "WIRE", role: "tracks X accounts, finds coins born from their posts" },
  { id: "PM", role: "splits capital across strategies by results" },
  { id: "PULSE", role: "what X is talking about right now" },
];

export type Tone = "ok" | "bad" | "info" | "win" | "loss";
export type DeskEv = { agent: Agent; at: number; mint?: string; symbol?: string; text: string; tone: Tone };
export type Sample = [number, number, number]; // [time, price SOL, real SOL in curve]
type Watch = { acc: string; role: string; base: number };
export type Pos = {
  mint: string;
  symbol: string;
  name: string;
  openedAt: number;
  entryPx: number;
  costSol: number;
  tokens: number; // tokens still held
  tokens0: number;
  soldSol: number;
  tp1Done: boolean; // initials taken
  sendHit?: boolean; // CATCH send ladder: the target market cap was reached and the runner third sold
  lastPx: number;
  peakPx: number;
  king: number;
  nano: number | null;
  live: boolean;
  series: Sample[];
  how?: "direct" | "stalk" | "early" | "wire" | "mind" | "momo" | "catch" | "flash";
  wire?: { h: string; tid: string; text: string; vamp?: boolean } | null; // the post a tweet coin was born from
  peakAt?: number; // when the price peaked while held (exit profiles)
  tier?: Tier; // market cap tier at entry (exit lab buckets)
  kind?: Kind; // tech or meme (the dev exit is learned per kind)
  msHi?: number; // highest milestone the ladder has acted on
  pn?: number; // P(next milestone) at the last check
  noPxSince?: number; // first beat with no price (curve complete, not migrated yet)
  trail?: number; // current trailing stop width %
  usd?: number; // market cap USD now
  watch?: Watch[]; // insider token accounts and their balance at entry
  ins?: number | null;
  insSold?: number | null; // % of supply the watched insiders sold // insiders' bag now vs entry (1 = untouched)
  dev?: number | null; // dev's bag now vs entry
  gradSeen?: boolean;
  xm?: number | null;
  ctx?: EntryCtx;
  ghost?: string | null; // ghost desk position: why the real desk could not take it
  creator?: string;
  devSellPx?: number; // price when the dev sold past the line while we held (memes: we hold, COACH scores it)
  drainPx?: number; // price when a confirmed sell-off would have fired while that exit is switched off (COACH scores it)
  mkt?: { grad: boolean; real: number }; // venue at the last price read (curve or pool, its SOL): sells are costed on it
  reentry?: boolean; // bought back after a stop-out (its results decide whether re-entries stay on)
};
/** Everything known at the moment of the buy, kept for the public track record and for tuning by hand. */
export type EntryCtx = {
  createdAt: number; // coin launch time
  ageMs: number; // how long the coin existed before the buy
  curve: number | null; // bonding curve % at the buy (null once migrated)
  callAt: number | null;
  callCurve: number | null;
  callMc: number | null; // USD market cap at the call
  chasePct: number | null; // price at the buy vs the price at the call
  king: { score: number; verdict: string } | null;
  nano: { score: number; verdict: string } | null;
  early: { score: number; verdict: string } | null;
  checks: { rule: string; ok: boolean; v: string }[];
  flow: string | null;
  buzz: string | null;
  tape: { n: number; vel: number; uniq: number; organic: number | null; spb: number; buyShare: number; bundle: number; bundleN: number; snipers: number; top5: number; devSold: number } | null;
  graph: { funder: string | null; clN: number; clB: number; clRatio: number; smartN: number } | null;
  dev: { launches: number; bonded: number; buySol: number };
  socials: { x: boolean; tg: boolean; web: boolean };
  meta: { hot: string | null; copy: boolean } | null;
  solUsd: number | null;
  sleeve?: string;
  wire?: { h: string; text: string; how: string; lagSec: number; trust: number } | null;
  // scorecard: the plain-word reasons (public) and the numbers behind them (admin)
  mind?: { verdict: string; conviction: number; thesis: string; narrative: string; reasons: string[]; risks: string[] } | null;
  wallets?: { name: string; cls: string; conf: string; sol: number; minsBefore: number }[] | null;
  card?: { plus: string[]; minus: string[]; parts?: Record<string, number> | null; nc?: [string, number][] | null; lens?: { score: number; flags: string[]; good: string[] } | null };
};
export type Trade = {
  id: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  at: number;
  sol: number;
  tokens: number;
  px: number;
  reason: string;
  pnlSol?: number;
  pnlPct?: number;
  cost?: number; // buys (v0.1.36): what the buy really cost, size plus tip, priority fee, base fee and account rent
  live: boolean;
  sig?: string;
  mc?: number | null; // USD market cap at the fill
  ctx?: EntryCtx; // buys only
};
export type DeskState = {
  live: boolean;
  cash: number; // paper cash
  start: number;
  startedAt: number;
  realized: number;
  closed: number; // positions fully closed
  wins: number;
  dayKey: string;
  dayStart: number;
  peakEq: number;
  maxDD: number; // worst drawdown seen, %
  liveStart: number | null;
  promotedAt: number | null;
  demotions: number;
  lastEqAt: number;
  equity: number;
  wallet?: string | null; // desk wallet the paper run is mirroring
  funded?: number | null; // its balance as last booked (deposits and withdrawals move the start, not the P&L)
  liveBal?: number | null; // live: wallet balance at the last reconcile (deposits and withdrawals are told apart from trades)
};
export type Exam = { trades: number; winRate: number; pnlPct: number; maxDD: number; walletSol: number | null; checks: { label: string; need: string; now: string; ok: boolean }[]; passed: boolean };

// What the desk has learned. Public on /desk.
export const ARMS = [0, 20, 30, 45] as const; // entry arms: 0 = buy now, else wait for a pullback of N% from the high
type Arm = { n: number; sum: number; fills: number };
export type Learn = {
  trailK: number; // COACH scale on every trail width
  reviews: number;
  early: number; // exits followed by a 2x+ run: trail too tight
  late: number; // exits after giving back 40%+ from the peak: trail too loose
  good: number;
  arms: Record<string, Arm>; // mean 30-minute log return per entry arm
  stalkOn: boolean;
  stalkArm: number;
  earlyOn: boolean;
  earlyStat: { n: number; hit: number; mainN: number; mainHit: number };
  // dev sells: on memes the dev selling is normal. The desk holds through it and COACH scores what an exit would have done.
  devExitOn: boolean;
  devStat: { n: number; saved: number; cost: number }; // trades where the dev sold while held: an exit then would have saved / cost
  drainBy?: Record<string, DevRec>; // the sell-off exit, learned per strategy: on while selling into a sell-off beats holding
  devBy?: Record<Kind, DevRec>; // the same, learned separately for tech coins and memes
  // PRIOR "holding floor": skip a coin that already dumped far from its high. A starting hint from the dev, not a law:
  // every coin it skips is followed in shadow, and COACH drops the rule if those coins do better than the ones bought.
  floorOn: boolean;
  floor: { n: number; sum: number; sq?: number }; // skipped-for-dump signals: count, summed 30-minute log return, sum of squares
  // PRIOR "socials": a coin with no X, website or Telegram is usually a quick rug, unless it is tied to a tweet.
  // Same deal as the floor: skipped coins are followed in shadow and COACH drops the prior if they do better.
  socialsOn: boolean;
  socials: { n: number; sum: number; sq?: number };
  // PRIOR "post traction": a tweet coin only counts when its post spawned a wave (3+ coins or 25+ SOL across them).
  // Most headlines move nothing. Skipped tweet coins are followed in shadow; COACH drops the prior if they do better.
  tractionOn: boolean;
  traction: { n: number; sum: number; sq?: number };
  // PRIOR "curve window" (v0.1.31): skip a King call whose curve is already past maxCurve at the call (it dumps at
  // migration more often than not). $FLY was skipped for this at 74% and ran 54x; COACH now learns whether it helps.
  curveHiOn: boolean;
  curveHi: { n: number; sum: number; sq?: number };
  // trail scale per strategy sleeve (tweet coins and vamps dump fast after the first push; King calls can run)
  trailBy: Record<string, number>;
};
export const LEARN_RULES = {
  devMin: 15, // dev-sell cases before the dev exit can switch itself on
  drainMin: 10, // sell-off cases per strategy before the sell-off exit can switch itself off (or back on)
  drainSaved: 0.5, // share of cases where selling into the sell-off beat holding
  devSaved: 0.6, // share of cases where selling with the dev beat holding
  floorMax: 40, // % under the coin's high (since launch) where the floor prior skips it
  floorMin: 30, // skipped cases before COACH can overrule the floor prior
  floorEdge: 0.05, // skipped coins must beat bought coins by this much (30-minute log return) to overrule it
  socialsMin: 30, // skipped no-socials cases before COACH can overrule the socials prior
  socialsEdge: 0.05,
  tractionMin: 20, // skipped low-traction tweet coins before COACH can overrule the traction prior
  tractionEdge: 0.05,
  curveHiMin: 20, // skipped late-curve King calls before COACH can overrule the curve window
  curveHiEdge: 0.05,
  stalkMin: 30, // shadow signals before pullback entries can unlock
  stalkEdge: 0.1, // mean log return must beat buying now by this much (about +10%)
  earlyMin: 50, // resolved minute-1 BOND reads before early entries can unlock
  shadowMins: 30,
  coachHours: 6,
};
function emptyLearn(): Learn {
  return {
    trailK: 1,
    reviews: 0,
    early: 0,
    late: 0,
    good: 0,
    arms: Object.fromEntries(ARMS.map((a) => [String(a), { n: 0, sum: 0, fills: 0 }])),
    stalkOn: false,
    stalkArm: 0,
    earlyOn: false,
    earlyStat: { n: 0, hit: 0, mainN: 0, mainHit: 0 },
    devExitOn: false,
    devStat: { n: 0, saved: 0, cost: 0 },
    devBy: { tech: { n: 0, saved: 0, cost: 0, on: true }, meme: { n: 0, saved: 0, cost: 0, on: false } },
    floorOn: true,
    floor: { n: 0, sum: 0 },
    socialsOn: true,
    socials: { n: 0, sum: 0 },
    tractionOn: true,
    traction: { n: 0, sum: 0 },
    curveHiOn: true,
    curveHi: { n: 0, sum: 0 },
    trailBy: {},
  };
}

type ArmTrack = { hi: number; lo: number; armed: boolean; fill: number | null };
type Shadow = { k: string; mint: string; symbol: string; at: number; px0: number; hi: number; lo: number; last: number; early: boolean; arms: Record<string, ArmTrack>; tag?: "floor" | "socials" | "traction" | "curvehi" };
type After = { mint: string; symbol: string; at: number; exitPx: number; peakHeld: number; reason: string; hi: number; lo: number; tunable: boolean; sl?: string; entryPx?: number; openedAt?: number; tier?: Tier; pts?: [number, number][]; reviewed?: boolean; devExit?: Kind; drainExit?: string; noq?: number; cost?: number };
// A dev-sell or sell-off moment, scored the same way whether the desk sold or held: the price 30 minutes later against
// the price at that moment. Before v0.1.31 a hold was scored on our later exit price and a sell on whether the coin ran
// 30% within hours, so the two sides of one switch were measured differently.
type Case = { kind: "dev" | "drain"; key: string; mint: string; symbol: string; at: number; px0: number; sold: boolean };
const CASES = "rn:desk:cases";
// v0.1.43: `how` and `rec` for MOMO's pullback entries (a MOMO coin may never have been dug, so its record rides along)
type Stalk = { mint: string; symbol: string; at: number; px0: number; depth: number; hi: number; lo: number; armed: boolean; early: boolean; how?: "momo"; rec?: Launch; mins?: number };

// the desk lock lives this long past its last renewal (one pass, including a swap waiting for confirmation)
const LOCK_MS = 75_000;

export const EXAM = { trades: 30, winRate: 40, pnlPct: 10, pfLessBest: 1.2, maxDD: 30, minWallet: 0.5, liveMaxDD: 40 };
// v0.1.31: paper pays what live pays (lib/costs.ts): venue fee by curve or pool tier, Jito tip, priority fee, base fee,
// token-account rent (refunded when the account closes on the full exit), and slippage from the trade's size against
// the curve or pool plus a latency slip. Before, a flat 1% fee and 2% slip per side and no fixed costs.
let COST: CostCfg = {};
const WSOL = "So11111111111111111111111111111111111111112";
// twice a second whatever the plan: prices come from the stream between the 10s chain checks (v0.1.28)
const LOOP_MS = RPS >= 5 ? 500 : 1000;
const SUPPLY = 1e9; // pump.fun tokens have a fixed 1B supply

// ---------------------------------------------------------------- state

async function loadState(start: number): Promise<DeskState> {
  const s = await redis().get<DeskState>(K.deskState);
  if (s) return s;
  return { live: false, cash: start, start, startedAt: Date.now(), realized: 0, closed: 0, wins: 0, dayKey: dayKey(), dayStart: start, peakEq: start, maxDD: 0, liveStart: null, promotedAt: null, demotions: 0, lastEqAt: 0, equity: start };
}
async function loadLearn(): Promise<Learn> {
  const l = await redis().get<Learn>(K.deskLearn);
  const e = emptyLearn();
  return l ? { ...e, ...l, arms: { ...e.arms, ...(l.arms || {}) }, earlyStat: { ...e.earlyStat, ...(l.earlyStat || {}) }, devStat: { ...e.devStat, ...(l.devStat || {}) }, floor: { ...e.floor, ...(l.floor || {}) }, floorOn: l.floorOn ?? e.floorOn, socials: { ...e.socials, ...(l.socials || {}) }, socialsOn: l.socialsOn ?? e.socialsOn, traction: { ...e.traction, ...(l.traction || {}) }, tractionOn: l.tractionOn ?? e.tractionOn, curveHi: { ...e.curveHi, ...(l.curveHi || {}) }, curveHiOn: l.curveHiOn ?? e.curveHiOn, trailBy: { ...(l.trailBy || {}) }, drainBy: { ...(l.drainBy || {}) }, devBy: { tech: { ...e.devBy!.tech, ...(l.devBy?.tech || {}) }, meme: { ...e.devBy!.meme, ...(l.devBy?.meme || {}), ...(l.devBy?.meme ? {} : { on: !!l.devExitOn }) } } } : e;
}

/** The paper desk mirrors the real desk wallet, so the start on the site is the real balance. */
async function syncWallet(state: DeskState, kp: Keypair | null, walletSol: number | null, minSol: number, b: Batch): Promise<DeskState> {
  if (!kp || walletSol == null || state.live) return state;
  const addr = kp.publicKey.toBase58();
  if (walletSol < minSol) {
    if (state.wallet !== addr) {
      state.wallet = addr;
      state.funded = walletSol;
      log(b, "LEDGER", `desk wallet ${addr.slice(0, 4)}…${addr.slice(-4)} found with ${walletSol.toFixed(4)} SOL: too little to trade. paper stays on its own start until it is funded`, "info");
    }
    return state;
  }
  if (state.wallet !== addr || state.funded == null || state.funded < minSol) {
    // new (or newly funded) wallet: fresh paper run from the real balance; old paper trades used other rules/sizes
    const r = redis();
    await r.del(K.deskPos, K.deskTrades, K.deskEq, K.deskShadow, K.deskStalk, K.deskAfter, K.deskVet);
    await r.incrby(SEQ.trades, 1_000_000); // v0.1.41: change counters jump on a reset, never restart (lib/lcache.ts)
    SHM = null;
    AFM = null;
    listDrop(K.deskTrades);
    const now = Date.now();
    const fresh: DeskState = { live: false, cash: walletSol, start: walletSol, startedAt: now, realized: 0, closed: 0, wins: 0, dayKey: dayKey(), dayStart: walletSol, peakEq: walletSol, maxDD: 0, liveStart: null, promotedAt: null, demotions: state.demotions || 0, lastEqAt: 0, equity: walletSol, wallet: addr, funded: walletSol };
    log(b, "LEDGER", `desk wallet ${addr.slice(0, 4)}…${addr.slice(-4)} holds ${walletSol.toFixed(4)} SOL. paper desk restarted from that real balance`, "win");
    return fresh;
  }
  const d = walletSol - state.funded;
  if (Math.abs(d) >= 0.001) {
    state.start += d;
    state.cash += d;
    state.dayStart += d;
    state.peakEq += d;
    state.equity += d;
    state.funded = walletSol;
    log(b, "LEDGER", `${d > 0 ? "deposit" : "withdrawal"} of ${Math.abs(d).toFixed(4)} SOL on the desk wallet. start moved to ${state.start.toFixed(4)} SOL (not counted as profit)`, "info");
  }
  return state;
}

const RESET_KEY = "rn:desk:resetat";
/**
 * Start the paper desk over: books, positions, trades and the track record. What the desk learned stays (COACH, the
 * exit lab, PM, priors, FILM). The old track record is kept under rn:desk:trips:<date> for reference.
 */
export async function resetDesk(why = "manual") {
  const r = redis();
  const s = await getSettings();
  await r.set(RESET_KEY, Date.now());
  const old = await r.lrange(TRIPS_KEY, 0, 999).catch(() => [] as unknown[]);
  if (old && old.length) {
    const arch = `rn:desk:trips:${new Date().toISOString().slice(0, 16)}`;
    await r.rpush(arch, ...(old as any[]));
    await r.expire(arch, 60 * 86400);
  }
  POSC[K.deskPos]?.clear();
  await r.del(K.deskState, K.deskPos, K.deskTrades, K.deskEv, K.deskQ, K.deskEq, K.deskAgent, K.deskVet, K.deskStalk, TRIPS_KEY, EXAM_FULL, K.deskExam);
  await r.incrby(SEQ.trades, 1_000_000);
  await r.incrby(SEQ.trips, 1_000_000);
  listDrop(K.deskTrades);
  listDrop(TRIPS_KEY);
  await r.lpush(K.deskEv, { agent: "LEDGER", at: Date.now(), text: `paper desk reset (${why}). what it learned is kept`, tone: "info" });
  await loadState(s.desk.start);
}
/**
 * v0.1.31 one-time data fix: trades "sold" on a false print (a side-pool trade at an absurd price, like $XP's $1.7B
 * wick on 7 Oct) are taken out of everything the desk learns from: exit-lab paths, PM's ghost results, CATCH's stage
 * results and the ghost book's record.
 */
export async function dropWicksOnce() {
  const r = redis();
  if (!(await r.set("rn:fix:wick:0.1.31", Date.now(), { nx: true }))) return null;
  const paths = await dropPaths((p) => (p.pts || []).some(([, x]) => x > 100)).catch(() => 0);
  const pm = await pmDropWicks().catch(() => 0);
  for (const stage of ["curve", "pool"] as const) {
    const xs = ((await r.lrange<number>(STAGE_RES(stage), 0, -1)) || []).map(Number);
    const keep = xs.filter((x) => x < 5000);
    if (keep.length !== xs.length) {
      await r.del(STAGE_RES(stage));
      if (keep.length) await r.rpush(STAGE_RES(stage), ...keep);
    }
  }
  const trades = ((await r.lrange<Trade>(GHOST_TRADES, 0, -1)) || []) as Trade[];
  const bad = new Set(trades.filter((t) => t.side === "sell" && (t.pnlPct ?? 0) > 5000).map((t) => t.mint));
  if (bad.size) {
    const keep = trades.filter((t) => !bad.has(t.mint));
    await r.del(GHOST_TRADES);
    await r.incrby(SEQ.gtrades, 1_000_000);
    await r.incrby(SEQ.gtrips, 1_000_000);
    if (keep.length) await r.rpush(GHOST_TRADES, ...keep);
    const trips = ((await r.lrange<TripMeta>(GHOST_TRIPS, 0, -1)) || []) as TripMeta[];
    const keepT = trips.filter((t) => !bad.has(t.mint));
    await r.del(GHOST_TRIPS);
    if (keepT.length) await r.rpush(GHOST_TRIPS, ...keepT);
  }
  const text = `data fix: false prints removed from learning (${paths} exit-lab paths, ${pm} PM ghost results, ${bad.size} ghost trades)`;
  await r.lpush(K.deskEv, { agent: "LEDGER", at: Date.now(), text, tone: "info" });
  return text;
}
/**
 * v0.1.40 one-time slimming: buy rows in the trade lists carried their whole entry context (checks, card, LENS), a
 * few KB each, read again with every list read. The round trips (rn:desk:trips) and open positions keep that context;
 * the trade rows no longer need it.
 */
export async function slimTradesOnce() {
  const r = redis();
  if (!(await r.set("rn:fix:slim:0.1.40", Date.now(), { nx: true }))) return null;
  let n = 0;
  for (const [key, seq] of [[K.deskTrades, SEQ.trades], [GHOST_TRADES, SEQ.gtrades]] as const) {
    const rows = ((await r.lrange<Trade>(key, 0, 1999)) || []) as Trade[];
    if (!rows.some((t) => t.ctx)) continue;
    const slim = rows.map(({ ctx, ...t }) => t);
    const m = r.multi();
    m.del(key);
    m.rpush(key, ...slim);
    m.incrby(seq, 1_000_000);
    await m.exec();
    listDrop(key);
    n += rows.length;
  }
  return n;
}
/** v0.1.31: one reset so the exam measures the honest desk (real costs, fresh fills) from zero. */
export async function resetOnceForCosts() {
  const r = redis();
  if (await r.get("rn:desk:reset:0.1.31")) return false;
  // never while real money is in play
  const st = await r.get<DeskState>(K.deskState);
  if (st?.live) return false;
  if (!(await r.set("rn:desk:reset:0.1.31", Date.now(), { nx: true }))) return false;
  await resetDesk("v0.1.31: paper now pays live costs");
  return true;
}

/**
 * v0.1.39 (Run 8, final verification): one clean paper start, so the exam measures only the desk as it is after all
 * eight audit runs. Same rules as the v0.1.31 reset: never while live, once, the old record archived, everything
 * learned kept; strategies paused before the reset start unpaused.
 */
export async function resetOnceForFinal() {
  const r = redis();
  if (await r.get("rn:desk:reset:0.1.39")) return false;
  const st = await r.get<DeskState>(K.deskState);
  if (st?.live) return false;
  if (!(await r.set("rn:desk:reset:0.1.39", Date.now(), { nx: true }))) return false;
  await resetDesk("v0.1.39: clean start for the final verification run");
  await pmClearPauses().catch(() => null);
  return true;
}

/**
 * v0.1.43 (Run 11): one paper restart with the new entries (King needs nano, MOMO buys pullbacks, no falling coins).
 * Same rules as before: never while live, once, the old record archived, everything learned kept, PM pauses cleared.
 * The saved settings get needNano on, and mode "auto" becomes "paper": the desk no longer goes live by itself when the
 * exam passes (Admin > desk mode "live" or "auto" to allow it).
 */
export async function resetOnceForNano() {
  const r = redis();
  if (await r.get("rn:desk:reset:0.1.43")) return false;
  const st = await r.get<DeskState>(K.deskState);
  if (st?.live) return false;
  if (!(await r.set("rn:desk:reset:0.1.43", Date.now(), { nx: true }))) return false;
  const cur = await getSettings();
  await saveSettings({ desk: { ...cur.desk, needNano: true, mode: cur.desk.mode === "auto" ? "paper" : cur.desk.mode } });
  await resetDesk("v0.1.43: King needs nano, MOMO buys pullbacks, no buys into a falling coin");
  await pmClearPauses().catch(() => null);
  return true;
}

/**
 * The desk wallet's key lives on the worker (Railway) only. On Vercel it is ignored unless DESK_ON_VERCEL=1: a web
 * function never needs to sign, and a key there is one more place it can leak from (v0.1.33).
 */
function wallet(): Keypair | null {
  const sec = process.env.DESK_WALLET_SECRET;
  if (!sec) return null;
  if (process.env.VERCEL && process.env.DESK_ON_VERCEL !== "1") return null;
  try {
    return Keypair.fromSecretKey(sec.trim().startsWith("[") ? Uint8Array.from(JSON.parse(sec)) : bs58.decode(sec.trim()));
  } catch {
    return null;
  }
}
export function deskWalletAddress() {
  return wallet()?.publicKey.toBase58() || null;
}

// ---------------------------------------------------------------- jupiter (live execution)

const JUP = process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
const jupHeaders = (): Record<string, string> => (process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {});

let EXEC_CFG: ExecCfg = {};
/** Live swap: the fast path in lib/exec.ts (own tx, Helius priority fee, Jito tip, Sender), Jupiter's tx as fallback. */
// Open positions live in this process's memory between beats and go to Redis at most every 10s (at once after a trade).
// Each position carries its price path (up to 360 points, ~20KB): reading every position and ghost and writing each one
// back twice a second was most of the Upstash bandwidth that took the site down on 7 Oct. The desk lock makes this
// process the only writer, so the memory copy is the truth; a key removed in Redis (a reset) is dropped here too.
const POSC: Record<string, Map<string, Pos>> = {};
const WROTE = new Map<string, number>();
// v0.1.31: a position's price path lives in its own list (append only); the position itself is written without it.
// Before, the whole path (up to 360 points) went back to Redis with every write of every position.
const SER = (key: string, mint: string) => `${key}:ser:${mint}`;
const SER_AT = new Map<string, number>(); // newest point already in the list
/** Fill in the price paths of positions read from Redis (pages and a fresh process). */
// v0.1.40: the pages read each position's price path (up to 360 points) at most once a minute per server instance;
// it only draws a sparkline. The worker always reads them fresh (its desk appends to them).
const SER_CACHE = new Map<string, { at: number; v: Sample[] }>();
export async function withSeries(key: string, pos: Record<string, Pos> | null, display = false) {
  const ms0 = Object.keys(pos || {}).filter((m) => !(pos![m].series || []).length);
  if (!ms0.length) return pos || {};
  // v0.1.41: display reads (pages, the worker's page summaries) may use the 60s copy; the desk itself never does
  const site = display || process.env.RATNET_WORKER !== "1";
  const now = Date.now();
  if (site) {
    for (const m of ms0) {
      const c = SER_CACHE.get(`${key}|${m}`);
      if (c && now - c.at < 60_000 && c.v.length) pos![m].series = c.v;
    }
    if (SER_CACHE.size > 500) SER_CACHE.clear();
  }
  const ms = ms0.filter((m) => !(pos![m].series || []).length);
  if (!ms.length) return pos || {};
  const p = redis().pipeline();
  for (const m of ms) p.lrange(SER(key, m), 0, -1);
  const got = ((await p.exec().catch(() => [])) || []) as Sample[][];
  if (site) ms.forEach((m, i) => Array.isArray(got[i]) && got[i].length && SER_CACHE.set(`${key}|${m}`, { at: now, v: got[i] }));
  ms.forEach((m, i) => {
    const ser = Array.isArray(got[i]) ? got[i] : [];
    if (ser.length) pos![m].series = ser;
  });
  return pos || {};
}
async function loadPositions(key: string): Promise<Record<string, Pos>> {
  const r = redis();
  const m = (POSC[key] ||= new Map());
  const keys = ((await r.hkeys(key)) || []) as string[];
  const ks = new Set(keys);
  for (const k of Array.from(m.keys())) if (!ks.has(k)) m.delete(k);
  const miss = keys.filter((k) => !m.has(k));
  if (miss.length) {
    const got = ((await r.hmget<Record<string, Pos>>(key, ...miss)) || {}) as Record<string, Pos | null>;
    const fresh: Record<string, Pos> = {};
    for (const k of miss) if (got[k]) fresh[k] = got[k] as Pos;
    await withSeries(key, fresh);
    for (const [k, p] of Object.entries(fresh)) {
      m.set(k, p);
      const last = p.series?.[p.series.length - 1];
      if (last) SER_AT.set(`${key}|${k}`, last[0]);
    }
  }
  return Object.fromEntries(m);
}
async function savePos(key: string, p: Pos, force = false) {
  (POSC[key] ||= new Map()).set(p.mint, p);
  const w = `${key}|${p.mint}`;
  if (!force && Date.now() - (WROTE.get(w) || 0) < 10_000) return;
  WROTE.set(w, Date.now());
  const r = redis();
  const at = SER_AT.get(w) ?? 0;
  const add = (p.series || []).filter((x) => x[0] > at);
  const pipe = r.pipeline();
  if (add.length) {
    pipe.rpush(SER(key, p.mint), ...add);
    pipe.ltrim(SER(key, p.mint), -360, -1);
    pipe.expire(SER(key, p.mint), 14 * 86400);
    SER_AT.set(w, add[add.length - 1][0]);
  }
  pipe.hset(key, { [p.mint]: { ...p, series: [] } });
  await pipe.exec();
}
async function dropPos(key: string, mint: string) {
  POSC[key]?.delete(mint);
  WROTE.delete(`${key}|${mint}`);
  SER_AT.delete(`${key}|${mint}`);
  await redis().hdel(key, mint);
  await redis().del(SER(key, mint)).catch(() => 0);
}
// v0.1.40: the shadow and COACH-after books in memory (see the slow pass). New entries go to both; deletes to both;
// updates reach Redis every 2 minutes and at the end of every desk session.
let SHM: Record<string, Shadow> | null = null;
let AFM: Record<string, After> | null = null;
let shafSavedAt = 0;
async function loadShaf() {
  if (SHM && AFM) return;
  const r = redis();
  const [sh, af] = await Promise.all([r.hgetall<Record<string, Shadow>>(K.deskShadow), r.hgetall<Record<string, After>>(K.deskAfter)]);
  SHM = (sh || {}) as Record<string, Shadow>;
  AFM = (af || {}) as Record<string, After>;
  shafSavedAt = Date.now();
}
async function setShadow(r: ReturnType<typeof redis>, k: string, sh: Shadow) {
  await r.hset(K.deskShadow, { [k]: sh });
  if (SHM) SHM[k] = sh;
}
async function setAfter(r: ReturnType<typeof redis>, k: string, a: After) {
  await r.hset(K.deskAfter, { [k]: a });
  if (AFM) AFM[k] = a;
}
async function flushShaf() {
  if (!SHM || !AFM) return;
  const p = redis().pipeline();
  if (Object.keys(SHM).length) p.hset(K.deskShadow, SHM);
  if (Object.keys(AFM).length) p.hset(K.deskAfter, AFM);
  await p.exec();
  shafSavedAt = Date.now();
}

/** Write every position held in memory (end of a desk session). */
async function flushPositions() {
  for (const [key, m] of Object.entries(POSC)) for (const p of Array.from(m.values())) await savePos(key, p, true).catch(() => {});
}

// the full exam, cached for the pages (rn:desk:exam is the homepage's short summary: v0.1.26 cached the full exam
// under that same key, the two overwrote each other and /desk crashed on an exam without its checks)
const EXAM_FULL = "rn:desk:examfull";
const PENDING = "rn:desk:pending"; // live swaps sent and not yet booked
let LIVE_FLOW = 0; // live: SOL in/out from trades since the last balance reconcile
let LAST_BAL: { sol: number; at: number } | null = null;
let RECON_AT = 0;

/**
 * Live only (v0.1.33). Every balance read: SOL that moved without a trade is a deposit or a withdrawal, and moves the
 * drawdown baseline instead of the P&L. Every 5 minutes, and at once when a swap was left pending: the wallet's token
 * accounts against the open positions. A position the wallet no longer holds is closed in the books, a different
 * amount is corrected, and tokens the books don't know are reported.
 */
async function liveReconcile(b: Batch, state: DeskState, kp: Keypair, bal: number) {
  const { swapsInFlight } = await import("./exec");
  if (swapsInFlight() > 0) return;
  const r = redis();
  const pend = ((await r.hgetall<Record<string, { mint: string; side: string; at: number }>>(PENDING).catch(() => null)) || {}) as Record<string, { mint: string; side: string; at: number }>;
  const stalePend = Object.values(pend).filter((x) => Date.now() - x.at > 180_000);
  if (state.liveBal != null && !Object.keys(pend).length) {
    const ext = bal - (state.liveBal + LIVE_FLOW);
    if (Math.abs(ext) > 0.01) {
      state.liveStart = (state.liveStart ?? bal) + ext;
      state.peakEq += ext;
      log(b, "LEDGER", `${ext > 0 ? "deposit" : "withdrawal"} of ${Math.abs(ext).toFixed(3)} SOL seen in the wallet: the drawdown baseline moved with it, not the P&L`, "info");
    }
  }
  state.liveBal = bal;
  LIVE_FLOW = 0;
  if (Date.now() - RECON_AT < 5 * 60_000 && !stalePend.length) return;
  RECON_AT = Date.now();
  const owned: Record<string, number> = {};
  for (const prog of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
    const res = await conn().getParsedTokenAccountsByOwner(kp.publicKey, { programId: new PublicKey(prog) });
    for (const a of res.value) {
      const info: any = (a.account.data as any)?.parsed?.info;
      if (info?.mint) owned[info.mint] = (owned[info.mint] || 0) + Number(info.tokenAmount?.uiAmount || 0);
    }
  }
  const pos = Object.values(await loadPositions(K.deskPos)).filter((p) => p.live);
  for (const p of pos) {
    const w = owned[p.mint] ?? 0;
    if (w <= 0) {
      log(b, "LEDGER", `$${p.symbol}: the wallet holds none of it any more. closed in the books (check the last sell on Solscan)`, "bad", p);
      await dropPos(K.deskPos, p.mint);
    } else if (Math.abs(w - p.tokens) > p.tokens * 0.01) {
      log(b, "LEDGER", `$${p.symbol}: the wallet holds ${w.toFixed(0)} tokens, the books said ${p.tokens.toFixed(0)}. books corrected`, "info", p);
      p.tokens = w;
      await savePos(K.deskPos, p, true);
    }
  }
  const known = new Set(pos.map((p) => p.mint));
  const unknown = Object.entries(owned).filter(([m, a]) => a > 0 && !known.has(m) && m !== WSOL);
  if (unknown.length) log(b, "LEDGER", `${unknown.length} token${unknown.length > 1 ? "s" : ""} in the wallet the books don't hold (airdrops, or a buy that was never booked): ${unknown.slice(0, 3).map(([m]) => m.slice(0, 6)).join(", ")}`, "info");
  if (stalePend.length) await r.hdel(PENDING, ...stalePend.map((x) => x.mint)).catch(() => 0);
}

let DESK_LOCK: Lock | null = null;
let DESK_LOST = false;
/** Throws unless this process holds the desk lock right now (checked with Redis before every real-money swap). */
async function mustHoldDesk() {
  if (!DESK_LOCK || DESK_LOST || !(await holds(DESK_LOCK))) {
    DESK_LOST = true;
    throw new Error("desk lock lost: swap refused (another desk may be running)");
  }
}
async function swap(kp: Keypair, inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number) {
  await mustHoldDesk();
  // a pending record before anything is sent: a process that dies mid-swap leaves it, and the next session reconciles
  // the wallet before it trades again
  const mint = inputMint === WSOL ? outputMint : inputMint;
  await redis().hset(PENDING, { [mint]: { mint, side: inputMint === WSOL ? "buy" : "sell", at: Date.now() } }).catch(() => {});
  let res: Awaited<ReturnType<typeof fastSwap>>;
  try {
    res = await fastSwap(kp, inputMint, outputMint, amountRaw, slippageBps, EXEC_CFG);
  } catch (e) {
    // an expired tx provably never landed; anything else (unknown state) keeps the pending record for the reconcile
    if (/expired without landing|no route|swap build failed|refused|unexpected|not the desk wallet|does not go/i.test(String((e as any)?.message || e))) await redis().hdel(PENDING, mint).catch(() => 0);
    throw e;
  }
  await redis().hdel(PENDING, mint).catch(() => 0);
  LAST_EXEC = { ms: res.ms, landedMs: res.landedMs, path: res.path, tipSol: res.tipSol, at: Date.now() };
  await redis().lpush("rn:exec:log", LAST_EXEC).catch(() => {});
  await redis().ltrim("rn:exec:log", 0, 99).catch(() => {});
  return res;
}
let LAST_EXEC: { ms: number; landedMs: number; path: string; tipSol: number; at: number } | null = null;

/**
 * After a full live exit, close the empty token account: its rent (~0.002 SOL) comes back to the wallet. Paper books
 * the same refund (lib/costs.ts). Best effort: a failure costs nothing but the rent staying parked.
 */
async function closeEmptyAccount(kp: Keypair, mint: string) {
  await mustHoldDesk();
  const info = await conn().getAccountInfo(new PublicKey(mint)).catch(() => null);
  if (!info) return false;
  const prog = info.owner; // classic token program or Token-2022
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), kp.publicKey, false, prog);
  if ((await tokenBalanceRaw(kp.publicKey, mint)) > 0n) return false;
  const tx = new Transaction().add(createCloseAccountInstruction(ata, kp.publicKey, kp.publicKey, [], prog));
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
  tx.sign(kp);
  await conn().sendRawTransaction(tx.serialize(), { skipPreflight: false });
  return true;
}

async function tokenBalanceRaw(owner: PublicKey, mint: string): Promise<bigint> {
  const res = await conn().getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  return res.value.reduce((a, acc: any) => a + BigInt(acc.account.data.parsed?.info?.tokenAmount?.amount || "0"), 0n);
}

// ---------------------------------------------------------------- logging

type Batch = { ev: DeskEv[]; trades: Trade[]; ghost?: Trade[] };
function log(b: Batch, agent: Agent, text: string, tone: Tone = "info", coin?: { mint: string; symbol: string }) {
  b.ev.push({ agent, at: Date.now(), text, tone, mint: coin?.mint, symbol: coin?.symbol });
}
async function flushLog(b: Batch) {
  if (!b.ev.length && !b.trades.length && !b.ghost?.length) return;
  const p = redis().pipeline();
  if (b.ev.length) {
    p.lpush(K.deskEv, ...b.ev);
    p.ltrim(K.deskEv, 0, 299);
    agentLog(p, b.ev as AgentEv[]);
    // the Rat Cam and the main feed show desk moves too
    const feed = b.ev
      .filter((e) => e.agent === "EXEC" || e.agent === "RISK" || e.agent === "COACH" || (e.agent === "LEDGER" && e.tone !== "info"))
      .map((e) => ({ kind: "desk", rat: `DESK·${e.agent}`, mint: e.mint || "", symbol: e.symbol || "", name: "", at: e.at, text: e.text }));
    if (feed.length) {
      p.lpush(K.feed, ...feed);
      p.ltrim(K.feed, 0, 299);
    }
  }
  if (b.trades.length) {
    p.lpush(K.deskTrades, ...b.trades);
    p.ltrim(K.deskTrades, 0, 1999); // the full public track record
    p.incr(SEQ.trades);
  }
  if (b.ghost?.length) {
    p.lpush(GHOST_TRADES, ...b.ghost);
    p.ltrim(GHOST_TRADES, 0, 1999);
    p.incr(SEQ.gtrades);
  }
  await p.exec();
  b.ev = [];
  b.trades = [];
  b.ghost = [];
}

const pct = (a: number, b: number) => (b ? ((a - b) / b) * 100 : 0);
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const usdS = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `$${Math.round(n / 1000)}K`);

// ---------------------------------------------------------------- exam

/** The desk wallet's SOL for the pages: one chain read per 20s for every visitor, and a failed read shows the last
 * known balance instead of 0 (which flipped the exam's funded-wallet check to red for a moment). */
async function cachedBalance(addr: string): Promise<number | null> {
  const r = redis();
  const c = await r.get<{ at: number; sol: number }>("rn:desk:wsol").catch(() => null);
  if (c && Date.now() - c.at < 20_000) return c.sol;
  const lam = await conn().getBalance(new PublicKey(addr)).catch(() => null);
  if (lam == null) return c?.sol ?? null;
  const sol = lam / 1e9;
  await r.set("rn:desk:wsol", { at: Date.now(), sol }, { ex: 3600 }).catch(() => {});
  return sol;
}

export async function exam(state: DeskState, walletSol: number | null): Promise<Exam> {
  // a round trip is a closed position: bought, then sold to the last token. A position still open after its initials
  // does not count yet (before v0.1.24 its first partial sell did, so the exam ran ahead of the track record), and a
  // coin bought twice counts twice. Only paper trades since this desk's start count.
  const [all0, openMints] = await Promise.all([deskTrades(), redis().hkeys(K.deskPos).catch(() => [] as string[])]);
  const all = ((all0 || []) as Trade[]).filter((t) => !t.live && t.at >= (state.startedAt || 0)).sort((a, b) => a.at - b.at);
  const open = new Set(openMints || []);
  const list: { mint: string; pnl: number; sells: number; at: number }[] = [];
  const cur: Record<string, { mint: string; pnl: number; sells: number; at: number }> = {};
  for (const t of all) {
    if (t.side === "buy") {
      cur[t.mint] = { mint: t.mint, pnl: 0, sells: 0, at: t.at };
      list.push(cur[t.mint]);
    } else if (t.side === "sell" && t.pnlSol != null) {
      const rd = cur[t.mint] || (cur[t.mint] = { mint: t.mint, pnl: 0, sells: 0, at: t.at });
      if (!list.includes(rd)) list.push(rd);
      rd.pnl += t.pnlSol || 0;
      rd.sells++;
      rd.at = t.at;
    }
  }
  const rounds = list
    .filter((rd) => rd.sells > 0 && !(open.has(rd.mint) && cur[rd.mint] === rd))
    .sort((a, b) => b.at - a.at)
    .map((rd) => rd.pnl);
  // v0.1.31: every check is measured on the same window, the last 30 round trips (before: win rate over 50, profit
  // all time on marked-to-mid equity, drawdown over 30). Profit is realized SOL over the window against the start,
  // and it has to hold without the single best trade: one lucky 10x can no longer pass the exam alone.
  const last = rounds.slice(0, EXAM.trades);
  const wins = last.filter((x) => x > 0).length;
  const winRate = last.length ? (wins / last.length) * 100 : 0;
  const base = state.start || 1;
  const sum = last.reduce((a, x) => a + x, 0);
  const pnlPct = (sum / base) * 100;
  const best = last.length ? Math.max(...last) : 0;
  const gross = (xs: number[]) => [xs.filter((x) => x > 0).reduce((a, x) => a + x, 0), -xs.filter((x) => x < 0).reduce((a, x) => a + x, 0)];
  const lessBest = last.slice();
  if (lessBest.length) lessBest.splice(lessBest.indexOf(best), 1);
  const [gw, gl] = gross(lessBest);
  const pfLessBest = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;
  // worst drawdown over the same 30 round trips, on realized results in order
  let run = 0;
  let peakR = 0;
  let dd30 = 0;
  for (const x of last.slice().reverse()) {
    run += x;
    peakR = Math.max(peakR, run);
    dd30 = Math.max(dd30, ((peakR - run) / (base + peakR)) * 100);
  }
  const checks = [
    { label: "paper round trips", need: `≥ ${EXAM.trades}`, now: String(rounds.length), ok: rounds.length >= EXAM.trades },
    { label: `win rate (last ${EXAM.trades})`, need: `≥ ${EXAM.winRate}%`, now: `${winRate.toFixed(0)}%`, ok: last.length >= EXAM.trades && winRate >= EXAM.winRate },
    { label: `realized profit (last ${EXAM.trades}, after every cost)`, need: `≥ +${EXAM.pnlPct}%`, now: fmtPct(pnlPct), ok: last.length >= EXAM.trades && pnlPct >= EXAM.pnlPct },
    { label: "profit factor without the best trade", need: `≥ ${EXAM.pfLessBest}`, now: pfLessBest >= 99 ? "no losses" : pfLessBest.toFixed(2), ok: last.length >= EXAM.trades && pfLessBest >= EXAM.pfLessBest },
    { label: `worst drawdown (last ${EXAM.trades})`, need: `≤ ${EXAM.maxDD}%`, now: `${dd30.toFixed(0)}%`, ok: dd30 <= EXAM.maxDD },
    { label: "funded wallet", need: `≥ ${EXAM.minWallet} SOL`, now: walletSol == null ? "none" : `${walletSol.toFixed(2)} SOL`, ok: walletSol != null && walletSol >= EXAM.minWallet },
  ];
  return { trades: rounds.length, winRate, pnlPct, maxDD: Math.round(dd30 * 10) / 10, walletSol, checks, passed: checks.every((c) => c.ok) };
}

// ---------------------------------------------------------------- prices

// src "dex": DexScreener's price, used only so a position is never blind. It never counts as a migration (grad false
// unless the curve itself said complete) and is never used to cost a trade or to learn from.
export type Px = { px: number; real: number; curve: CurveView | null; grad: boolean; src?: "dex" };
// Each position is checked on the chain at most every 10s; in between its price comes from the stream's last trade
// (the worker streams every position). Before v0.1.28 every position was read from the chain on every beat, about
// a third of the plan's credits. A stale stream quote (no trade in 3s) always falls back to the chain.
// v0.1.34: the stream is now the Helius account feed (curve or pool vault changes of each position), and with no
// fresh quote a position is read from the chain at most every 2s (the desk beats faster than that: before, every beat
// read every position, ~370K credits a day for the desk alone).
const VERIFIED = new Map<string, { at: number; px: Px }>();
const VERIFY_MS = 15_000;
const CHAIN_MIN_MS = 2_000;
export async function priceOf(mints: string[], fresh = false, minGap = CHAIN_MIN_MS) {
  const now = Date.now();
  const fromStream: Record<string, Px> = {};
  for (const m of mints) {
    const v = VERIFIED.get(m);
    if (!fresh && v && now - v.at < minGap) {
      fromStream[m] = v.px;
      continue;
    }
    const sq = streamQuote(m);
    if (fresh || !v || now - v.at > VERIFY_MS || !sq) continue;
    // the stream only knows the curve or the pool from the venue of the trade; the chain check says which it is
    if (sq.curve !== !v.px.grad) continue;
    // a stream price far from the last chain read is not trusted until the chain confirms it: the stream also carries
    // trades in side pools anyone can open with a few dollars, where one trade prints any price. On 7 Oct a ghost
    // position "sold" $XP at ~1,400x on such a print (a $1.7B wick on a $150K coin)
    if (sq.px > v.px.px * 3 || sq.px < v.px.px / 3) continue;
    fromStream[m] = { px: sq.px, real: sq.real ?? v.px.real, curve: v.px.curve, grad: v.px.grad };
  }
  const chain = mints.filter((m) => !fromStream[m]);
  const out = chain.length ? await priceOfChain(chain) : {};
  for (const [m, q] of Object.entries(out)) VERIFIED.set(m, { at: now, px: q });
  for (const m of Array.from(VERIFIED.keys())) if (now - VERIFIED.get(m)!.at > 600_000) VERIFIED.delete(m);
  return { ...out, ...fromStream };
}

async function priceOfChain(mints: string[]) {
  const curves = mints.length ? await getCurves(mints) : {};
  const done = mints.filter((m) => !curves[m] || curves[m]!.complete);
  // migrated coins: the canonical pool's own reserves (exact, one RPC call). Never a random side pool.
  const pools = done.length ? await readPools(done).catch(() => ({} as Record<string, PoolRead | null>)) : {};
  const px: Record<string, Px> = {};
  for (const m of mints) {
    const c = curves[m];
    if (c && !c.complete && c.priceSol > 0) px[m] = { px: c.priceSol, real: c.realSol, curve: c, grad: false };
    else if (pools[m]?.px) px[m] = { px: pools[m]!.px, real: pools[m]!.sol, curve: c, grad: true };
  }
  // no curve and no canonical pool read (another pool, another launchpad, or the read failed): never leave a
  // position blind. DexScreener's deepest SOL pair, 2s budget, cached 2s so many pages and beats share one call.
  const rest = mints.filter((m) => !px[m]);
  if (rest.length) {
    const dx = await dexPx(rest).catch(() => ({} as Record<string, { px: number; sol: number }>));
    for (const m of rest) if (dx[m]) px[m] = { px: dx[m].px, real: dx[m].sol, curve: curves[m] ?? null, grad: !!curves[m]?.complete, src: "dex" };
  }
  return px;
}

export type Kind = "tech" | "meme";
type DevRec = { n: number; saved: number; cost: number; on: boolean };

/**
 * Tech or meme. A dev selling a meme is normal; on a tech coin it usually means a team with more bags (a starting
 * prior, nothing more). Read from what the coin says about itself and what LENS found: a product, an app, an agent,
 * a protocol, code on GitHub, docs.
 */
export function kindOf(rec: { name?: string; symbol?: string; description?: string; website?: string; twitter?: string } | null | undefined): Kind {
  if (!rec) return "meme";
  const text = `${rec.name || ""} ${rec.description || ""}`.toLowerCase();
  const site = String(rec.website || "").toLowerCase();
  if (/github\.com|gitbook|docs\.|\/docs|whitepaper/.test(site)) return "tech";
  return /\b(ai agent|agent|agents|protocol|platform|app|dapp|sdk|api|github|open[- ]source|infra|infrastructure|launchpad|dex|swap|staking|bridge|layer ?[12]|l2|oracle|terminal|llm|gpt|model|framework|tool|tools|bot|bots|trading bot|analytics|dashboard|depin|rwa|zk)\b/.test(text) ? "tech" : "meme";
}

/** One dev-sell case for a kind. Switches the dev exit for that kind on or off once there is a record. Returns true on a switch. */
function devCase(l: Learn, kind: Kind, saved: boolean) {
  l.devBy ||= { tech: { n: 0, saved: 0, cost: 0, on: true }, meme: { n: 0, saved: 0, cost: 0, on: false } };
  const d = l.devBy[kind];
  d.n++;
  if (saved) d.saved++;
  else d.cost++;
  l.devStat.n++;
  if (saved) l.devStat.saved++;
  else l.devStat.cost++;
  const was = d.on;
  d.on = propSwitch(d.on, d.saved, d.n, LEARN_RULES.devMin, LEARN_RULES.devSaved);
  l.devExitOn = l.devBy.meme.on; // legacy field, the King lane's VET line reads it
  return was !== d.on;
}

/** One sell-off case for a strategy. The exit starts on; once a strategy has its cases it stays on only while selling
 * into a sell-off beat holding. Returns true on a switch. */
function drainCase(l: Learn, sl: string, saved: boolean) {
  l.drainBy ||= {};
  const d = (l.drainBy[sl] ||= { n: 0, saved: 0, cost: 0, on: true });
  d.n++;
  if (saved) d.saved++;
  else d.cost++;
  const was = d.on;
  d.on = propSwitch(d.on, d.saved, d.n, LEARN_RULES.drainMin, LEARN_RULES.drainSaved);
  return was !== d.on;
}

/** The held part of a position's path for the EXIT LAB: [minutes since entry, price / entry], ~30s apart. */
function heldPath(p: Pos, now: number, exitPx: number): Partial<After> {
  const pts: [number, number][] = [];
  let lastT = -1;
  for (const [t, px] of p.series || []) {
    const m = (t - p.openedAt) / 60_000;
    if (m - lastT >= 0.5) {
      pts.push([Math.round(m * 100) / 100, Math.round((px / p.entryPx) * 10000) / 10000]);
      lastT = m;
    }
  }
  pts.push([Math.round(((now - p.openedAt) / 60_000) * 100) / 100, Math.round((exitPx / p.entryPx) * 10000) / 10000]);
  // round-trip cost at this position's size and venue: the exit lab subtracts it from every replayed exit
  const cost = Math.round(roundTripCost(p.costSol, p.mkt?.grad ?? !!p.gradSeen, p.mkt?.real ?? 0, p.entryPx * SUPPLY, COST) * 10000) / 10000;
  return { entryPx: p.entryPx, openedAt: p.openedAt, tier: p.tier || "micro", pts, cost };
}

/** Where the EXIT LAB starts a bucket before it has learned anything: the desk's own starting exits for that sleeve. */
function labDefault(cfg: Cfg, sl: string, _tier: Tier): ExitSet {
  const c: any = cfg;
  if (sl === "momo") return { stop: c.momoSl ?? -25, time: c.momoTimeStop ?? 40, initials: c.momoInitials ?? 40, trailK: 0.6 };
  if (sl === "catch") return { stop: c.catchSl ?? -18, time: c.catchTimeStop ?? 30, initials: c.catchInitials ?? 100, trailK: 0.8 };
  if (sl === "flash") return { stop: c.flashSl ?? -30, time: c.flashTimeStop ?? 12, initials: c.flashInitials ?? 100, trailK: 1 };
  return { stop: cfg.sl, time: cfg.timeStop, initials: cfg.initialsAt, trailK: 1 };
}

const DEX_CACHE = new Map<string, { at: number; px: number; sol: number }>();
/** SOL price per whole token from DexScreener's deepest SOL-quoted pair (fallback only). */
export async function dexPx(mints: string[]) {
  const out: Record<string, { px: number; sol: number }> = {};
  const now = Date.now();
  const need: string[] = [];
  for (const m of mints) {
    const c = DEX_CACHE.get(m);
    if (c && now - c.at < 2000) out[m] = { px: c.px, sol: c.sol };
    else need.push(m);
  }
  for (let i = 0; i < need.length; i += 30) {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${need.slice(i, i + 30).join(",")}`, { cache: "no-store", signal: AbortSignal.timeout(2000) }).catch(() => null);
    const pairs: any[] = res?.ok ? ((await res.json().catch(() => [])) as any[]) : [];
    for (const pr of Array.isArray(pairs) ? pairs : []) {
      const m = pr?.baseToken?.address;
      if (!m || !need.includes(m) || !/^(SOL|WSOL)$/i.test(pr?.quoteToken?.symbol || "")) continue;
      const liq = Number(pr?.liquidity?.quote || 0);
      const p = Number(pr?.priceNative);
      if (p > 0 && (!out[m] || liq > out[m].sol)) out[m] = { px: p, sol: liq };
    }
  }
  for (const m of need) if (out[m]) DEX_CACHE.set(m, { at: now, ...out[m] });
  return out;
}

/** Trailing stop width for a coin up `mult` times, before COACH and the runner model scale it. */
function trailFor(trail: number[], mult: number) {
  return mult < 3 ? trail[0] : mult < 10 ? trail[1] : mult < 30 ? trail[2] : trail[3];
}

// ---------------------------------------------------------------- learning: shadows, stalks, coach

function newShadow(mint: string, symbol: string, px0: number, early: boolean): Shadow {
  return { k: early ? `e:${mint}` : mint, mint, symbol, at: Date.now(), px0, hi: px0, lo: px0, last: px0, early, arms: Object.fromEntries(ARMS.map((a) => [String(a), { hi: px0, lo: px0, armed: a === 0, fill: a === 0 ? px0 : null }])) };
}

/** Pullback arm: armed after a dip of `depth`% from the high since the signal, fills on a 5% bounce off the low. */
function stepArm(t: ArmTrack, depth: number, px: number, px0: number) {
  if (t.fill != null) return;
  t.hi = Math.max(t.hi, px);
  if (!t.armed && px <= t.hi * (1 - depth / 100)) {
    t.armed = true;
    t.lo = px;
  }
  if (t.armed) {
    t.lo = Math.min(t.lo, px);
    if (px >= t.lo * 1.05 && px >= px0 * 0.5) t.fill = px;
  }
}

const PRIOR_RULES: Record<string, "floor" | "socials" | "traction" | "curvehi"> = { holding_floor: "floor", has_socials: "socials", post_traction: "traction", curve_not_late: "curvehi" };

// ---- learning switches (v0.1.31): every switch flips only on evidence and with hysteresis, so one lucky run can't
// flip it and the next unlucky one flip it back. Rates use a Wilson interval (80%), returns a two-sample t (1.5 to
// overrule a prior, 1.0 to put it back).
export function wilson(k: number, n: number, z = 1.28) {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
export function propSwitch(was: boolean, saved: number, n: number, min: number, theta: number) {
  if (n < min) return was;
  const [lo, hi] = wilson(saved, n);
  if (!was && lo >= theta) return true;
  if (was && hi < theta) return false;
  return was;
}
type Acc = { n: number; sum: number; sq?: number };
const varOf = (a: Acc) => (a.sq != null && a.n > 1 ? Math.max(1e-4, (a.sq - (a.sum * a.sum) / a.n) / (a.n - 1)) : 0.25);
/** A prior that skips coins: still on? Off once skipped coins beat bought ones by `edge`, clearly; back on once they clearly do worse. */
export function priorSwitch(on: boolean, skip: Acc, taken: Acc, min: number, edge: number) {
  if (skip.n < min || taken.n < 5) return on;
  const d = skip.sum / skip.n - taken.sum / taken.n;
  const se = Math.sqrt(varOf(skip) / skip.n + varOf(taken) / taken.n);
  if (on && d > edge && d / se > 1.5) return false;
  if (!on && d < 0 && -d / se > 1.0) return true;
  return on;
}

/** Socials prior. Tweet-linked coins (a WIRE match or an X link to a post) and coins with 2+ smart wallets early pass anyway. */
function socialsCheck(rec: Launch, l: Learn) {
  const soc = [rec.twitter && "X", rec.website && "website", rec.telegram && "Telegram"].filter(Boolean) as string[];
  const tweet = !!rec.wire || /\/status\/\d+/.test(String(rec.twitter || ""));
  const smart = rec.g?.smartN ?? 0;
  const ok = !l.socialsOn || soc.length > 0 || tweet || smart >= 2;
  const v = soc.length ? soc.join(", ") : tweet ? "no socials, but tied to a tweet" : smart >= 2 ? `no socials, but ${smart} smart wallets early` : "no X, website or Telegram";
  return { rule: "has_socials", ok, v: `${v}${l.socialsOn ? "" : " (prior overruled)"}` };
}

function scoreShadow(l: Learn, sh: Shadow, b: Batch) {
  // 30 minutes on: what each entry would have returned by now (log return; no fill = 0)
  const end = sh.last;
  if (sh.tag === "floor" || sh.tag === "socials" || sh.tag === "traction" || sh.tag === "curvehi") {
    // a coin a prior skipped: would buying it anyway have paid?
    const ret = Math.log(Math.max(1e-9, end) / sh.px0);
    const tg = sh.tag;
    const st = tg === "floor" ? l.floor : tg === "socials" ? l.socials : tg === "traction" ? l.traction : l.curveHi;
    st.n++;
    st.sum += ret;
    st.sq = (st.sq ?? 0) + ret * ret;
    const direct = l.arms["0"];
    const takenMean = direct.n ? direct.sum / direct.n : 0;
    const skipMean = st.sum / st.n;
    const was = tg === "floor" ? l.floorOn : tg === "socials" ? l.socialsOn : tg === "traction" ? l.tractionOn : l.curveHiOn;
    const min = tg === "floor" ? LEARN_RULES.floorMin : tg === "socials" ? LEARN_RULES.socialsMin : tg === "traction" ? LEARN_RULES.tractionMin : LEARN_RULES.curveHiMin;
    const edge = tg === "floor" ? LEARN_RULES.floorEdge : tg === "socials" ? LEARN_RULES.socialsEdge : tg === "traction" ? LEARN_RULES.tractionEdge : LEARN_RULES.curveHiEdge;
    const now = priorSwitch(was, st, direct, min, edge);
    if (tg === "floor") l.floorOn = now;
    else if (tg === "socials") l.socialsOn = now;
    else if (tg === "traction") l.tractionOn = now;
    else l.curveHiOn = now;
    const what = tg === "floor" ? "dumped from its high" : tg === "socials" ? "no X, website or Telegram" : tg === "traction" ? "a post that spawned no wave" : "curve already late at the call";
    log(b, "COACH", `${sh.tag} review $${sh.symbol} (skipped, ${what}): ${fmtPct((Math.exp(ret) - 1) * 100)} in 30m. skipped avg ${fmtPct((Math.exp(skipMean) - 1) * 100)} vs bought ${fmtPct((Math.exp(takenMean) - 1) * 100)} over ${st.n} cases`, ret > 0 ? "bad" : "ok", { mint: sh.mint, symbol: sh.symbol });
    if (was !== now) log(b, "COACH", now ? `${sh.tag} prior back on: skipped coins are clearly doing worse than the ones bought` : `${sh.tag} prior overruled: coins it skipped (${what}) clearly did better than the ones bought`, "win");
    return;
  }
  const parts: string[] = [];
  for (const a of ARMS) {
    const t = sh.arms[String(a)];
    const arm = l.arms[String(a)];
    const ret = t.fill ? Math.log(Math.max(1e-9, end) / t.fill) : 0;
    arm.n++;
    arm.sum += ret;
    (arm as any).sq = ((arm as any).sq ?? 0) + ret * ret;
    if (t.fill) arm.fills++;
    parts.push(`${a ? `-${a}%` : "now"} ${t.fill ? fmtPct((Math.exp(ret) - 1) * 100) : "no fill"}`);
  }
  const direct = l.arms["0"];
  let best = 0;
  let bestEdge = 0;
  for (const a of ARMS.slice(1)) {
    const arm = l.arms[String(a)];
    if (arm.n < LEARN_RULES.stalkMin) continue;
    const edge = arm.sum / arm.n - direct.sum / Math.max(1, direct.n);
    if (edge > bestEdge) [best, bestEdge] = [a, edge];
  }
  const was = l.stalkOn;
  // hysteresis: unlocks at the full edge, locks again only below half of it
  l.stalkOn = was ? bestEdge >= LEARN_RULES.stalkEdge / 2 : bestEdge >= LEARN_RULES.stalkEdge;
  l.stalkArm = l.stalkOn ? best : 0;
  log(b, "COACH", `entry review $${sh.symbol}${sh.early ? " (early read)" : ""}: ${parts.join(", ")}`, "info", { mint: sh.mint, symbol: sh.symbol });
  if (l.stalkOn !== was) log(b, "COACH", l.stalkOn ? `pullback entries unlocked: waiting for a -${best}% dip beats buying now by ${(bestEdge * 100).toFixed(0)}%` : "pullback entries locked again: buying now is doing as well", l.stalkOn ? "win" : "info");
}

function reviewExit(l: Learn, a: After, b: Batch): boolean {
  // a 2x after the exit decides at once (the exit was early, whatever happened in between); otherwise COACH waits the
  // full window. Before v0.1.31 a 40% dip decided it too: $FLY fell 40% after the stop, was scored "exit held up",
  // then ran +688% and nothing was revisited
  const ranAfter = a.hi >= a.exitPx * 2;
  const dumped = a.lo <= a.exitPx * 0.6;
  const expired = Date.now() - a.at > LEARN_RULES.coachHours * 3600_000;
  if (!ranAfter && !expired) return false;
  const coin = { mint: a.mint, symbol: a.symbol };
  l.reviews++;
  const gaveBack = a.peakHeld > 0 ? 1 - a.exitPx / a.peakHeld : 0;
  const sl = a.sl || "king";
  l.trailBy ||= {};
  const cur = l.trailBy[sl] ?? l.trailK;
  if (ranAfter && a.tunable) {
    l.early++;
    l.trailBy[sl] = Math.min(1.6, cur * 1.05);
    if (sl === "king") l.trailK = l.trailBy[sl];
    log(b, "COACH", `$${a.symbol} ran to ${(a.hi / a.exitPx).toFixed(1)}x after we sold (${a.reason}). ${sl} trails widened to ${l.trailBy[sl].toFixed(2)}x`, "bad", coin);
  } else if (a.tunable && gaveBack >= 0.4) {
    l.late++;
    l.trailBy[sl] = Math.max(0.5, cur / 1.05); // the same step both ways (it was 6% wider vs 3% tighter)
    if (sl === "king") l.trailK = l.trailBy[sl];
    log(b, "COACH", `$${a.symbol} gave back ${(gaveBack * 100).toFixed(0)}% from its peak before we sold. ${sl} trails tightened to ${l.trailBy[sl].toFixed(2)}x`, "bad", coin);
  } else {
    l.good++;
    log(b, "COACH", `$${a.symbol} exit held up: ${dumped ? `fell ${(100 - (a.lo / a.exitPx) * 100).toFixed(0)}% after we sold` : "no big move after we sold"}`, "ok", coin);
  }
  return true;
}

async function earlyStats(l: Learn) {
  // both records are taken at the same 2h label window, so neither side gets its winners counted first
  const st = (await redis().hmget<Record<string, number>>(K.stat, "lebond_n", "lebond_hit", "lbond_n", "lbond_hit")) || {};
  const s = { n: Number(st.lebond_n || 0), hit: Number(st.lebond_hit || 0), mainN: Number(st.lbond_n || 0), mainHit: Number(st.lbond_hit || 0) };
  l.earlyStat = s;
  const er = s.n ? s.hit / s.n : 0;
  const mr = s.mainN ? s.mainHit / s.mainN : 1;
  // hysteresis: unlocks when the early record matches the King's, locks again only under 90% of it
  l.earlyOn = s.n >= LEARN_RULES.earlyMin && (l.earlyOn ? er >= mr * 0.9 : er >= mr);
}

// ---------------------------------------------------------------- the loop

/**
 * One desk session: loops every 2s for up to `budgetMs`, handling entries from the queue and exits for every position.
 * Called by the cron pinger (budget ~55s) so coverage is continuous with one ping a minute.
 */
export async function deskSession(budgetMs = 50_000, onBeat?: () => Promise<unknown>) {
  const r = redis();
  // owned lock, renewed every pass: a slow swap can't let a second desk in, and we never free someone else's lock
  const lock = await acquire("rn:lock:desk", LOCK_MS);
  if (!lock) return { skipped: "busy" };
  // renewed on its own 10s timer as well as every beat: a beat can take minutes (a swap waiting 120s for its
  // confirmation, several entries), and before v0.1.25 the lock could expire mid-beat and let a second desk in
  DESK_LOCK = lock;
  DESK_LOST = false;
  const lockTimer = setInterval(() => {
    renew(lock, LOCK_MS).then((ok) => {
      if (!ok) DESK_LOST = true;
    });
  }, 10_000);
  const t0 = Date.now();
  let loops = 0;
  const b: Batch = { ev: [], trades: [] };
  try {
    // v0.1.31: the paper desk starts over once, now that paper pays live costs (done here, under the desk lock, so an
    // older desk still running cannot write its books back over the reset)
    await resetOnceForCosts().catch(() => false);
    await resetOnceForFinal().catch(() => false);
    await resetOnceForNano().catch(() => false);
    await dropWicksOnce().catch(() => null);
    await slimTradesOnce().catch(() => null);
    const s = await getSettings();
    const cfg = s.desk;
    if (cfg.mode === "off") return { off: true };
    let state = await loadState(cfg.start);
    const kp0 = wallet();
    const ws0 = kp0 ? (await conn().getBalance(kp0.publicKey).catch(() => null)) : null;
    state = await syncWallet(state, kp0, ws0 == null ? null : ws0 / 1e9, cfg.minSol, b);
    const learnS = await loadLearn();
    await earlyStats(learnS);
    await r.set(K.deskLearn, learnS); // saved right away so the page never shows stale gates
    let learnDirty = false;
    let learning: Promise<unknown> | null = null;
    const kp = wallet();
    EXEC_CFG = { fastExec: (cfg as any).fastExec !== false, maxPriorityLamports: (cfg as any).maxPriorityLamports, jitoTipMinSol: (cfg as any).jitoTipMinSol, jitoTipMaxSol: (cfg as any).jitoTipMaxSol };
    COST = { fastExec: (cfg as any).fastExec !== false, jitoTipMinSol: (cfg as any).jitoTipMinSol, jitoTipMaxSol: (cfg as any).jitoTipMaxSol, paperPrioritySol: (cfg as any).paperPrioritySol ?? 0.0005 };
    if (kp && state.live) await warm().catch(() => {});
    let lastBeat = 0;
    let sol = (await solUsd()) || 0;
    let runModel: NanoModel = await loadRunner();
    let prof: Record<string, ExitProfile> = await exitProfiles(cfg.initialsAt, cfg.timeStop).catch(() => ({}));
    let lab: Record<string, LabBest> = await labBest().catch(() => ({}));
    let emp: Record<string, number> = (await r.hgetall<Record<string, number>>(RK.emp)) || {};
    let runs: Record<string, Run | null> = {};
    let lastRunsAt = 0;
    const recent: Record<string, Sample[]> = {}; // 2s samples kept in memory for the flow read

    let lastErrAt = 0;
    let hadErr = false;
    let digging: Promise<unknown> | null = null;
    let walletAt = 0;
    let walletSolC: number | null = null;
    let lastSlowAt = 0;
    let lastInsAt = 0;
    let cfgAt = Date.now();
    const resetAt0 = Number((await r.get(RESET_KEY).catch(() => 0)) || 0);
    while (Date.now() - t0 < budgetMs) {
      loops++;
      if (DESK_LOST || !(await renew(lock, LOCK_MS))) {
        log(b, "LEDGER", "desk lock lost to another session; stopping this one", "info");
        break;
      }
      const now = Date.now();
      try {
      // settings changed in the admin take effect within 5 seconds (they used to wait for the next 50s session)
      if (now - cfgAt >= 5_000) {
        cfgAt = now;
        const fresh = (await getSettings().catch(() => null))?.desk;
        if (fresh) Object.assign(cfg, fresh);
        if ((cfg.mode as string) === "off") break;
        // a reset from the admin while this session runs: stop at once, before this session writes the old books back
        const ra = Number((await r.get(RESET_KEY).catch(() => 0)) || 0);
        if (ra !== resetAt0) {
          DESK_LOST = true;
          log(b, "LEDGER", "the desk was reset; this session stops without writing its books", "info");
          break;
        }
      }
      // the dig runs next to the desk, never in front of it: positions keep their 2s beat while the rats dig
      // the rats dig every 5s on a paid RPC plan (40+ calls a second), every 10s on the free one
      if (onBeat && !digging && now - lastBeat > (RPS >= 40 ? 5_000 : 10_000)) {
        lastBeat = now;
        digging = onBeat().catch(() => null).finally(() => (digging = null));
      }
      if (kp && state.live) warm().catch(() => {}); // a fresh blockhash is always ready for the next trade
      const posMap = await loadPositions(K.deskPos);
      const positions = Object.values(posMap);
      // signals older than 3 minutes are stale by the desk's own rule: drop them quietly, newest calls first
      const stale = Number((await r.zremrangebyscore(K.deskQ, 0, now - 180_000)) || 0);
      if (stale) log(b, "VET", `dropped ${stale} stale signal${stale > 1 ? "s" : ""} (older than 3 minutes)`, "info");
      const queued = ((await r.zrange<string[]>(K.deskQ, 0, 9, { rev: true })) || []) as string[];
      // shadows and COACH every 15s, one pass at a time (every third beat read the whole shadow and after books, with
      // their price paths, about once a second: a large share of the Redis bandwidth)
      const slow = !learning && now - lastSlowAt >= 30_000; // v0.1.40: 30s (was 15s); path points are 30s apart anyway
      if (slow) lastSlowAt = now;
      // v0.1.40: from memory (read from Redis once per process); written back every 2 minutes, not every 30s
      if (slow) await loadShaf();
      const shadows = slow ? SHM! : {};
      const afters = slow ? AFM! : {};
      const cases = slow ? ((await r.hgetall<Record<string, Case>>(CASES).catch(() => null)) || {}) : {};
      const stalks = (await r.hgetall<Record<string, Stalk>>(K.deskStalk)) || {};
      const reents = ((await r.hgetall<Record<string, { mint: string; symbol: string; how: Pos["how"]; entryPx: number; at: number }>>(REENT).catch(() => null)) || {}) as Record<string, { mint: string; symbol: string; how: Pos["how"]; entryPx: number; at: number }>;

      // --- promotion / demotion
      if (kp && now - walletAt > 15_000) {
        walletAt = now;
        // a failed balance read keeps the last good one (it used to read as 0: the live drawdown check then saw a -100%
        // wallet and sent the desk back to paper)
        const bal = await conn().getBalance(kp.publicKey).then((x) => x / 1e9).catch(() => null);
        if (bal != null) {
          walletSolC = bal;
          LAST_BAL = { sol: bal, at: now };
          if (state.live) await liveReconcile(b, state, kp, bal).catch((e) => log(b, "LEDGER", `wallet check failed: ${safeErr(e)}`, "info"));
        }
      }
      const walletSol = kp ? walletSolC : null;
      if (!state.live && (cfg.mode === "live" || cfg.mode === "auto") && kp && !positions.length) {
        const ex = cfg.mode === "live" ? { passed: walletSol != null && walletSol >= EXAM.minWallet } : await memo("desk:exam", 30_000, () => exam(state, walletSol));
        if (ex.passed) {
          state.live = true;
          state.liveStart = walletSol;
          state.liveBal = walletSol;
          LIVE_FLOW = 0;
          state.promotedAt = now;
          state.peakEq = walletSol || 0;
          log(b, "LEDGER", `exam passed. going live with ${walletSol?.toFixed(3)} SOL`, "win");
        }
      }

      // close-all stays on until the book is empty (a live sell that fails is retried on the next beat)
      const closeAll = !!(await r.get("rn:desk:closeall"));
      if (closeAll && !positions.length) await r.del("rn:desk:closeall");

      const ghosts = Object.values(await loadPositions(GHOST_POS));
      // --- prices for everything we hold, stalk, shadow, review or might buy (ghost positions in the same batch)
      // v0.1.36: three speeds. What we hold or are about to buy: live feed, chain at most every 2s. Pullback and
      // re-entry watches: every 5s. Learning reviews (shadows, after-exit checks, dev cases): every 30s. Before, all of
      // them were read every 2s, about 1.4 chain reads a second for the desk alone (40% of the plan's daily share)
      const hot = Array.from(new Set([...positions.map((p) => p.mint), ...ghosts.map((p) => p.mint), ...queued.map((x) => x.replace(/^[wmrcf]:/, ""))]));
      const watchList = Array.from(new Set([...Object.keys(stalks), ...Object.keys(reents)])).filter((m) => !hot.includes(m));
      const cold = Array.from(new Set([...Object.values(shadows).map((x) => x.mint), ...Object.values(afters).map((x) => x.mint), ...Object.values(cases).map((x) => x.mint)])).filter((m) => !hot.includes(m) && !watchList.includes(m));
      const tiered = async () => {
        const [a, w, c] = await Promise.all([priceOf(hot), watchList.length ? priceOf(watchList, false, 5_000).catch(() => ({})) : {}, cold.length ? priceOf(cold, false, 30_000).catch(() => ({})) : {}]);
        return { ...c, ...w, ...a } as Record<string, Px>;
      };
      // positions first: if the RPC is busy or down, open positions still get a price (DexScreener) and their exits
      // keep working; everything else waits for the next beat
      const px: Record<string, Px> = await tiered().catch(async (e) => {
        const held = positions.map((p) => p.mint);
        const dx = held.length ? await dexPx(held).catch(() => ({} as Record<string, { px: number; sol: number }>)) : {};
        if (Object.keys(dx).length) log(b, "RISK", `chain read failed (${safeErr(e)}): ${Object.keys(dx).length} open positions priced from DexScreener this beat`, "info");
        return Object.fromEntries(Object.entries(dx).map(([m, v]) => [m, { px: v.px, real: v.sol, curve: null, grad: false, src: "dex" } as Px]));
      });
      notePx(px, now);
      if (now - lastRunsAt > 10_000) {
        lastRunsAt = now;
        sol = (await solUsd()) || sol;
        const ms = positions.map((p) => p.mint);
        const got2 = ms.length ? await r.mget<(Run | null)[]>(...ms.map(RK.run)) : [];
        runs = Object.fromEntries(ms.map((m, i) => [m, got2[i]]));
        if (loops % 30 === 1) {
          runModel = await loadRunner();
          prof = await exitProfiles(cfg.initialsAt, cfg.timeStop).catch(() => prof);
          lab = await labBest().catch(() => lab);
          emp = (await r.hgetall<Record<string, number>>(RK.emp)) || {};
        }
      }

      // --- insiders: token balances of the dev, bundle wallets, snipers, top early buyers
      // every 5s (it was every other beat: about one chain read a second just for this)
      if (now - lastInsAt >= 5_000) {
        lastInsAt = now;
        const accs = Array.from(new Set([...positions, ...ghosts].flatMap((p) => (p.watch || []).map((w) => w.acc))));
        if (accs.length) {
          const amt = await tokenAmounts(accs).catch(() => null);
          if (amt)
            for (const p of [...positions, ...ghosts]) {
              const w = p.watch || [];
              const dev = w.filter((x) => x.role === "dev" && x.base > 0);
              const ins = w.filter((x) => x.role !== "dev" && x.base > 0);
              const base = ins.reduce((a, x) => a + x.base, 0);
              const nowHeld = ins.reduce((a, x) => a + (amt[x.acc] ?? x.base), 0);
              p.ins = base ? Math.round((nowHeld / base) * 1000) / 1000 : null;
              // how much of the whole supply the insiders actually let go of (1B supply, amounts in whole tokens)
              p.insSold = base ? Math.round(((base - nowHeld) / 1e9) * 1000) / 10 : null;
              p.dev = dev.length ? Math.round(((amt[dev[0].acc] ?? dev[0].base) / dev[0].base) * 1000) / 1000 : null;
            }
        }
      }

      const caseAdds: Case[] = [];
      // the exit rules (RISK), shared by the real desk and the ghost desk so both trade exactly alike
      const decide = (p: Pos, q: Px, gt = "") => {
        p.noPxSince = undefined;
        p.lastPx = q.px;
        if (q.src !== "dex") p.mkt = { grad: q.grad, real: q.real };
        if (q.px > p.peakPx) p.peakAt = now;
        p.peakPx = Math.max(p.peakPx, q.px);
        const rs = (recent[p.mint] ||= []);
        // this strategy's own exit profile (initials, time stop) and COACH's trail scale for it
        const sl = sleeveOf(p.how, p.wire?.vamp);
        if (!p.tier && sol) p.tier = tierOf(q.px * SUPPLY * sol);
        // exits learned by the EXIT LAB for this strategy at this market-cap tier win over everything else; until a
        // bucket has its 12 paths, the sleeve's profile (micro coins only: it was learned on them) and the defaults
        const lb = lab[`${sl}:${p.tier || "micro"}`];
        const pf = p.tier && p.tier !== "micro" ? prof[`${sl}:${p.tier}`] : prof[`${sl}:micro`] || prof[sl];
        // MOMO coins move fast both ways: tighter starting exits until their own record says otherwise
        const mo = sl === "momo";
        const ca = sl === "catch"; // CATCH: senders get room to run, but a fake start is cut fast
        const fl = sl === "flash"; // FLASH: in at seconds old, wide stop (the first minutes swing hard), short clock
        const c2: any = cfg;
        const initialsAt = lb?.initials ?? pf?.initials ?? (mo ? c2.momoInitials ?? 40 : ca ? c2.catchInitials ?? 100 : fl ? c2.flashInitials ?? 100 : cfg.initialsAt);
        const timeStop = lb?.time ?? pf?.timeStop ?? (mo ? c2.momoTimeStop ?? 40 : ca ? c2.catchTimeStop ?? 30 : fl ? c2.flashTimeStop ?? 12 : cfg.timeStop);
        const stopAt0 = lb?.stop ?? (mo ? c2.momoSl ?? -25 : ca ? c2.catchSl ?? -18 : fl ? c2.flashSl ?? -30 : cfg.sl);
        // one owner of the trail: the exit lab once it has learned this bucket, COACH's per-strategy scale before that
        // (until v0.1.31 both scaled it at once, so each corrected for the other)
        const trailK = lb ? lb.trailK : learnS.trailBy?.[sl] ?? (mo ? 0.6 : ca ? 0.8 : learnS.trailK);
        rs.push([now, q.px, q.real]);
        while (rs.length && now - rs[0][0] > 60_000) rs.shift();
        // MOMO coins are young migrated coins that swing 20-30% in seconds: in the first 10 minutes the stop sits
        // outside the coin's own last-minute range (1.2x, at most -45%). $FLY was stopped at -25% 36 seconds in,
        // then ran 6x from there
        let stopAt = stopAt0;
        if (mo && now - p.openedAt < 10 * 60_000 && rs.length >= 4) {
          const hiR = Math.max(...rs.map((x) => x[1]));
          const loR = Math.min(...rs.map((x) => x[1]));
          const range = hiR > 0 ? ((hiR - loR) / hiR) * 100 : 0;
          stopAt = Math.max(-45, Math.min(stopAt0, -range * 1.2));
        }
        const lastS = p.series[p.series.length - 1];
        if (!lastS || now - lastS[0] >= 10_000) p.series.push([now, q.px, q.real]);
        if (p.series.length > 360) p.series = p.series.slice(-360);
        const gain = pct(q.px, p.entryPx);
        const mult = q.px / p.entryPx;
        const age = (now - p.openedAt) / 60_000;
        const usd = sol ? q.px * SUPPLY * sol : 0;
        p.usd = Math.round(usd);
        const lv = levelOf(usd);
        const run = runs[p.mint];
        p.pn = run ? pNext(runModel, emp, { ...run, xm: p.xm ?? run.xm }, lv) : pNext(runModel, emp, fallbackRun(p), lv);
        // selling pressure: SOL leaving the curve over the last ~40s
        const back = rs.filter((x) => now - x[0] <= 40_000);
        const drain = back.length > 3 && back[0][2] > 0 ? pct(q.real, back[0][2]) : 0;
        // the price has to show the sell-off too: SOL leaving the curve while the price sits near its 40s high is a bad
        // read (or buys and sells netting out), and a healthy pullback on a young coin is not sellers taking over
        const hi40 = back.reduce((a, x) => Math.max(a, x[1]), q.px);
        const pxOff = hi40 > 0 ? pct(q.px, hi40) : 0;
        const drainHit = drain <= -(c2.drainPct ?? 20) && pxOff <= -(c2.drainPxDrop ?? 15) && gain < (c2.drainMaxGain ?? 25);
        const drainOn = learnS.drainBy?.[sl]?.on ?? true;
        if (drainHit && !drainOn && !p.drainPx) {
          p.drainPx = q.px;
          caseAdds.push({ kind: "drain", key: sl, mint: p.mint, symbol: p.symbol, at: now, px0: q.px, sold: false });
          log(b, "RISK", `$${p.symbol}${gt}: sell-off (curve ${drain.toFixed(0)}%, price ${pxOff.toFixed(0)}% in 40s). holding: for ${sl} coins holding through these has paid. COACH scores it`, "info", p);
        }
        const keep = cfg.moonbag * p.tokens0;
        const toBag = p.tokens > keep ? (p.tokens - keep) / p.tokens : 0;
        let sellFrac = 0;
        let reason = "";
        let tunable = false;
        const kind: Kind = p.kind || "meme";
        const devOn = learnS.devBy?.[kind]?.on ?? kind === "tech";
        if (p.dev != null && p.dev <= 1 - cfg.devExit / 100 && !devOn && !p.devSellPx) {
          p.devSellPx = q.px;
          caseAdds.push({ kind: "dev", key: kind, mint: p.mint, symbol: p.symbol, at: now, px0: q.px, sold: false });
          log(b, "RISK", `$${p.symbol}${gt}: dev sold ${Math.round((1 - p.dev) * 100)}% of their bag. holding: on memes a dev sell is normal. COACH scores what selling here would have done`, "info", p);
        }
        if (closeAll) [sellFrac, reason] = [1, "manual close"];
        else if (p.dev != null && p.dev <= 1 - cfg.devExit / 100 && devOn) [sellFrac, reason] = [1, `dev sold ${Math.round((1 - p.dev) * 100)}% of their bag (${kind} coin: dev exit ${learnS.devBy?.[kind]?.n ? `kept by COACH, ${learnS.devBy[kind].saved}/${learnS.devBy[kind].n} cases` : "starting prior"})`];
        // insider exit only when it matters: they let go of a real share of the supply (not a few tiny sniper bags) and
        // the price shows it (8%+ off the peak). Otherwise a 99% "dump" of 0.3% of supply could throw out a good coin
        else if (p.ins != null && p.ins <= 1 - cfg.insiderExit / 100 && (p.insSold ?? 0) >= ((cfg as any).insiderMinSupply ?? 2) && q.px <= p.peakPx * 0.92)
          [sellFrac, reason] = [1, `insiders dumped ${Math.round((1 - p.ins) * 100)}% of their bags (${p.insSold}% of supply: bundle, snipers, top buyers), price ${Math.round((q.px / p.peakPx - 1) * 100)}% off the peak`];
        else if (!p.tp1Done) {
          if (gain <= stopAt) [sellFrac, reason] = [1, `stop loss ${fmtPct(gain)}`];
          else if (drainHit && drainOn) [sellFrac, reason] = [1, `sellers took over: curve ${drain.toFixed(0)}%, price ${pxOff.toFixed(0)}% in 40s`];
          // CATCH send ladder, step 1: 40% at the initials (2x to start, the exit lab tunes it), 60% rides
          else if (gain >= initialsAt) [sellFrac, reason] = [ca ? c2.catchFirstFrac ?? 0.4 : cfg.initialsFrac, `${ca ? "send ladder: " : ""}initials at ${mult.toFixed(1)}x${pf?.medPk && initialsAt !== cfg.initialsAt ? ` (${sl} coins peak around ${pf.medPk}x)` : ""}, cost is back`];
          else if (q.grad && q.src !== "dex" && !p.gradSeen) {
            p.gradSeen = true;
            if (p.pn < cfg.gradKeepP) [sellFrac, reason] = [1, `migrated before initials, P(next) ${Math.round(p.pn * 100)}%: out`];
          } else if (age >= timeStop) [sellFrac, reason] = [1, `time stop ${Math.round(age)}m at ${fmtPct(gain)}${pf?.medTtp && timeStop !== cfg.timeStop ? ` (${sl} coins peak within ${pf.medTtp}m)` : ""}`];
        } else {
          // house money: trail + milestone ladder + migration check
          // CATCH runners get a wider trail until they reach the send target: senders shake out hard on the way up
          const sending = ca && !p.sendHit;
          const width = Math.max(15, Math.min(65, trailFor(cfg.trail, mult) * trailK * (0.85 + 0.3 * p.pn) * (sending ? 1.25 : 1)));
          p.trail = Math.round(width);
          const quiet = (now - (p.peakAt || p.openedAt)) / 60_000;
          const staleMin = (cfg as any).bagStaleMin ?? 120;
          const sendT = Math.max(c2.catchTargetUsd ?? 300_000, p.entryPx * SUPPLY * sol * 2);
          if (sending && sol && usd >= sendT) {
            // CATCH send ladder, step 2: at the target ($300K or 2x the entry cap), sell 30% of the original bag; the
            // last 30% trails like any house-money bag
            p.sendHit = true;
            const f = Math.min(1, ((c2.catchSendFrac ?? 0.3) * p.tokens0) / Math.max(1, p.tokens));
            [sellFrac, reason, tunable] = [f, `send ladder: ${usdS(sendT)} reached (${mult.toFixed(1)}x), runner third sold, the rest trails`, true];
          } else if (quiet >= staleMin && mult < 3) {
            // a bag that has not made a new high in a long time is dead money: sell it and keep the record clean
            [sellFrac, reason, tunable] = [1, `bag went quiet: no new high in ${Math.round(quiet)}m, out at ${mult.toFixed(1)}x`, true];
          } else if (q.px <= p.peakPx * (1 - width / 100)) {
            [sellFrac, reason, tunable] = [1, `trailing stop ${p.trail}% off the peak (${(p.peakPx / p.entryPx).toFixed(1)}x), out at ${mult.toFixed(1)}x`, true];
          } else if (lv > (p.msHi ?? -1) && lv >= 0 && !sending) {
            // only de-risk at a milestone when the runner model rates the next one as weak; strong coins keep running
            const f = Math.min(p.pn < cfg.ladderBelow ? cfg.ladderMax * (1 - p.pn / cfg.ladderBelow) : 0, toBag);
            p.msHi = lv;
            if (f >= 0.03) [sellFrac, reason, tunable] = [f, `${usdS(MILESTONES[lv])} reached, P(next ${usdS(MILESTONES[Math.min(lv + 1, MILESTONES.length - 1)])}) ${Math.round(p.pn * 100)}%`, true];
            else log(b, "RISK", `$${p.symbol}${gt} at ${usdS(MILESTONES[lv])}, P(next) ${Math.round(p.pn * 100)}%: holding`, "ok", p);
          } else if (q.grad && q.src !== "dex" && !p.gradSeen) {
            p.gradSeen = true;
            if (p.pn < cfg.gradKeepP && toBag > 0.03) [sellFrac, reason] = [toBag, `migrated, P(next) ${Math.round(p.pn * 100)}%: down to the moonbag`];
            else log(b, "RISK", `$${p.symbol}${gt} migrated, P(next) ${Math.round(p.pn * 100)}%: runner bag stays`, "ok", p);
          }
        }
        return { sellFrac, reason, tunable, lv };
      };

      // --- exits (RISK)
      for (const p of positions) {
        // one broken position must never freeze the desk: it logs, the others keep their exits
        try {
          const q = px[p.mint];
          if (!q) {
            // no price: the curve completed but the coin has not (or never) migrated. after 30 minutes it is written off
            p.noPxSince ||= now;
            if (now - p.noPxSince > 30 * 60_000) {
              const ok = await sell(b, state, p, 1, 0, "curve full but never migrated: written off", cfg.slippageBps, kp);
              if (ok) await dropPos(K.deskPos, p.mint);
            } else await savePos(K.deskPos, p);
            continue;
          }
          const { sellFrac, reason, tunable, lv } = decide(p, q);
          if (sellFrac > 0) {
            const peakHeld = p.peakPx;
            const ok = await sell(b, state, p, sellFrac, q.px, reason, cfg.slippageBps, kp);
            if (ok && !p.tp1Done && sellFrac < 1) {
              p.tp1Done = true;
              p.msHi = lv; // the ladder only acts on milestones reached after initials
            }
            // RE-ENTRY: a MOMO or King trade stopped out may be bought back once if the coin reclaims its entry within 30
            // minutes ($FLY: stopped at $103K, then ran to $879K). Only once per coin, and only while re-entries pay
            if (ok && p.tokens <= 0 && /^stop loss/.test(reason) && !p.reentry && (p.how === "momo" || p.how === "direct" || p.how === "stalk")) await r.hset(REENT, { [p.mint]: { mint: p.mint, symbol: p.symbol, how: p.how, entryPx: p.entryPx, at: now } }).catch(() => {});
            // the desk sold on a dev sell or a sell-off: scored like a hold, on the price 30 minutes later
            if (ok && /^dev sold/.test(reason)) caseAdds.push({ kind: "dev", key: p.kind || "meme", mint: p.mint, symbol: p.symbol, at: now, px0: q.px, sold: true });
            if (ok && /^sellers took over/.test(reason)) caseAdds.push({ kind: "drain", key: sleeveOf(p.how, p.wire?.vamp), mint: p.mint, symbol: p.symbol, at: now, px0: q.px, sold: true });
            if (ok && p.tokens <= 0) {
              // COACH follows the coin after we leave it
              await setAfter(r, p.mint, { mint: p.mint, symbol: p.symbol, at: now, exitPx: q.px, peakHeld, reason, hi: q.px, lo: q.px, tunable, sl: sleeveOf(p.how, p.wire?.vamp), ...heldPath(p, now, q.px), ...(/^dev sold/.test(reason) ? { devExit: p.kind || "meme" } : {}), ...(/^sellers took over/.test(reason) ? { drainExit: sleeveOf(p.how, p.wire?.vamp) } : {}) } satisfies After);
            }
          }
          if (p.tokens > 0) await savePos(K.deskPos, p, sellFrac > 0);
          else await dropPos(K.deskPos, p.mint);
        } catch (e) {
          const k = `rn:desk:poserr:${p.mint}`;
          const n = await r.incr(k).catch(() => 1);
          if (n === 1) await r.expire(k, 3600).catch(() => {});
          if (n === 1 || n % 30 === 0) log(b, "RISK", `$${p.symbol}: exit check failed (${safeErr(e)}). other positions unaffected${n > 1 ? `, ${n} times this hour` : ""}`, "bad", p);
        }
      }

      // --- ghost desk exits: the same rules, in the ghost book
      for (const p of ghosts) {
        try {
          const q = px[p.mint];
          if (!q) {
            p.noPxSince ||= now;
            if (now - p.noPxSince > 30 * 60_000) {
              await ghostSell(b, p, 1, 0, "curve full but never migrated: written off");
              await dropPos(GHOST_POS, p.mint);
            } else await savePos(GHOST_POS, p);
            continue;
          }
          const d = decide(p, q, " (ghost)");
          if (d.sellFrac > 0 && !d.reason.startsWith("manual")) {
            const peakHeld = p.peakPx;
            const closed = await ghostSell(b, p, d.sellFrac, q.px, d.reason);
            if (!p.tp1Done && d.sellFrac < 1) {
              p.tp1Done = true;
              p.msHi = d.lv;
            }
            if (/^dev sold/.test(d.reason)) caseAdds.push({ kind: "dev", key: p.kind || "meme", mint: p.mint, symbol: p.symbol, at: now, px0: q.px, sold: true });
            if (/^sellers took over/.test(d.reason)) caseAdds.push({ kind: "drain", key: sleeveOf(p.how, p.wire?.vamp), mint: p.mint, symbol: p.symbol, at: now, px0: q.px, sold: true });
            // COACH reviews ghost exits like real ones (trail too tight or too loose)
            if (closed) await setAfter(r, `g:${p.mint}`, { mint: p.mint, symbol: p.symbol, at: now, exitPx: q.px, peakHeld, reason: d.reason, hi: q.px, lo: q.px, tunable: d.tunable, sl: sleeveOf(p.how, p.wire?.vamp), ...heldPath(p, now, q.px), ...(/^dev sold/.test(d.reason) ? { devExit: p.kind || "meme" } : {}), ...(/^sellers took over/.test(d.reason) ? { drainExit: sleeveOf(p.how, p.wire?.vamp) } : {}) } satisfies After);
          }
          if (p.tokens > 0) await savePos(GHOST_POS, p, d.sellFrac > 0);
          else await dropPos(GHOST_POS, p.mint);
        } catch (e) {
          log(b, "RISK", `ghost $${p.symbol}: exit check failed (${safeErr(e)})`, "bad");
        }
      }

      if (caseAdds.length) await r.hset(CASES, Object.fromEntries(caseAdds.map((c) => [`${c.kind}:${c.mint}:${c.at}`, c]))).catch(() => {});

      // --- entries (VET -> FLOW -> BUZZ -> SIZE -> EXEC); signals that pass VET are also shadowed for learning
      const eq = await equity(state, kp, px);
      if (eq.dayKey !== state.dayKey) {
        state.dayKey = eq.dayKey;
        state.dayStart = eq.value;
      }
      for (const q0 of queued) {
        // one bad signal never stops the others (or the exits on the next beat)
        try {
          await r.zrem(K.deskQ, q0);
          const wireSig = q0.startsWith("w:");
          const mindSig = q0.startsWith("m:");
          const momoSig = q0.startsWith("r:");
          const catchSig = q0.startsWith("c:");
          const flashSig = q0.startsWith("f:");
          const m = wireSig || mindSig || momoSig || catchSig || flashSig ? q0.slice(2) : q0;
          if (flashSig) {
            if (px[m]) await flashEntry(b, state, m, px[m], cfg, eq.value, walletSol, kp, posMap).catch((e) => log(b, "VET", `FLASH signal: ${safeErr(e)}`, "bad"));
            continue;
          }
          if (catchSig) {
            if (px[m]) await catchEntry(b, state, m, px[m], cfg, eq.value, walletSol, kp, posMap).catch((e) => log(b, "VET", `CATCH signal: ${safeErr(e)}`, "bad"));
            continue;
          }
          if (momoSig) {
            await r.zrem(K.deskQ, q0);
            if (px[m]) await momoEntry(b, state, m, px[m], cfg, eq.value, walletSol, kp, posMap).catch((e) => log(b, "VET", `MOMO signal: ${safeErr(e)}`, "bad"));
            continue;
          }
          const rec = await getLaunch(m);
          // MIND may buy after migration too; everything else trades the curve only
          if (!rec || (rec.outcome && !(mindSig && rec.outcome === "BONDED"))) continue;
          if (mindSig) {
            if (px[m]) await mindEntry(b, state, rec, px[m], cfg, eq.value, walletSol, kp, posMap).catch((e) => log(b, "VET", `MIND signal $${rec.symbol}: ${safeErr(e)}`, "bad"));
            continue;
          }
          const early = !wireSig && !rec.call && rec.early?.verdict === "BOND";
          if (!wireSig && !rec.call && !early) continue;
          if (wireSig && !rec.wire?.pick) continue;
          const coin = { mint: m, symbol: rec.symbol };
          const q = px[m];
          if (!q) continue;
          const curve = q.curve?.progress ?? 0;
          // tweet coins have their own slots, so the King's positions never crowd them out (and the reverse)
          const liveNow = Object.values(await loadPositions(K.deskPos));
          const open = liveNow.filter((p) => takesSlot(p) && (wireSig ? p.how === "wire" : !OWN_LANE.has(p.how || ""))).length;
          // a BOND call the rats could not tape in time: read its trades now, before VET (desk lane, ~1s)
          if (!rec.tape && !wireSig) {
            const tp = await readTape(m, rec.creator, rec.createdAt).catch(() => null);
            if (tp) {
              rec.tape = tp;
              await putLaunch(r, rec, { keepTtl: true });
              log(b, "TAPE", `$${rec.symbol}: read at the desk: ${tp.n} trades, ${tp.uniq} traders, bundle ${Math.round(tp.bundleShare * 100)}%${tp.farm?.farm ? `, FARM: ${tp.farm.why}` : ""}`, tp.farm?.farm ? "bad" : "info", coin);
            }
          }
          const t = rec.tape;
          const g = rec.g;
          const callPx = rec.call?.px || 0;
          const chase = callPx ? pct(q.px, callPx) : 0;
          // how far the price sits under the coin's high since launch (curve high from every dig, 10s apart)
          const hiProg = Math.max(rec.peak ?? 0, Number((await r.zscore(K.peak, m)) ?? 0), curve);
          const dd = hiProg > curve ? Math.round((1 - curvePx(curve) / curvePx(hiProg)) * 100) : 0;
          const trust = wireSig ? (await accountOf(rec.wire!.h)).w : 0;
          const wireOpen = wireSig ? open : 0;
          const checks = wireSig
            ? [
                { rule: "wire_post", ok: trust >= (cfg.wireMinW ?? 0.2), v: `@${rec.wire!.h} · ${rec.wire!.how} · ${rec.wire!.lagSec}s after the post · trust ${trust}` },
                // PRIOR: most headlines move nothing. The post has to have spawned a wave (or the author posted the CA)
                (() => {
                  const tr = rec.wire!.trac;
                  const ok = !learnS.tractionOn || rec.wire!.how === "posted the CA" || (!!tr && (tr.copies >= 3 || tr.sol >= 25));
                  return { rule: "post_traction", ok, v: `${tr ? `${tr.copies} coins, ${tr.sol} SOL across them` : "no count"}${rec.wire!.vamp ? " · vamp" : ""}${learnS.tractionOn ? "" : " (prior overruled)"}` };
                })(),
                { rule: "curve_window", ok: curve <= (cfg.wireMaxCurve ?? 85), v: `${curve}%` },
                { rule: "dev_buy_sane", ok: rec.devBuySol <= cfg.maxDevBuy, v: `${rec.devBuySol} SOL` },
                { rule: "bundle_ok", ok: !t || t.bundleShare * 100 <= cfg.maxBundle, v: t ? `${Math.round(t.bundleShare * 100)}% of SOL in, ${t.bundleN} wallets` : "not read" },
                { rule: "tape_read", ok: !!t, v: t ? `${t.n} trades, ${t.uniq} traders read` : "no tape read in time" },
                { rule: "not_a_farm", ok: !t?.farm?.farm, v: t?.farm?.farm ? t.farm.why : t ? `${t.organic ?? "?"} organic traders` : "not read" },
                { rule: "holding_floor", ok: !learnS.floorOn || dd < LEARN_RULES.floorMax, v: `${dd}% under its high${learnS.floorOn ? "" : " (prior overruled)"}` },
                { rule: "open_slots", ok: wireOpen < (cfg.wireMaxOpen ?? 2) && !posMap[m] && !stalks[m], v: `${wireOpen}/${cfg.wireMaxOpen ?? 2} tweet-coin slots` },
                { rule: "daily_loss_ok", ok: pct(eq.value, state.dayStart) > -cfg.dailyLoss, v: fmtPct(pct(eq.value, state.dayStart)) },
              ]
            : [
            early
              ? { rule: "early_read_bond", ok: true, v: `BOND ${rec.early!.score} at minute 1` }
              : { rule: "king_or_nano_bond", ok: rec.call!.verdict === "BOND" || rec.call!.nano?.verdict === "BOND", v: `${rec.call!.verdict} ${rec.call!.score}` },
            { rule: "nano_agrees", ok: early || !cfg.needNano || rec.call!.nano?.verdict === "BOND", v: `${rec.call?.nano ? `${rec.call.nano.verdict} ${rec.call.nano.score}` : `still learning (${NANO_MIN} live lessons first)`}${cfg.needNano ? "" : " (not required)"}` },
            { rule: "curve_window", ok: early || curve >= cfg.minCurve, v: `${curve}%` },
            // PRIOR: a curve already past maxCurve at the call usually dumps at migration. Skipped calls are followed in
            // shadow and COACH drops the rule if they do clearly better ($FLY: skipped at 74%, then 54x)
            { rule: "curve_not_late", ok: !learnS.curveHiOn || curve <= cfg.maxCurve, v: `${curve}% (max ${cfg.maxCurve}%)${learnS.curveHiOn ? "" : " (prior overruled)"}` },
            { rule: "dev_not_serial", ok: !((rec.devN ?? 0) >= cfg.serialDev && (rec.devB ?? 0) === 0), v: `${rec.devN ?? 0} launches, ${rec.devB ?? 0} bonded` },
            { rule: "dev_buy_sane", ok: rec.devBuySol <= cfg.maxDevBuy, v: `${rec.devBuySol} SOL` },
            // memes: a dev sell is normal, so it only blocks once COACH has proven the dev exit
            { rule: "dev_not_selling", ok: !(learnS.devBy?.[kindOf(rec)]?.on ?? kindOf(rec) === "tech") || !t || t.devSold <= 0.25, v: t ? `${t.devSold} SOL out · ${kindOf(rec)}${(learnS.devBy?.[kindOf(rec)]?.on ?? kindOf(rec) === "tech") ? "" : " (info only)"}` : "not read" },
            { rule: "bundle_ok", ok: !t || t.bundleShare * 100 <= cfg.maxBundle, v: t ? `${Math.round(t.bundleShare * 100)}% of SOL in, ${t.bundleN} wallets` : "not read" },
            { rule: "cluster_ok", ok: !g || !(g.clN >= 5 && g.clB === 0), v: g ? (g.funder ? `${g.clN} launches, ${g.clB} bonded` : "fresh") : "not read" },
            { rule: "not_a_copycat", ok: !rec.meta?.copy, v: rec.meta?.copy ? "copies a recent winner" : "original" },
            { rule: "tape_read", ok: !!t, v: t ? `${t.n} trades, ${t.uniq} traders read` : "no tape read in time" },
            { rule: "not_a_farm", ok: !t?.farm?.farm, v: t?.farm?.farm ? t.farm.why : t ? `${t.organic ?? "?"} organic traders, block-0 curve ${Math.round(t.instant ?? 0)}%` : "not read" },
            { rule: "holding_floor", ok: !learnS.floorOn || dd < LEARN_RULES.floorMax, v: `${dd}% under its high${learnS.floorOn ? "" : " (prior overruled)"}` },
            // PRIOR: no socials is usually a rug. A tweet-linked coin or 2+ smart wallets early outweigh it. Not a hard cap: COACH can overrule it.
            socialsCheck(rec, learnS),
            { rule: "fresh_signal", ok: now - (rec.call?.at ?? rec.early!.at) < 3 * 60_000, v: `${Math.round((now - (rec.call?.at ?? rec.early!.at)) / 1000)}s old` },
            { rule: "open_slots", ok: open < cfg.maxOpen && !posMap[m] && !stalks[m], v: `${open}/${cfg.maxOpen}` },
            { rule: "daily_loss_ok", ok: pct(eq.value, state.dayStart) > -cfg.dailyLoss, v: fmtPct(pct(eq.value, state.dayStart)) },
          ];
          const fail = checks.find((c) => !c.ok);
          const fails = checks.filter((c) => !c.ok);
          if (fails.length === 1 && PRIOR_RULES[fails[0].rule] && ((await r.hlen(K.deskShadow)) || 0) < 60) {
            // a prior skipped it: follow it anyway so COACH can tell whether the prior helps
            const tag = PRIOR_RULES[fails[0].rule];
            const sh = { ...newShadow(m, rec.symbol, q.px, early), k: `${tag[0]}:${m}`, tag };
            await setShadow(r, sh.k, sh);
          }
          await r.set(K.deskVet, { mint: m, symbol: rec.symbol, at: now, checks }, { ex: 3600 });
          await r.set(VET_KEY(m), { at: now, checks, passed: !checks.find((c) => !c.ok) }, { ex: 7 * 86400 });
          // daily tally for the "right now" panel: how many signals were checked, and what stopped them
          const dk = DAY_KEY(now);
          await r.hincrby(dk, fail ? `f:${fail.rule}` : "passed", 1);
          await r.hincrby(dk, "seen", 1);
          await r.expire(dk, 3 * 86400);
          // blocked only by the desk itself (loss limit, full slots), not by anything about the coin: the ghost desk takes it
          // v0.1.43: a King call nano does not back (or nano still learning) goes to the ghost desk too, so the King's
          // record keeps building at no cost while the real desk waits for nano
          const deskBlock = !!fail && fails.every((c) => GHOSTABLE.has(c.rule)) && !posMap[m] && !stalks[m];
          if (fail && deskBlock) log(b, "VET", `$${rec.symbol} passes every check on the coin; the desk is blocked (${fails.map((c) => `${c.rule.replace(/_/g, " ")} ${c.v}`).join(", ")}). ghost desk follows it`, "info", coin);
          if (fail && !deskBlock) {
            log(b, "VET", `skipped $${rec.symbol}: ${fail.rule.replace(/_/g, " ")} (${fail.v})`, "info", coin);
            // FILM follows every skip (except a full desk or the loss limit, which say nothing about the coin)
            if (fail.rule !== "open_slots" && fail.rule !== "daily_loss_ok") await logSkip(fail.rule, fail.v, m, rec.symbol, q.px).catch(() => {});
            continue;
          }
          // every clean signal is followed in shadow: buy-now vs three pullback depths, scored after 30 minutes
          if (((await r.hlen(K.deskShadow)) || 0) < 40) {
            const sh = newShadow(m, rec.symbol, q.px, early);
            await setShadow(r, sh.k, sh);
          }
          if (early && !learnS.earlyOn) {
            const es = learnS.earlyStat;
            log(b, "VET", `$${rec.symbol} early read is clean. shadow only: early entries unlock at ${LEARN_RULES.earlyMin} resolved reads beating the minute-5 King (now ${es.n}, ${es.n ? Math.round((es.hit / es.n) * 100) : 0}% vs ${es.mainN ? Math.round((es.mainHit / es.mainN) * 100) : 0}%)`, "info", coin);
            continue;
          }
          if (!deskBlock) log(b, "VET", `$${rec.symbol} clean: curve ${curve}%, dev ${rec.devN ?? 0}/${rec.devB ?? 0}${t ? `, bundle ${Math.round(t.bundleShare * 100)}%` : ""}${g?.smartN ? `, ${g.smartN} smart wallets` : ""}`, "ok", coin);

          // FLOW: live pressure on the curve over a few seconds plus the last hour of trades
          const before = q.real;
          // FLOW watches the curve for a moment. Tweet coins get no wait: there, seconds are the edge
          await new Promise((res) => setTimeout(res, wireSig ? 0 : (cfg as any).flowWaitMs ?? 1500));
          const again = (await getCurves([m]))[m];
          const delta = again && before ? pct(again.realSol, before) : 0;
          const mk = (await getMarket([m]).catch(() => ({} as any)))[m];
          const tot = (mk?.b1 || 0) + (mk?.s1 || 0);
          const buyShare = tot ? mk.b1 / tot : null;
          if (delta <= -5 || (buyShare != null && tot >= 8 && buyShare < cfg.minFlow)) {
            log(b, "FLOW", `$${rec.symbol} selling: curve ${delta.toFixed(1)}% in 3s${buyShare != null ? `, buys ${(buyShare * 100).toFixed(0)}% of flow` : ""}`, "info", coin);
            await logSkip("flow_selling", `curve ${delta.toFixed(1)}% in 3s`, m, rec.symbol, again?.priceSol || q.px).catch(() => {});
            continue;
          }
          const flowTxt = `curve ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% in 3s${buyShare != null ? `, buys ${(buyShare * 100).toFixed(0)}% of the last hour (${tot} trades)` : ""}`;
          log(b, "FLOW", `$${rec.symbol} bid: ${flowTxt}`, "ok", coin);

          // BUZZ: X mentions (if configured) and paid dex signals; logged and fed to the runner model, never a buy trigger alone
          const xm = await xMentions(m);
          const buzzTxt = `${xm != null ? `${xm} X posts in 15m` : "X not connected"}${mk?.bo ? `, ${mk.bo} dex boosts` : ""}${mk?.pf ? ", paid dex profile" : ""}`;
          if (xm != null || mk?.bo || mk?.pf) log(b, "BUZZ", `$${rec.symbol}: ${buzzTxt}`, "info", coin);
          await r.set(ENTRY_KEY(m), { checks, flow: flowTxt, buzz: buzzTxt, chase }, { ex: 3 * 3600 });

          // never chase: past maxChase above the call price, or when pullbacks have proven better, stalk instead
          const nowPx = again?.priceSol || q.px;
          if (!wireSig && !deskBlock && (learnS.stalkOn || chase > cfg.maxChase)) {
            if (learnS.stalkOn) {
              await r.hset(K.deskStalk, { [m]: { mint: m, symbol: rec.symbol, at: now, px0: nowPx, depth: learnS.stalkArm || 30, hi: nowPx, lo: nowPx, armed: false, early } satisfies Stalk });
              log(b, "SIZE", `$${rec.symbol}: stalking a -${learnS.stalkArm || 30}% pullback for up to ${cfg.stalkMins}m`, "info", coin);
            } else {
              log(b, "VET", `$${rec.symbol} already ${fmtPct(chase)} above the call. not chasing (pullback entries still locked)`, "info", coin);
              await logSkip("not_chasing", `${fmtPct(chase)} over the call`, m, rec.symbol, nowPx).catch(() => {});
            }
            continue;
          }
          const how0 = wireSig ? "wire" : early ? "early" : "direct";
          if (deskBlock) await ghostEnter(b, rec, nowPx, again?.realSol ?? 0, how0, fails.map((c) => `${c.rule.replace(/_/g, " ")} ${c.v}`).join(", "), cfg);
          else await enter(b, state, rec, nowPx, again?.realSol ?? 0, eq.value, walletSol, kp, cfg, how0, xm);
        } catch (e) {
          log(b, "VET", `signal ${q0.slice(0, 8)}… failed: ${safeErr(e)}`, "bad");
        }
      }

      // --- stalks: buy the pullback once it bounces
      for (const sk of Object.values(stalks)) {
        const q = px[sk.mint];
        const coin = { mint: sk.mint, symbol: sk.symbol };
        const mo = sk.how === "momo"; // MOMO coins are often migrated already: a migration does not end their stalk
        if (!q || (q.grad && !mo) || now - sk.at > (sk.mins ?? cfg.stalkMins) * 60_000 || q.px < sk.px0 * 0.5) {
          await r.hdel(K.deskStalk, sk.mint);
          log(b, "SIZE", `$${sk.symbol} ${mo ? "MOMO pullback watch" : "stalk"} ended: ${!q ? "no price" : q.grad && !mo ? "migrated" : q.px < sk.px0 * 0.5 ? "broke down" : "no pullback in time"}`, "info", coin);
          continue;
        }
        const t: ArmTrack = { hi: sk.hi, lo: sk.lo, armed: sk.armed, fill: null };
        stepArm(t, sk.depth, q.px, sk.px0);
        if (t.fill != null) {
          await r.hdel(K.deskStalk, sk.mint);
          const rec = (await getLaunch(sk.mint)) || sk.rec || null;
          if (!rec) continue;
          if (mo && sk.rec?.description) rec.description = sk.rec.description;
          if (mo) {
            const held = Object.values(await loadPositions(K.deskPos)).filter((p) => p.how === "momo" && takesSlot(p)).length;
            if (held >= ((cfg as any).momoMaxOpen ?? 3) || pct(eq.value, state.dayStart) <= -cfg.dailyLoss) {
              log(b, "SIZE", `$${sk.symbol} (MOMO) bounced, but ${held >= ((cfg as any).momoMaxOpen ?? 3) ? "the MOMO slots are full" : "the daily loss limit is hit"}: not bought`, "info", coin);
              continue;
            }
          }
          log(b, "FLOW", `$${sk.symbol} pulled back ${Math.round((1 - t.lo / t.hi) * 100)}% and bounced. entering ${fmtPct(pct(q.px, sk.px0))} vs the signal${mo ? " (MOMO)" : ""}`, "ok", coin);
          await enter(b, state, rec, q.px, q.grad ? 0 : q.real, eq.value, walletSol, kp, cfg, mo ? "momo" : "stalk", null, true);
        } else await r.hset(K.deskStalk, { [sk.mint]: { ...sk, hi: t.hi, lo: t.lo, armed: t.armed } });
      }

      // --- re-entries: a stopped-out coin that reclaims its entry (+3%) within 30 minutes is bought back once
      for (const re of Object.values(reents)) {
        const q = px[re.mint];
        if (now - re.at > 30 * 60_000) {
          await r.hdel(REENT, re.mint);
          continue;
        }
        if (!q || q.src === "dex" || q.px < re.entryPx * 1.03 || posMap[re.mint]) continue;
        await r.hdel(REENT, re.mint);
        const rr = await reentryRecord();
        const coin = { mint: re.mint, symbol: re.symbol };
        if (!rr.on) {
          log(b, "RISK", `$${re.symbol} reclaimed its entry after the stop. re-entries are off (last ${rr.n}: ${rr.avg}% avg, ${rr.win}% winners)`, "info", coin);
          continue;
        }
        const known = await getLaunch(re.mint);
        const rec: Launch = known || ({ mint: re.mint, sig: "", createdAt: now, creator: "", name: re.symbol, symbol: re.symbol, uri: "", image: "", description: "re-entry after a stop-out", twitter: "", telegram: "", website: "", devBuySol: 0, devN: 0, devB: 0, dugAt: now, dugBy: "RISK", p0: 0, mcap0: 0, cp: {}, outcome: q.grad ? "BONDED" : undefined } as Launch);
        log(b, "RISK", `$${re.symbol} reclaimed its entry ${Math.round((now - re.at) / 60_000)}m after the stop (${fmtPct(pct(q.px, re.entryPx))} vs entry). buying back once`, "ok", coin);
        REENTRY_NEXT.add(re.mint);
        await enter(b, state, rec, q.px, q.grad ? 0 : q.real, eq.value, walletSol, kp, cfg, re.how || "momo", null);
        REENTRY_NEXT.delete(re.mint);
      }

      // --- learning: shadows (entries) and COACH (exits), every ~6s
      // learning (shadows, COACH, the exit lab, FILM) runs beside the beat, never in front of it: a long review pass
      // used to hold the desk for up to a minute while open positions waited for their next price
      if (slow) {
        learning = (async () => {
        const wp = r.pipeline();
        const shUp: Record<string, Shadow> = {};
        const afUp: Record<string, After> = {};
        for (const sh of Object.values(shadows)) {
          const q = px[sh.mint];
          if (q) {
            sh.last = q.px;
            sh.hi = Math.max(sh.hi, q.px);
            sh.lo = Math.min(sh.lo, q.px);
            for (const a of ARMS) if (a) stepArm(sh.arms[String(a)], a, q.px, sh.px0);
          }
          // scored only on a real read: a beat without a price is "no read", not a dead coin (it waits, and after twice
          // the window with no read it is dropped unscored)
          const realQ = q && q.src !== "dex";
          if (now - sh.at >= LEARN_RULES.shadowMins * 60_000 && realQ) {
            scoreShadow(learnS, sh, b);
            learnDirty = true;
            wp.hdel(K.deskShadow, sh.k || sh.mint);
            delete SHM?.[sh.k || sh.mint];
          } else if (now - sh.at >= 2 * LEARN_RULES.shadowMins * 60_000) {
            wp.hdel(K.deskShadow, sh.k || sh.mint);
            delete SHM?.[sh.k || sh.mint];
          } else shUp[sh.k || sh.mint] = sh;
        }
        for (const [ak, a] of Object.entries(afters)) {
          const q = px[a.mint];
          if (q && q.src !== "dex") {
            a.noq = 0;
            a.hi = Math.max(a.hi, q.px);
            a.lo = Math.min(a.lo, q.px);
            // EXIT LAB: keep drawing the coin's path after we left, so exits are judged on the whole move
            if (a.pts && a.entryPx && a.openedAt) {
              const t = (now - a.openedAt) / 60_000;
              const lastT = a.pts.length ? a.pts[a.pts.length - 1][0] : -1;
              if (t - lastT >= 0.5) a.pts.push([Math.round(t * 100) / 100, Math.round((q.px / a.entryPx) * 10000) / 10000]);
            }
          }
          if (!a.reviewed && reviewExit(learnS, a, b)) {
            learnDirty = true;
            a.reviewed = true;
          }
          // done when COACH has its verdict and the path covers 2 hours from the buy (or the coin went dark)
          if (!q || q.src === "dex") a.noq = (a.noq || 0) + 1;
          // no read for ~10 minutes in a row (20 slow passes of 30s): the coin went dark
          const pathDone = !a.openedAt || now - a.openedAt >= 120 * 60_000 || now - a.at > LEARN_RULES.coachHours * 3600_000 || (a.noq || 0) >= 20;
          if (a.reviewed && pathDone) {
            if (a.pts && a.tier && a.sl) await notePath({ at: a.openedAt || a.at, tier: a.tier, sl: a.sl, pts: a.pts, cost: a.cost }).catch(() => {});
            wp.hdel(K.deskAfter, ak);
            delete AFM?.[ak];
          } else afUp[ak] = a;
        }
        // dev-sell and sell-off cases, 30 minutes on: would selling at that moment have beaten holding?
        for (const [ck, c] of Object.entries(cases)) {
          if (now - c.at < 30 * 60_000) continue;
          const q = px[c.mint];
          if (!q || q.src === "dex") {
            if (now - c.at > 2 * 3600_000) wp.hdel(CASES, ck); // never read again: dropped, not scored
            continue;
          }
          const saved = q.px < c.px0;
          const flip = c.kind === "dev" ? devCase(learnS, c.key as Kind, saved) : drainCase(learnS, c.key, saved);
          const st = c.kind === "dev" ? learnS.devBy![c.key as Kind] : learnS.drainBy![c.key];
          const what = c.kind === "dev" ? "dev sell" : "sell-off";
          log(b, "COACH", `$${c.symbol} ${what} (${c.key}, ${c.sold ? "we sold" : "we held"}): ${(q.px / c.px0).toFixed(2)}x 30 minutes later, ${saved ? "selling there was better" : "holding was better"}. ${st.saved}/${st.n} ${c.key} cases favour selling`, saved === c.sold ? "ok" : "bad", { mint: c.mint, symbol: c.symbol });
          if (flip) log(b, "COACH", st.on ? `${what} exit on for ${c.key}: selling there has clearly been better` : `${what} exit off for ${c.key}: holding has clearly been better`, "win");
          learnDirty = true;
          wp.hdel(CASES, ck);
        }
        if (now - shafSavedAt >= 120_000) {
          shafSavedAt = now;
          if (Object.keys(shUp).length) wp.hset(K.deskShadow, shUp);
          if (Object.keys(afUp).length) wp.hset(K.deskAfter, afUp);
        }
        await wp.exec().catch(() => {});
        // EXIT LAB re-learns every bucket with enough paths (every ~10 minutes)
        const learned = await labStep((sl2, tier) => labDefault(cfg, sl2, tier)).catch(() => []);
        for (const x of learned) {
          lab[x.key] = x.best;
          log(b, "COACH", `exit lab ${x.key.replace(":", " · ")}: stop ${x.best.stop}%, time stop ${Math.round(x.best.time)}m, initials +${Math.round(x.best.initials)}%, trail ${x.best.trailK.toFixed(2)}x · replayed on ${x.best.n} paths: ${x.best.avg >= 0 ? "+" : ""}${x.best.avg}% avg vs ${x.best.base >= 0 ? "+" : ""}${x.best.base}% before`, "info");
        }
        // FILM reviews every skip at 30m, 2h, 24h
        for (const e of await filmStep().catch(() => [])) log(b, "FILM", e.text, e.tone as Tone, { mint: e.mint, symbol: e.symbol });
        // COACH follow-ups after every exit
        for (const e of await coachStep(sol || null).catch(() => [])) log(b, "COACH", e.text, e.tone as Tone, { mint: e.mint, symbol: e.symbol });
        if (loops % 30 === 1) await earlyStats(learnS);
        if (learnDirty) {
          await r.set(K.deskLearn, learnS);
          learnDirty = false;
        }
        })()
          .catch((e) => log(b, "COACH", `learning pass failed, retrying: ${safeErr(e)}`, "info"))
          .finally(() => (learning = null));
      }

      // --- the homepage shows how close the desk is to its own wallet (every ~30s)
      if (loops % 15 === 1) {
        // v0.1.40: the exam reads up to 2,000 trades (MBs); one read per 30s is shared with the promotion check above,
        // which used to run it on every beat while the desk waited flat for its exam
        const ex = await memo("desk:exam", 30_000, () => exam(state, walletSol));
        await r.set(EXAM_FULL, { at: Date.now(), ex }, { ex: 120 }).catch(() => null);
        await r.set(K.deskExam, { at: now, live: state.live, passed: ex.checks.filter((c) => c.ok).length, total: ex.checks.length, checks: ex.checks.map((c) => ({ l: c.label, ok: c.ok, now: c.now, need: c.need })), walletSol, wallet: kp ? kp.publicKey.toBase58() : null }, { ex: 600 });
      }

      // --- books
      const eq2 = await equity(state, kp, px);
      state.equity = eq2.value;
      state.peakEq = Math.max(state.peakEq, eq2.value);
      const dd = state.peakEq ? -pct(eq2.value, state.peakEq) : 0;
      state.maxDD = Math.max(state.maxDD, dd);
      // only on a fresh balance read: a stale or failed read is never a reason to demote
      if (state.live && state.liveStart && LAST_BAL && now - LAST_BAL.at < 60_000 && pct(eq2.value, state.liveStart) <= -EXAM.liveMaxDD) {
        state.live = false;
        state.demotions++;
        state.cash = state.start;
        state.maxDD = 0;
        state.peakEq = state.start;
        log(b, "LEDGER", `live drawdown hit ${EXAM.liveMaxDD}%. back to paper to re-take the exam`, "loss");
      }
      if (now - state.lastEqAt >= 60_000) {
        state.lastEqAt = now;
        await r.rpush(K.deskEq, { t: now, eq: r4(eq2.value), live: state.live });
        await r.ltrim(K.deskEq, -3000, -1);
      }
      // only the lock holder writes the books (a desk that lost its lock must not overwrite the new holder's state)
      if (!DESK_LOST) await r.set(K.deskState, state);
      // the heartbeat key every 5s (it was every beat; readers only need to know the desk ran in the last 90s)
      if (now - beatWrittenAt >= 5_000) {
        beatWrittenAt = now;
        await r.set(BEAT_KEY, now);
      }
      if (hadErr) {
        hadErr = false;
        log(b, "LEDGER", "back to normal, every beat on time", "ok");
      }
      await flushLog(b);
      } catch (e) {
        hadErr = true;
        // one bad beat (usually the RPC rate limit) never ends the session: back off and try again
        const msg = safeErr(e);
        const busy = /429|too many/i.test(msg);
        if (now - lastErrAt > 30_000) {
          lastErrAt = now;
          log(b, "LEDGER", busy ? "RPC busy (rate limit). backing off, next beat in a few seconds" : `beat failed, retrying: ${msg}`, busy ? "info" : "bad");
          await flushLog(b).catch(() => {});
        }
        await new Promise((res) => setTimeout(res, busy ? 4000 : 2000));
        continue;
      }
      const wait = LOOP_MS - (Date.now() - now);
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    }
    if (digging) await digging;
    if (learning) await learning;
    await r.set(K.deskLearn, learnS);
    return { loops };
  } catch (e) {
    log(b, "LEDGER", `desk error: ${safeErr(e)}`, "bad");
    await flushLog(b).catch(() => {});
    return { error: safeErr(e), loops };
  } finally {
    clearInterval(lockTimer);
    if (!DESK_LOST) await flushPositions();
    if (!DESK_LOST) await flushShaf().catch(() => {});
    DESK_LOCK = null;
    await release(lock);
  }
}

function fallbackRun(p: Pos): Run {
  return { mint: p.mint, symbol: p.symbol, createdAt: p.openedAt, bondedAt: null, hi: -1, pk: 0, xs: {}, s: { king: p.king, nano: p.nano, smartN: 0, clRatio: 1, bundleShare: 0, uniq: 0, solPerBuy: 0, buyShare: 0.5, copy: false, lift: 1, funder: null, early: [] } };
}

type Cfg = Awaited<ReturnType<typeof getSettings>>["desk"];

// v0.1.43: prices the desk has seen per coin over the last 90 seconds (memory only), for the falling-knife check
const PXR = new Map<string, [number, number][]>();
function notePx(px: Record<string, Px>, now: number) {
  if (PXR.size > 3000) PXR.clear();
  for (const [m, q] of Object.entries(px)) {
    if (!q?.px || q.src === "dex") continue;
    const a = PXR.get(m) || [];
    a.push([now, q.px]);
    while (a.length && now - a[0][0] > 90_000) a.shift();
    PXR.set(m, a);
  }
}
// strategies that skip the check: tweet coins and FLASH live on seconds, a stalk fill has just bounced
const KNIFE_SKIP = new Set(["wire", "flash", "stalk"]);
/**
 * v0.1.43: is the coin falling right now? On 8 Oct most paper buys never got more than +8% above the entry: the desk
 * bought coins that had already turned. Two fresh chain reads 1.5 seconds apart, the prices the desk saw in the last
 * minute, and the live tape when the stream follows the coin. Falling = 10%+ under the last minute's high, or three
 * lower prices in a row (3%+ down), or the tape's last minute down 10%+ with more sellers than buyers.
 */
async function knife(m: string, px0: number, cfg: Cfg): Promise<{ falling: boolean; why: string; px: number }> {
  const c: any = cfg;
  const s: number[] = [px0];
  for (let i = 0; i < 2; i++) {
    await new Promise((res) => setTimeout(res, c.knifeGapMs ?? 1500));
    const q = (await priceOf([m], true).catch(() => ({} as Record<string, Px>)))[m];
    if (q?.px) s.push(q.px);
  }
  const now = Date.now();
  const ring = (PXR.get(m) || []).filter((x) => now - x[0] <= 60_000).map((x) => x[1]);
  const rt = ((globalThis as any).__rnRt as ((ms: string[]) => Record<string, any>) | undefined)?.([m])?.[m];
  return knifeVerdict(s, ring, rt, cfg);
}
/** The falling-knife rule on its own (exported for the tests): samples oldest first, ring = prices of the last minute. */
export function knifeVerdict(s: number[], ring: number[], rt: { span: number; mcCh60: number; s20: number; b20: number } | null | undefined, cfg: Cfg) {
  const c: any = cfg;
  const hi = Math.max(...ring, ...s);
  const last = s[s.length - 1];
  const off = hi > 0 ? pct(last, hi) : 0;
  const slide = s.length >= 3 && s[2] < s[1] && s[1] < s[0] && pct(s[2], s[0]) <= -(c.knifeSlide ?? 3);
  const tapeDown = !!rt && rt.span >= 20 && rt.mcCh60 <= -(c.knifeTape ?? 10) && rt.s20 > rt.b20;
  const maxOff = c.knifeOff ?? 10;
  const falling = off <= -maxOff || slide || tapeDown;
  const why = off <= -maxOff ? `${Math.round(off)}% under the last minute's high` : slide ? `three lower prices in 3s (${pct(s[2], s[0]).toFixed(1)}%)` : tapeDown ? `tape: ${rt!.mcCh60}% in the last minute, ${rt!.s20} sells vs ${rt!.b20} buys in 20s` : `${off.toFixed(1)}% off the minute's high`;
  return { falling, why, px: last };
}
/** v0.1.43: which failed checks still let the ghost desk follow a signal (exported for the tests). */
export const ghostable = (rules: string[]) => rules.length > 0 && rules.every((x) => GHOSTABLE.has(x));
const FALL_SKIPS = new Map<string, number>(); // one skip per coin per 2 minutes in the log and FILM

async function enter(b: Batch, state: DeskState, rec: Launch, px: number, real: number, eqValue: number, walletSol: number | null, kp: Keypair | null, cfg: Cfg, how: "direct" | "stalk" | "early" | "wire" | "mind" | "momo" | "catch" | "flash", xm: number | null, bounced = false) {
  const r = redis();
  const coin = { mint: rec.mint, symbol: rec.symbol };
  // never the same coin twice: two signals for one coin in the same beat (CATCH and the King, or a repeat signal) used
  // to buy it twice within a second ($MEMEBER on 7 Oct, both stopped out)
  if (ENTERING.has(rec.mint) || (await loadPositions(K.deskPos))[rec.mint]) return;
  ENTERING.add(rec.mint);
  try {
    if (!bounced && !KNIFE_SKIP.has(how)) {
      const k = await knife(rec.mint, px, cfg);
      if (k.falling) {
        skipFalling(b, rec, how, k);
        return;
      }
      px = k.px;
    }
    await enterInner(b, state, rec, px, real, eqValue, walletSol, kp, cfg, how, xm, r, coin);
  } finally {
    ENTERING.delete(rec.mint);
  }
}
function skipFalling(b: Batch, rec: Launch, how: string, k: { why: string; px: number }, ghost = false) {
  const now = Date.now();
  if (now - (FALL_SKIPS.get(rec.mint) || 0) < 120_000) return;
  FALL_SKIPS.set(rec.mint, now);
  if (FALL_SKIPS.size > 2000) FALL_SKIPS.clear();
  log(b, "FLOW", `${ghost ? "ghost: " : ""}not buying $${rec.symbol} (${how}): falling, ${k.why}`, "info", { mint: rec.mint, symbol: rec.symbol });
  if (!ghost) logSkip("falling_knife", k.why, rec.mint, rec.symbol, k.px).catch(() => {});
}
const ENTERING = new Set<string>();
async function enterInner(b: Batch, state: DeskState, rec: Launch, px: number, real: number, eqValue: number, walletSol: number | null, kp: Keypair | null, cfg: Cfg, how: "direct" | "stalk" | "early" | "wire" | "mind" | "momo" | "catch" | "flash", xm: number | null, r: ReturnType<typeof redis>, coin: { mint: string; symbol: string }) {
  enqueueLens(r, rec.mint, "buy");
  if (state.live && !kp) {
    log(b, "EXEC", `$${rec.symbol}: the desk is live and this process has no wallet key. no buy here`, "info", coin);
    return;
  }
  // live: no new buy while a swap is unaccounted for (the wallet check settles it first)
  if (state.live && Number((await r.hlen(PENDING).catch(() => 0)) || 0) > 0) {
    log(b, "EXEC", `$${rec.symbol}: a previous swap is still being checked against the wallet. no new buy until it is settled`, "info", coin);
    return;
  }
  // RISK: at the bag cap, the quietest house-money bag makes room (cash and attention go to the new signal)
  const held = Object.values(await loadPositions(K.deskPos));
  if (held.length >= ((cfg as any).maxBags ?? 12)) {
    const bag = held.filter((p) => p.tp1Done && p.mint !== rec.mint).sort((a, z) => (a.peakAt || a.openedAt) - (z.peakAt || z.openedAt))[0];
    if (!bag) {
      log(b, "RISK", `$${rec.symbol}: ${held.length} positions held and none is house money yet. skipping`, "info", coin);
      return;
    }
    const ok = await sell(b, state, bag, 1, bag.lastPx, `bag cap: sold the quietest bag to make room for $${rec.symbol}`, cfg.slippageBps, kp);
    if (ok && bag.tokens <= 0) await dropPos(K.deskPos, bag.mint);
  }
  // SIZE: research on fat tails says small, equal bets; never size up on conviction
  const avail = state.live ? (walletSol ?? 0) - 0.02 : state.cash;
  // liquidity cap: on the curve, buying S SOL moves the price by ((vSol + S) / vSol)^2 - 1, vSol = 30 + real SOL
  const vSol = 30 + Math.max(0, real);
  const liqCap = vSol * (Math.sqrt(1 + (cfg.maxImpact ?? 6) / 100) - 1);
  // PM: each strategy sleeve is sized by its own record; a paused sleeve sits out
  const sl = sleeveOf(how, rec.wire?.vamp);
  const pmw = await sleeveWeight(sl).catch(() => ({ w: 1, paused: false, until: 0 }));
  if (pmw.paused) {
    log(b, "PM", `$${rec.symbol}: ${sl} sleeve is paused until ${new Date(pmw.until).toISOString().slice(11, 16)} UTC after a bad run. ghost desk takes it`, "info", coin);
    await ghostEnter(b, rec, px, real, how, `${sl} sleeve paused by PM`, cfg, true);
    return;
  }
  // RISK: tracked wallets in the coin move the size, by how copying their class has actually done (bounded 0.7x to 1.4x)
  const buyers = (await buyersOf(rec.mint).catch(() => [])).filter((x: any) => Date.now() - x.at < 2 * 3600_000);
  let wmul = 1;
  if (buyers.length) {
    const recs = buyers.filter((x: any) => x.class6h.n >= 10).map((x: any) => x.class6h.avg as number);
    if (recs.length) {
      const avg = recs.reduce((a: number, b: number) => a + b, 0) / recs.length;
      wmul = Math.max(0.7, Math.min(1.4, 1 + avg / 200));
      if (wmul !== 1) log(b, "RISK", `$${rec.symbol}: ${buyers.length} tracked wallet${buyers.length > 1 ? "s" : ""} in (${buyers.slice(0, 3).map((x: any) => x.name).join(", ")}); their classes averaged ${Math.round(avg)}% at 6h when copied: size ${wmul.toFixed(2)}x`, "info", coin);
    }
  }
  const want = Math.max(cfg.minSol, (eqValue * cfg.sizePct * pmw.w * wmul) / 100);
  if (pmw.w !== 1) log(b, "PM", `$${rec.symbol}: ${sl} sleeve at ${pmw.w}x size`, "info", coin);
  const size = Math.min(cfg.maxSol, want, liqCap, avail * 0.95);
  if (want > liqCap && liqCap < cfg.maxSol) log(b, "SIZE", `$${rec.symbol}: liquidity caps the buy at ${liqCap.toFixed(2)} SOL (max ${cfg.maxImpact ?? 6}% price impact on a ${vSol.toFixed(0)} SOL curve)`, "info", coin);
  if (size < cfg.minSol * 0.99) {
    log(b, "SIZE", `no room for $${rec.symbol}: ${avail.toFixed(3)} SOL free. ghost desk takes it`, "info", coin);
    await ghostEnter(b, rec, px, real, how, `no paper balance free (${avail.toFixed(3)} SOL)`, cfg, true);
    return;
  }
  log(b, "SIZE", `${size.toFixed(3)} SOL on $${rec.symbol} (${cfg.sizePct}% of desk, ${how} entry)`, "info", coin);
  if (!px) return;
  // SHIELD: the scam guard, for every strategy, right before the money moves
  const cvNow = (await getCurves([rec.mint]).catch(() => ({} as Record<string, CurveView | null>)))[rec.mint];
  const grad = !cvNow || cvNow.complete;
  const mo = how === "momo" ? await momoSignal(rec.mint).catch(() => null) : null;
  const sh = await shield({ mint: rec.mint, symbol: rec.symbol, grad, sol: size, tokensRaw: BigInt(Math.max(0, Math.floor((size / px) * 1e6))), tape: rec.tape, buys5: mo?.b5, sells5: mo?.s5, ageMs: Date.now() - rec.createdAt, v5: (mo as any)?.v5, mcUsd: (mo as any)?.mc }).catch(() => null);
  if (sh && !sh.ok) {
    const f = (sh.hardFail || sh.softFail)!;
    log(b, "VET", `SHIELD stopped $${rec.symbol} (${how}): ${f.rule.replace(/_/g, " ")} (${f.v})${f.hard ? "" : ". FILM follows it"}`, "bad", coin);
    const p = r.pipeline();
    agentLog(p, [{ agent: "SHIELD", at: Date.now(), mint: rec.mint, symbol: rec.symbol, text: `$${rec.symbol}: ${f.hard ? "blocked" : "stopped"}, ${f.rule.replace(/_/g, " ")} (${f.v})`, tone: "bad", stance: f.hard ? -1 : -0.7 }]);
    await p.exec();
    await r.set(`rn:shield:${rec.mint}`, { at: Date.now(), checks: sh.checks }, { ex: 7 * 86400 });
    await logSkip(`shield_${f.rule}`, f.v, rec.mint, rec.symbol, px).catch(() => {});
    return;
  }
  if (sh) await r.set(`rn:shield:${rec.mint}`, { at: Date.now(), checks: sh.checks }, { ex: 7 * 86400 });
  // FILL at a fresh price: VET, SHIELD, FLOW and the X read take seconds, and the signal's price is stale by then.
  // Before v0.1.31 paper filled at the price from the start of the beat, however far the coin had moved since
  const fresh = (await priceOf([rec.mint], true).catch(() => ({} as Record<string, Px>)))[rec.mint];
  if (!fresh || fresh.src === "dex") {
    log(b, "EXEC", `$${rec.symbol}: no fresh price right before the buy. skipped`, "info", coin);
    return;
  }
  const ran = pct(fresh.px, px);
  if (ran * 100 > cfg.slippageBps) {
    log(b, "EXEC", `$${rec.symbol} ran ${fmtPct(ran)} during the checks, past the ${cfg.slippageBps / 100}% slippage limit. not chasing`, "info", coin);
    await logSkip("ran_during_checks", fmtPct(ran), rec.mint, rec.symbol, fresh.px).catch(() => {});
    return;
  }
  const pos = await buy(b, state, rec, size, fresh.px, cfg.slippageBps, kp, fresh.real, how, fresh.grad);
  if (!pos) return;
  // RISK watches the insiders' bags from here: dev, bundle wallets, snipers, top early buyers. A tape built from the
  // stream has no token accounts, so the desk reads the chain once for them, only for coins it actually buys
  let ins = rec.tape?.insiders || [];
  if (!ins.length && rec.tape?.src === "stream") {
    const full = await readTape(rec.mint, rec.creator, rec.createdAt, undefined, { rpc: true }).catch(() => null);
    ins = full?.insiders || [];
  }
  if (ins.length) {
    const amt = await tokenAmounts(ins.map((i) => i.acc)).catch(() => ({} as Record<string, number>));
    pos.watch = ins.map((i) => ({ acc: i.acc, role: i.role, base: amt[i.acc] ?? 0 })).filter((w) => w.base > 0);
    const held = pos.watch.filter((w) => w.role !== "dev").length;
    log(b, "RISK", `watching ${pos.watch.length} insider bags on $${rec.symbol}${pos.watch.some((w) => w.role === "dev") ? " incl. the dev" : ""}${held ? `, ${held} bundle/sniper/top wallets` : ""}`, "info", coin);
  }
  pos.xm = xm;
  if (REENTRY_NEXT.delete(rec.mint)) pos.reentry = true;
  await savePos(K.deskPos, pos, true);
}

/** Cash plus what every bag would bring in if sold now, after every cost (liquidation value, not the mid price). */
async function equity(state: DeskState, kp: Keypair | null, px: Record<string, { px: number; grad?: boolean; real?: number }>) {
  const pos = Object.values(await loadPositions(K.deskPos)).filter((p) => p.live === state.live);
  const held = pos.reduce((a, p) => {
    const q = px[p.mint];
    return a + sellProceeds(p.tokens, q?.px ?? p.lastPx, q?.grad ?? p.mkt?.grad ?? !!p.gradSeen, q?.real ?? p.mkt?.real ?? 0, COST, true);
  }, 0);
  const cash = state.live && kp ? LAST_BAL?.sol ?? state.liveBal ?? 0 : state.cash;
  return { value: cash + held, dayKey: dayKey() };
}

async function buy(b: Batch, state: DeskState, rec: Launch, sol: number, px: number, slip: number, kp: Keypair | null, real: number, how: Pos["how"], grad = rec.outcome === "BONDED"): Promise<Pos | null> {
  const coin = { mint: rec.mint, symbol: rec.symbol };
  let tokens = 0;
  let sig: string | undefined;
  let fillPx = px;
  let paperFixed = 0;
  if (state.live && kp) {
    try {
      const res = await swap(kp, WSOL, rec.mint, BigInt(Math.floor(sol * 1e9)), slip);
      sig = res.sig;
      // the books follow the confirmed transaction (tokens received, SOL spent incl. tip, fees and rent), not the quote
      const real = await realDelta(res.sig, kp.publicKey, rec.mint).catch(() => null);
      tokens = real && real.tok > 0 ? real.tok : Number(res.outRaw) / 1e6;
      if (real?.sol != null && real.sol < 0) paperFixed = -real.sol - sol;
      LIVE_FLOW += real?.sol ?? -sol;
      fillPx = sol / Math.max(tokens, 1e-9);
    } catch (e) {
      log(b, "EXEC", `buy $${rec.symbol} failed: ${safeErr(e)}`, "bad", coin);
      return null;
    }
  } else {
    const s0 = slipOf(sol, grad, real);
    if (s0 * 10_000 > slip) {
      log(b, "EXEC", `buy $${rec.symbol} refused: ${(s0 * 100).toFixed(1)}% slippage at ${sol.toFixed(3)} SOL is past the ${slip / 100}% limit (live would fail too)`, "info", coin);
      return null;
    }
    const fixed = txCost(sol, COST) + ATA_RENT;
    fillPx = px * (1 + s0);
    tokens = (sol * (1 - venueFee(grad, px * SUPPLY))) / fillPx;
    state.cash -= sol + fixed;
    paperFixed = fixed;
  }
  const now = Date.now();
  const why = how === "momo" ? `MOMO: ${rec.description || "traction after migration"}` : how === "mind" ? `MIND SEND ${(await mindJudgement(rec.mint).catch(() => null))?.conviction ?? ""}` : how === "wire" ? `@${rec.wire?.h} post (${rec.wire?.how})` : how === "early" ? `early read BOND ${rec.early?.score}` : how === "catch" ? `CATCH: ${rec.outcome === "BONDED" ? "migrated runner" : "hot curve"}` : how === "flash" ? "FLASH: first-seconds read" : `King ${rec.call?.verdict} ${rec.call?.score}${how === "stalk" ? ", bought the pullback" : ""}`;
  const ctx = await entryCtx(rec, fillPx, real, how).catch(() => undefined);
  b.trades.push({ id: `${now}${rec.mint.slice(0, 4)}b`, mint: rec.mint, symbol: rec.symbol, side: "buy", at: now, sol: r4(sol), cost: r4(sol + paperFixed), tokens, px: fillPx, reason: why, live: state.live, sig, mc: ctx ? mcUsd(fillPx, ctx.solUsd) : null });
  log(b, "EXEC", `bought $${rec.symbol} for ${sol.toFixed(3)} SOL${state.live ? (LAST_EXEC && Date.now() - LAST_EXEC.at < 60_000 ? ` · landed in ${(LAST_EXEC.ms / 1000).toFixed(1)}s (${LAST_EXEC.path} path)` : "") : " (paper)"}`, "ok", coin);
  return {
    mint: rec.mint,
    symbol: rec.symbol,
    name: rec.name,
    openedAt: now,
    entryPx: fillPx,
    costSol: sol + paperFixed,
    tokens,
    tokens0: tokens,
    mkt: { grad, real },
    soldSol: 0,
    tp1Done: false,
    lastPx: px,
    peakPx: px,
    king: rec.call?.score ?? rec.early?.score ?? 0,
    nano: rec.call?.nano?.score ?? null,
    live: state.live,
    series: [[now, px, real]],
    kind: kindOf(rec),
    how,
    msHi: -1,
    ctx,
    creator: rec.creator,
    wire: rec.wire ? { h: rec.wire.h, tid: rec.wire.tid, text: rec.wire.text, vamp: !!rec.wire.vamp } : null,
    // bought after migration: the migration rules do not apply
    ...(rec.outcome === "BONDED" ? { gradSeen: true } : {}),
  };
}

/** A MOMO signal: a pump.fun coin pulling real volume right now (usually after migration). Its own checks and slots. */
async function momoEntry(b: Batch, state: DeskState, m: string, q: Px, cfg: Cfg, eqValue: number, walletSol: number | null, kp: Keypair | null, posMap: Record<string, Pos>) {
  const r = redis();
  const now = Date.now();
  const c: any = cfg;
  const h = await momoSignal(m);
  if (!h) return;
  const known = await getLaunch(m);
  // a coin the rats may never have dug (launched before they watched, or long ago): enough to trade and to show
  const rec: Launch = known || ({ mint: m, sig: "", createdAt: now - h.ageMin * 60_000, creator: "", name: h.name, symbol: h.symbol, uri: "", image: "", description: "", twitter: "", telegram: "", website: "", devBuySol: 0, devN: 0, devB: 0, dugAt: now, dugBy: "MOMO", p0: 0, mcap0: 0, cp: {}, outcome: q.grad ? "BONDED" : undefined } as Launch);
  rec.description = `$${Math.round(h.v5 / 1000)}K volume in 5m, ${h.buyers5} buyers vs ${h.sellers5} sellers`;
  const coin = { mint: m, symbol: rec.symbol };
  const open = Object.values(posMap).filter((p) => p.how === "momo" && takesSlot(p)).length;
  // holder spread: top 10 token accounts, minus the pool vault (the biggest account once migrated)
  let top10: number | null = null;
  try {
    const la = await conn().getTokenLargestAccounts(new PublicKey(m));
    const amts = (la.value || []).map((x) => Number(x.uiAmount || 0)).sort((a, b2) => b2 - a);
    const rest = q.grad ? amts.slice(1) : amts;
    top10 = Math.round((rest.slice(0, 10).reduce((a, x) => a + x, 0) / 1e9) * 1000) / 10;
  } catch {}
  const wash = h.b5 + h.s5 > 0 && (h.buyers5 + h.sellers5) > 0 ? (h.b5 + h.s5) / (h.buyers5 + h.sellers5) : 0;
  const checks = [
    { rule: "traction", ok: h.v5 >= (c.momoMinVol5m ?? 25_000) && h.buyers5 >= (c.momoMinBuyers5m ?? 40), v: `$${Math.round(h.v5 / 1000)}K in 5m, $${Math.round(h.v1h / 1000)}K in 1h, ${h.buyers5} buyers` },
    { rule: "buy_pressure", ok: h.buyers5 >= h.sellers5 * (c.momoMinBuyRatio ?? 1.05), v: `${h.buyers5} buyers vs ${h.sellers5} sellers` },
    { rule: "not_a_farm", ok: wash < 6, v: `${wash.toFixed(1)} trades per trader` },
    { rule: "holder_spread", ok: top10 == null || top10 <= (c.momoMaxTop10 ?? 35), v: top10 == null ? "not read" : `top 10 hold ${top10}%` },
    { rule: "liquidity_ok", ok: !q.grad || q.real >= (c.momoMinPoolSol ?? 40), v: q.grad ? `${Math.round(q.real)} SOL in the pool` : `on the curve, ${q.curve?.progress ?? "?"}%` },
    { rule: "fresh_signal", ok: now - h.at < 3 * 60_000, v: `${Math.round((now - h.at) / 1000)}s old` },
    { rule: "open_slots", ok: open < (c.momoMaxOpen ?? 3) && !posMap[m], v: posMap[m] ? "already held by the desk" : `${open}/${c.momoMaxOpen ?? 3} MOMO slots` },
    { rule: "daily_loss_ok", ok: pct(eqValue, state.dayStart) > -cfg.dailyLoss, v: fmtPct(pct(eqValue, state.dayStart)) },
  ];
  const fails = checks.filter((x) => !x.ok);
  const fail = fails[0];
  await r.set(K.deskVet, { mint: m, symbol: rec.symbol, at: now, checks }, { ex: 3600 });
  await r.set(VET_KEY(m), { at: now, checks, passed: !fail }, { ex: 7 * 86400 });
  const dk = DAY_KEY(now);
  await r.hincrby(dk, fail ? `f:${fail.rule}` : "passed", 1);
  await r.hincrby(dk, "seen", 1);
  const deskBlock = !!fail && fails.every((x) => DESK_RULES.has(x.rule)) && !posMap[m];
  if (fail && !deskBlock) {
    log(b, "VET", `skipped MOMO's $${rec.symbol}: ${fail.rule.replace(/_/g, " ")} (${fail.v})`, "info", coin);
    if (fail.rule !== "fresh_signal") await logSkip(fail.rule, fail.v, m, rec.symbol, q.px).catch(() => {});
    return;
  }
  await r.set(ENTRY_KEY(m), { checks, flow: `$${Math.round(h.v5 / 1000)}K volume in 5m, ${h.buyers5} buyers vs ${h.sellers5} sellers, ${h.ch5 > 0 ? "+" : ""}${Math.round(h.ch5)}% 5m`, buzz: null, chase: 0 }, { ex: 3 * 3600 });
  if (deskBlock) {
    log(b, "VET", `MOMO's $${rec.symbol} passes; the desk is blocked (${fails.map((x) => `${x.rule.replace(/_/g, " ")} ${x.v}`).join(", ")}). ghost desk follows it`, "info", coin);
    await ghostEnter(b, rec, q.px, q.real, "momo", fails.map((x) => `${x.rule.replace(/_/g, " ")} ${x.v}`).join(", "), cfg);
    return;
  }
  log(b, "VET", `MOMO's $${rec.symbol} clean: ${checks.slice(0, 4).map((x) => x.v).join(", ")}`, "ok", coin);
  // v0.1.43: MOMO buys a pullback, not the spike. On 8 Oct it bought right after the volume burst at $109K to $824K and
  // lost 4 of 5. It now waits up to 10 minutes for a 12% dip (momoPullback) and buys the 5% bounce off the low.
  const dip = c.momoPullback ?? 12;
  if (dip > 0) {
    if (await r.hexists(K.deskStalk, m)) return;
    await r.hset(K.deskStalk, { [m]: { mint: m, symbol: rec.symbol, at: now, px0: q.px, depth: dip, hi: q.px, lo: q.px, armed: false, early: false, how: "momo", rec, mins: c.momoStalkMins ?? 10 } satisfies Stalk });
    log(b, "SIZE", `$${rec.symbol} (MOMO): waiting for a -${dip}% pullback and a bounce, up to ${c.momoStalkMins ?? 10}m`, "info", coin);
    return;
  }
  await enter(b, state, rec, q.px, q.grad ? 0 : q.real, eqValue, walletSol, kp, cfg, "momo", null);
}

/**
 * A CATCH signal: a coin moving like the ones that ran to $300K+. Its own checks (the curve window doesn't apply:
 * CATCH buys hot curves late and migrated coins), its own slots, its own sleeve.
 */
async function catchEntry(b: Batch, state: DeskState, m: string, q: Px, cfg: Cfg, eqValue: number, walletSol: number | null, kp: Keypair | null, posMap: Record<string, Pos>) {
  const r = redis();
  const now = Date.now();
  const c: any = cfg;
  const g = await catchSignal(m);
  if (!g) return;
  const known = await getLaunch(m);
  const rec: Launch = known || ({ mint: m, sig: "", createdAt: now, creator: "", name: g.sym, symbol: g.sym, uri: "", image: "", description: "", twitter: "", telegram: "", website: "", devBuySol: 0, devN: 0, devB: 0, dugAt: now, dugBy: "CATCH", p0: 0, mcap0: 0, cp: {}, outcome: q.grad ? "BONDED" : undefined } as Launch);
  const coin = { mint: m, symbol: rec.symbol };
  const t = rec.tape;
  const open = Object.values(posMap).filter((p) => p.how === "catch" && takesSlot(p)).length;
  // holder spread (pool vault excluded once migrated)
  let top10: number | null = null;
  try {
    const la = await conn().getTokenLargestAccounts(new PublicKey(m));
    const amts = (la.value || []).map((x) => Number(x.uiAmount || 0)).sort((a, z) => z - a);
    const rest = q.grad ? amts.slice(1) : amts.slice(1); // on the curve the biggest account is the curve itself
    top10 = Math.round((rest.slice(0, 10).reduce((a, x) => a + x, 0) / 1e9) * 1000) / 10;
  } catch {}
  const sol = (await solUsdCached()) || 150;
  const mcNow = q.px * SUPPLY * sol;
  const curveRec = q.grad ? { n: 0, avg: 0, win: 0, earned: false } : await catchStageRecord("curve");
  const checks = [
    { rule: "catch_signal", ok: true, v: `${g.by === "model" ? `P ${Math.round(g.p * 100)}%` : `score ${g.prior}`}: ${g.why.slice(0, 3).join(", ")}` },
    { rule: "fresh_signal", ok: now - g.at < 90_000, v: `${Math.round((now - g.at) / 1000)}s old` },
    { rule: "room_to_run", ok: mcNow <= g.target / 2, v: `$${Math.round(mcNow / 1000)}K now, aiming at $${Math.round(g.target / 1000)}K` },
    { rule: "not_a_farm", ok: !t?.farm?.farm, v: t?.farm?.farm ? t.farm.why : t ? `${t.organic ?? "?"} organic traders` : "not read" },
    { rule: "bundle_ok", ok: q.grad || !t || t.bundleShare * 100 <= cfg.maxBundle, v: t ? `${Math.round(t.bundleShare * 100)}% of SOL in` : "not read" },
    { rule: "holder_spread", ok: top10 == null || top10 <= (c.catchMaxTop10 ?? 40), v: top10 == null ? "not read" : `top 10 hold ${top10}%` },
    { rule: "liquidity_ok", ok: q.grad ? q.real >= (c.catchMinPoolSol ?? 30) : q.real >= 5, v: q.grad ? `${Math.round(q.real)} SOL in the pool` : `${q.real.toFixed(1)} SOL in the curve` },
    { rule: "open_slots", ok: open < (c.catchMaxOpen ?? 3) && !posMap[m], v: posMap[m] ? "already held by the desk" : `${open}/${c.catchMaxOpen ?? 3} CATCH slots` },
    { rule: "daily_loss_ok", ok: pct(eqValue, state.dayStart) > -cfg.dailyLoss, v: fmtPct(pct(eqValue, state.dayStart)) },
    // v0.1.29: real money only on what CATCH has proven. On 7 Oct it bought $5K-20K curve coins on its starting score:
    // 20 real trades, 1 winner, most stopped out at -20% to -80% within seconds (rugs move faster than any stop). The
    // ghost desk still follows these, so the record keeps building; the real desk joins once the model earns a band.
    { rule: "catch_earned", ok: g.by === "model", v: g.by === "model" ? `model band, P ${Math.round(g.p * 100)}%` : "starting score only, the model has not earned a band yet" },
    { rule: "migrated_only", ok: !!q.grad || curveRec.earned, v: q.grad ? "migrated" : curveRec.earned ? `curve trades earned it: last ${curveRec.n} averaged ${curveRec.avg}%, ${curveRec.win}% winners` : `on the curve ($${Math.round(mcNow / 1000)}K): locked until CATCH's last ${CURVE_UNLOCK.n} curve trades average +${CURVE_UNLOCK.avg}% (now ${curveRec.n} trades, ${curveRec.avg}%, ${curveRec.win}% winners)` },
  ];
  const fails = checks.filter((x) => !x.ok);
  const fail = fails[0];
  await r.set(K.deskVet, { mint: m, symbol: rec.symbol, at: now, checks }, { ex: 3600 });
  await r.set(VET_KEY(m), { at: now, checks, passed: !fail }, { ex: 7 * 86400 });
  const dk = DAY_KEY(now);
  await r.hincrby(dk, fail ? `f:${fail.rule}` : "passed", 1);
  await r.hincrby(dk, "seen", 1);
  const deskBlock = !!fail && fails.every((x) => DESK_RULES.has(x.rule) || x.rule === "catch_earned" || x.rule === "migrated_only") && !posMap[m];
  if (fail && !deskBlock) {
    log(b, "VET", `skipped CATCH's $${rec.symbol}: ${fail.rule.replace(/_/g, " ")} (${fail.v})`, "info", coin);
    if (fail.rule !== "fresh_signal") await logSkip(fail.rule, fail.v, m, rec.symbol, q.px).catch(() => {});
    return;
  }
  await r.set(ENTRY_KEY(m), { checks, flow: q.grad ? `migrated, ${Math.round(q.real)} SOL in the pool` : `curve ${q.curve?.progress ?? "?"}%`, buzz: `CATCH: ${g.why.join(", ")}`, chase: 0 }, { ex: 3 * 3600 });
  if (deskBlock) {
    log(b, "VET", `CATCH's $${rec.symbol} passes; the desk is blocked (${fails.map((x) => `${x.rule.replace(/_/g, " ")} ${x.v}`).join(", ")}). ghost desk follows it`, "info", coin);
    await ghostEnter(b, rec, q.px, q.real, "catch", fails.map((x) => `${x.rule.replace(/_/g, " ")} ${x.v}`).join(", "), cfg);
    return;
  }
  log(b, "VET", `CATCH's $${rec.symbol} clean: ${checks.slice(0, 1).concat(checks.slice(5, 7)).map((x) => x.v).join(", ")}`, "ok", coin);
  await enter(b, state, rec, q.px, q.grad ? 0 : q.real, eqValue, walletSol, kp, cfg, "catch", null);
}

/** FLASH: a launch seconds old whose first-seconds read earned a trade. Few checks (there is little to check yet),
 *  each one cheap: no chain reads beyond the price the desk already has. */
async function flashEntry(b: Batch, state: DeskState, m: string, q: Px, cfg: Cfg, eqValue: number, walletSol: number | null, kp: Keypair | null, posMap: Record<string, Pos>) {
  const r = redis();
  const now = Date.now();
  const c: any = cfg;
  const g = await flashSignal(m);
  if (!g) return;
  const rec = await getLaunch(m);
  if (!rec) return;
  const coin = { mint: m, symbol: rec.symbol };
  const open = Object.values(posMap).filter((p) => p.how === "flash" && takesSlot(p)).length;
  const prog = q.curve?.progress ?? g.prog;
  const checks = [
    { rule: "flash_signal", ok: true, v: `${g.stage}s look, ${g.by === "model" ? `P(2x, held) ${Math.round(g.p * 100)}%` : `score ${g.prior}`}` },
    // a first-seconds signal is worth nothing a few seconds later: the price has moved on
    { rule: "fresh_signal", ok: now - g.at < (c.flashFreshMs ?? 6000), v: `${((now - g.at) / 1000).toFixed(1)}s old` },
    { rule: "on_the_curve", ok: !q.grad && prog <= (c.flashMaxCurve ?? 65), v: q.grad ? "already migrated" : `curve ${Math.round(prog)}%` },
    { rule: "not_chased", ok: g.mcSol <= 0 || q.px * SUPPLY <= g.mcSol * (1 + (c.flashMaxChase ?? 40) / 100), v: g.mcSol > 0 ? `${Math.round((q.px * SUPPLY / g.mcSol - 1) * 100)}% since the look` : "n/a" },
    { rule: "dev_not_serial", ok: !(rec.devN >= cfg.serialDev && !rec.devB), v: `dev ${rec.devN} launches, ${rec.devB} bonded` },
    // SCAM WALLS from the first seconds of trades (v0.1.33). A check that could not be read counts as a fail: a coin
    // FLASH knows nothing about is not a coin to buy at seconds old
    { rule: "no_bundle", ok: g.first2s != null && g.first2s <= (c.flashMaxFirst2s ?? 0.5), v: g.first2s == null ? "not read" : `${Math.round(g.first2s * 100)}% of buying in the first 2 seconds (bundles, snipers)` },
    { rule: "spread_buyers", ok: g.top3 != null && g.top3 <= (c.flashMaxTop3 ?? 0.6), v: g.top3 == null ? "not read" : `top 3 buyers ${Math.round(g.top3 * 100)}% of buying` },
    { rule: "enough_wallets", ok: g.uniq != null && g.uniq >= (c.flashMinUniq ?? 6), v: g.uniq == null ? "not read" : `${g.uniq} wallets` },
    { rule: "dev_holding", ok: g.devSold === false, v: g.devSold == null ? "not read" : g.devSold ? "the dev already sold" : "dev holding" },
    { rule: "open_slots", ok: open < (c.flashMaxOpen ?? 3) && !posMap[m], v: posMap[m] ? "already held by the desk" : `${open}/${c.flashMaxOpen ?? 3} FLASH slots` },
    { rule: "daily_loss_ok", ok: pct(eqValue, state.dayStart) > -cfg.dailyLoss, v: fmtPct(pct(eqValue, state.dayStart)) },
  ];
  const fails = checks.filter((x) => !x.ok);
  const fail = fails[0];
  await r.set(K.deskVet, { mint: m, symbol: rec.symbol, at: now, checks }, { ex: 3600 });
  await r.set(VET_KEY(m), { at: now, checks, passed: !fail }, { ex: 7 * 86400 });
  const dk = DAY_KEY(now);
  await r.hincrby(dk, fail ? `f:${fail.rule}` : "passed", 1);
  await r.hincrby(dk, "seen", 1);
  const deskBlock = !!fail && fails.every((x) => DESK_RULES.has(x.rule)) && !posMap[m];
  if (fail && !deskBlock) {
    log(b, "VET", `skipped FLASH's $${rec.symbol}: ${fail.rule.replace(/_/g, " ")} (${fail.v})`, "info", coin);
    if (fail.rule !== "fresh_signal") await logSkip(fail.rule, fail.v, m, rec.symbol, q.px).catch(() => {});
    return;
  }
  await r.set(ENTRY_KEY(m), { checks, flow: `curve ${Math.round(prog)}% at ${g.stage}s`, buzz: `FLASH: ${g.why.join(", ")}`, chase: 0 }, { ex: 3 * 3600 });
  if (deskBlock) {
    log(b, "VET", `FLASH's $${rec.symbol} passes; the desk is blocked (${fails.map((x) => `${x.rule.replace(/_/g, " ")} ${x.v}`).join(", ")}). ghost desk follows it`, "info", coin);
    await ghostEnter(b, rec, q.px, q.real, "flash", fails.map((x) => `${x.rule.replace(/_/g, " ")} ${x.v}`).join(", "), cfg);
    return;
  }
  await r.lpush("rn:lat:sig2fill", Math.round((now - g.at) / 100) / 10).catch(() => 0);
  await r.ltrim("rn:lat:sig2fill", 0, 199).catch(() => {});
  log(b, "VET", `FLASH's $${rec.symbol} clean: ${checks.slice(0, 3).map((x) => x.v).join(", ")}`, "ok", coin);
  await enter(b, state, rec, q.px, q.real, eqValue, walletSol, kp, cfg, "flash", null);
}

async function solUsdCached() {
  return solUsd().catch(() => null);
}

/** A MIND SEND signal: its own checks (no curve window, no floor: MIND may buy migrated coins), its own slots. */
async function mindEntry(b: Batch, state: DeskState, rec: Launch, q: Px, cfg: Cfg, eqValue: number, walletSol: number | null, kp: Keypair | null, posMap: Record<string, Pos>) {
  const r = redis();
  const now = Date.now();
  const m = rec.mint;
  const coin = { mint: m, symbol: rec.symbol };
  const c: any = cfg;
  const j = await mindJudgement(m);
  const t = rec.tape;
  const open = Object.values(posMap).filter((p) => p.how === "mind" && takesSlot(p)).length;
  // MIND reads text the coin's creator wrote, so a SEND alone never buys: at least one signal MIND can't be talked into
  // must agree (King or nano BOND, tracked wallets in it, MOMO traction, or a post wave behind it)
  const tracked = await buyersOf(m).catch(() => [] as any[]);
  const indep = [
    rec.call?.verdict === "BOND" ? "King BOND" : null,
    rec.call?.nano?.verdict === "BOND" ? "nano BOND" : null,
    tracked.filter((x: any) => x.side !== "sell").length >= 1 ? `${tracked.length} tracked wallets` : null,
    (await momoSignal(m).catch(() => null)) ? "MOMO traction" : null,
    rec.wire?.trac && rec.wire.trac.copies >= 2 ? "post wave" : null,
  ].filter(Boolean) as string[];
  const checks = [
    { rule: "mind_send", ok: !!j && j.verdict === "SEND" && j.conviction >= (c.mindMin ?? 75), v: j ? `${j.verdict} ${j.conviction}: ${j.thesis.slice(0, 90)}` : "no judgement" },
    { rule: "fresh_signal", ok: !!j && now - j.at < 10 * 60_000, v: j ? `${Math.round((now - j.at) / 1000)}s old` : "-" },
    { rule: "independent_signal", ok: indep.length > 0, v: indep.join(", ") || "only MIND's read" },
    { rule: "liquidity_ok", ok: !q.grad || q.real >= (c.mindMinPoolSol ?? 20), v: q.grad ? `${Math.round(q.real)} SOL in the pool` : `on the curve, ${q.curve?.progress ?? "?"}%` },
    { rule: "not_a_farm", ok: !t?.farm?.farm, v: t?.farm?.farm ? t.farm.why : t ? `${t.organic ?? "?"} organic traders` : "not read" },
    { rule: "bundle_ok", ok: q.grad || !t || t.bundleShare * 100 <= cfg.maxBundle, v: t ? `${Math.round(t.bundleShare * 100)}% of SOL in` : "not read" },
    { rule: "open_slots", ok: open < (c.mindMaxOpen ?? 2) && !posMap[m], v: posMap[m] ? "already held by the desk" : `${open}/${c.mindMaxOpen ?? 2} MIND slots` },
    { rule: "daily_loss_ok", ok: pct(eqValue, state.dayStart) > -cfg.dailyLoss, v: fmtPct(pct(eqValue, state.dayStart)) },
  ];
  const fails = checks.filter((x) => !x.ok);
  const fail = fails[0];
  await r.set(K.deskVet, { mint: m, symbol: rec.symbol, at: now, checks }, { ex: 3600 });
  await r.set(VET_KEY(m), { at: now, checks, passed: !fail }, { ex: 7 * 86400 });
  const dk = DAY_KEY(now);
  await r.hincrby(dk, fail ? `f:${fail.rule}` : "passed", 1);
  await r.hincrby(dk, "seen", 1);
  const deskBlock = !!fail && fails.every((x) => DESK_RULES.has(x.rule)) && !posMap[m];
  if (fail && !deskBlock) {
    log(b, "VET", `skipped MIND's $${rec.symbol}: ${fail.rule.replace(/_/g, " ")} (${fail.v})`, "info", coin);
    if (fail.rule !== "mind_send" && fail.rule !== "fresh_signal") await logSkip(fail.rule, fail.v, m, rec.symbol, q.px).catch(() => {});
    return;
  }
  await r.set(ENTRY_KEY(m), { checks, flow: q.grad ? `migrated, ${Math.round(q.real)} SOL in the pool` : null, buzz: j ? `MIND: ${j.thesis}` : null, chase: 0 }, { ex: 3 * 3600 });
  if (deskBlock) {
    log(b, "VET", `MIND's $${rec.symbol} passes; the desk is blocked (${fails.map((x) => `${x.rule.replace(/_/g, " ")} ${x.v}`).join(", ")}). ghost desk follows it`, "info", coin);
    await ghostEnter(b, rec, q.px, q.real, "mind", fails.map((x) => `${x.rule.replace(/_/g, " ")} ${x.v}`).join(", "), cfg);
    return;
  }
  log(b, "VET", `MIND's $${rec.symbol} clean: SEND ${j!.conviction}${q.grad ? `, migrated, ${Math.round(q.real)} SOL pool` : ""}`, "ok", coin);
  await enter(b, state, rec, q.px, q.grad ? 0 : q.real, eqValue, walletSol, kp, cfg, "mind", null);
}

async function sell(b: Batch, state: DeskState, p: Pos, frac: number, px: number, reason: string, slip: number, kp: Keypair | null) {
  const coin = { mint: p.mint, symbol: p.symbol };
  const amt = frac >= 1 ? p.tokens : p.tokens * frac;
  let proceeds = 0;
  let sig: string | undefined;
  // a real-money position is only ever sold with the key (never "sold" on paper by a process without it)
  if (p.live && !kp) {
    log(b, "RISK", `$${p.symbol}: live position, but this process has no wallet key. the worker sells it`, "bad", coin);
    return false;
  }
  if (p.live && kp) {
    try {
      const have = await tokenBalanceRaw(kp.publicKey, p.mint);
      const raw = frac >= 1 ? have : (have * BigInt(Math.round(frac * 1000))) / 1000n;
      if (raw <= 0n) {
        p.tokens = 0;
        return true;
      }
      const res = await swap(kp, p.mint, WSOL, raw, slip);
      sig = res.sig;
      const real = await realDelta(res.sig, kp.publicKey, p.mint).catch(() => null);
      proceeds = real?.sol != null && real.sol > 0 ? real.sol : Number(res.outRaw) / 1e9;
      LIVE_FLOW += proceeds;
    } catch (e) {
      log(b, "RISK", `sell $${p.symbol} failed, retrying next beat: ${safeErr(e)}`, "bad", coin);
      return false;
    }
  } else {
    proceeds = sellProceeds(amt, px, p.mkt?.grad ?? !!p.gradSeen, p.mkt?.real ?? 0, COST, frac >= 1 || amt >= p.tokens - 1e-9);
    state.cash += proceeds;
  }
  const costPart = p.costSol * (amt / p.tokens0);
  const pnl = proceeds - costPart;
  p.tokens -= amt;
  p.soldSol += proceeds;
  state.realized += pnl;
  const now = Date.now();
  const pnlPct = pct(proceeds, costPart);
  const sol$ = await solUsd().catch(() => null);
  b.trades.push({ id: `${now}${p.mint.slice(0, 4)}s`, mint: p.mint, symbol: p.symbol, side: "sell", at: now, sol: r4(proceeds), tokens: amt, px, reason, pnlSol: r4(pnl), pnlPct: Math.round(pnlPct * 10) / 10, live: p.live, sig, mc: mcUsd(px, sol$) });
  log(b, "RISK", `${reason}: sold ${frac >= 1 ? "all" : `${Math.round(frac * 100)}%`} of $${p.symbol}`, pnl >= 0 ? "win" : "loss", coin);
  if (p.tokens <= 1e-9) {
    p.tokens = 0;
    if (p.live && kp) closeEmptyAccount(kp, p.mint).catch(() => false);
    await noteStageResult(p).catch(() => {});
    // keep the whole trade for the public track record: chart, the call behind it, peak while held
    const step = Math.max(1, Math.ceil((p.series?.length || 0) / 90));
    const series = (p.series || []).filter((_, i, a) => i % step === 0 || i === a.length - 1).map(([t, x]) => [t, x] as [number, number]);
    await redis().lpush(TRIPS_KEY, { mint: p.mint, symbol: p.symbol, openedAt: p.openedAt, closedAt: Date.now(), king: p.king, nano: p.nano, how: p.how || "direct", entryPx: p.entryPx, peakPx: Math.max(p.peakPx || 0, px), exitPx: px, series, ctx: await withLens(p.ctx, p.mint) } satisfies TripMeta);
    await redis().ltrim(TRIPS_KEY, 0, 999);
    await redis().incr(SEQ.trips).catch(() => 0);
    // COACH keeps watching the coin after we leave it: 5m, 15m, 1h, 2h, 6h, 1d, 7d
    await follow({ id: tripId(p.mint, p.openedAt), mint: p.mint, symbol: p.symbol, creator: p.creator, createdAt: p.ctx?.createdAt, closedAt: Date.now(), entryPx: p.entryPx, exitPx: px, exitGrad: !!p.gradSeen, reason }).catch(() => {});
    log(b, "COACH", `following $${p.symbol} after the exit: checks at 5m, 15m, 1h, 2h, 6h, 1d and 7d, and what moved it`, "info", coin);
    await noteExit(`${sleeveOf(p.how, p.wire?.vamp)}:${p.tier || "micro"}`, Math.max(p.peakPx || 0, px) / p.entryPx, ((p.peakAt ?? p.openedAt) - p.openedAt) / 60_000).catch(() => {});
    const pmNote = await pmClose(sleeveOf(p.how, p.wire?.vamp), Math.log(Math.max(1e-6, p.soldSol) / Math.max(1e-9, p.costSol))).catch(() => null);
    if (pmNote) log(b, "PM", pmNote, "info");
    if (p.wire?.h) await notePnl(p.wire.h, p.soldSol - p.costSol).catch(() => {});
    state.closed++;
    const total = p.soldSol - p.costSol;
    if (total > 0) state.wins++;
    log(b, "LEDGER", `closed $${p.symbol} ${total >= 0 ? "+" : ""}${total.toFixed(3)} SOL (${fmtPct(pct(p.soldSol, p.costSol))})`, total >= 0 ? "win" : "loss", coin);
  }
  return true;
}

// ---------------------------------------------------------------- ghost desk

/** Take a trade in the ghost book: same fill rules as paper, a fixed size, nothing touches the real books. */
async function ghostEnter(b: Batch, rec: Launch, px: number, real: number, how: Pos["how"], blocked: string, cfg: Cfg, checked = false) {
  const r = redis();
  const coin = { mint: rec.mint, symbol: rec.symbol };
  if (!px || (await r.hexists(GHOST_POS, rec.mint))) return;
  if (((await r.hlen(GHOST_POS)) || 0) >= GHOST_MAX) {
    log(b, "SIZE", `$${rec.symbol}: ghost desk full (${GHOST_MAX} open), not followed`, "info", coin);
    return;
  }
  // v0.1.43: the ghost desk skips falling coins too, so its record keeps measuring what the real desk would do
  if (!checked && !KNIFE_SKIP.has(how || "")) {
    const k = await knife(rec.mint, px, cfg);
    if (k.falling) {
      skipFalling(b, rec, how || "direct", k, true);
      return;
    }
    px = k.px;
  }
  const sol = cfg.ghostSol ?? 0.1;
  // same costs as paper; a migrated coin with no pool read is costed on a fresh migration pool (~85 SOL)
  const grad = rec.outcome === "BONDED" || real === 0;
  const rl = grad && !real ? 85 : real;
  const fixed = txCost(sol, COST) + ATA_RENT;
  const fillPx = px * (1 + slipOf(sol, grad, rl));
  const tokens = (sol * (1 - venueFee(grad, px * SUPPLY))) / fillPx;
  const now = Date.now();
  const ctx = await entryCtx(rec, fillPx, real, how).catch(() => undefined);
  const why = how === "momo" ? `MOMO: ${rec.description || "traction after migration"}` : how === "mind" ? `MIND SEND ${(await mindJudgement(rec.mint).catch(() => null))?.conviction ?? ""}` : how === "wire" ? `@${rec.wire?.h} post (${rec.wire?.how})` : how === "early" ? `early read BOND ${rec.early?.score}` : how === "catch" ? `CATCH: ${rec.outcome === "BONDED" ? "migrated runner" : "hot curve"}` : how === "flash" ? "FLASH: first-seconds read" : `King ${rec.call?.verdict} ${rec.call?.score}`;
  (b.ghost ||= []).push({ id: `${now}${rec.mint.slice(0, 4)}b`, mint: rec.mint, symbol: rec.symbol, side: "buy", at: now, sol, cost: r4(sol + fixed), tokens, px: fillPx, reason: `${why} · ghost: ${blocked}`, live: false, mc: ctx ? mcUsd(fillPx, ctx.solUsd) : null });
  const pos: Pos = { mint: rec.mint, symbol: rec.symbol, name: rec.name, openedAt: now, entryPx: fillPx, costSol: sol + fixed, tokens, tokens0: tokens, soldSol: 0, tp1Done: false, lastPx: px, peakPx: px, king: rec.call?.score ?? rec.early?.score ?? 0, nano: rec.call?.nano?.score ?? null, live: false, series: [[now, px, real]], kind: kindOf(rec), how, msHi: -1, ctx, creator: rec.creator, ghost: blocked, mkt: { grad, real: rl }, wire: rec.wire ? { h: rec.wire.h, tid: rec.wire.tid, text: rec.wire.text, vamp: !!rec.wire.vamp } : null, ...(rec.outcome === "BONDED" ? { gradSeen: true } : {}) };
  const ins = rec.tape?.insiders || [];
  if (ins.length) {
    const amt = await tokenAmounts(ins.map((i) => i.acc)).catch(() => ({} as Record<string, number>));
    pos.watch = ins.map((i) => ({ acc: i.acc, role: i.role, base: amt[i.acc] ?? 0 })).filter((w) => w.base > 0);
  }
  await savePos(GHOST_POS, pos, true);
  log(b, "EXEC", `ghost desk bought $${rec.symbol} for ${sol} SOL (the real desk is blocked: ${blocked}). not counted, learned from`, "info", coin);
}

/** Sell in the ghost book. Returns true when the position is fully closed. */
async function ghostSell(b: Batch, p: Pos, frac: number, px: number, reason: string) {
  const coin = { mint: p.mint, symbol: p.symbol };
  const amt = frac >= 1 ? p.tokens : p.tokens * frac;
  const proceeds = sellProceeds(amt, px, p.mkt?.grad ?? !!p.gradSeen, p.mkt?.real ?? 0, COST, frac >= 1 || amt >= p.tokens - 1e-9);
  const costPart = p.costSol * (amt / p.tokens0);
  const pnl = proceeds - costPart;
  p.tokens -= amt;
  p.soldSol += proceeds;
  const now = Date.now();
  const sol$ = await solUsd().catch(() => null);
  (b.ghost ||= []).push({ id: `${now}${p.mint.slice(0, 4)}s`, mint: p.mint, symbol: p.symbol, side: "sell", at: now, sol: r4(proceeds), tokens: amt, px, reason, pnlSol: r4(pnl), pnlPct: Math.round(pct(proceeds, costPart) * 10) / 10, live: false, mc: mcUsd(px, sol$) });
  log(b, "RISK", `ghost: ${reason}: sold ${frac >= 1 ? "all" : `${Math.round(frac * 100)}%`} of $${p.symbol}`, "info", coin);
  if (p.tokens > 1e-9) return false;
  p.tokens = 0;
  await noteStageResult(p).catch(() => {});
  const step = Math.max(1, Math.ceil((p.series?.length || 0) / 90));
  const series = (p.series || []).filter((_, i, a) => i % step === 0 || i === a.length - 1).map(([t, x]) => [t, x] as [number, number]);
  await redis().lpush(GHOST_TRIPS, { mint: p.mint, symbol: p.symbol, openedAt: p.openedAt, closedAt: now, king: p.king, nano: p.nano, how: p.how || "direct", entryPx: p.entryPx, peakPx: Math.max(p.peakPx || 0, px), exitPx: px, series, ctx: await withLens(p.ctx, p.mint) } satisfies TripMeta);
  await redis().ltrim(GHOST_TRIPS, 0, 999);
  await redis().incr(SEQ.gtrips).catch(() => 0);
  // COACH follows ghost exits too (5m to 7d), and PM hears how a paused strategy would have done
  await follow({ id: `g:${tripId(p.mint, p.openedAt)}`, mint: p.mint, symbol: p.symbol, creator: p.creator, createdAt: p.ctx?.createdAt, closedAt: now, entryPx: p.entryPx, exitPx: px, exitGrad: !!p.gradSeen, reason }).catch(() => {});
  await noteExit(`${sleeveOf(p.how, p.wire?.vamp)}:${p.tier || "micro"}`, Math.max(p.peakPx || 0, px) / p.entryPx, ((p.peakAt ?? p.openedAt) - p.openedAt) / 60_000).catch(() => {});
  const note = await pmGhost(sleeveOf(p.how, p.wire?.vamp), Math.log(Math.max(1e-6, p.soldSol) / Math.max(1e-9, p.costSol))).catch(() => null);
  if (note) log(b, "PM", note, "win");
  const total = p.soldSol - p.costSol;
  log(b, "LEDGER", `ghost desk closed $${p.symbol} ${total >= 0 ? "+" : ""}${total.toFixed(3)} SOL (${fmtPct(pct(p.soldSol, p.costSol))}). not counted`, "info", coin);
  return true;
}

// ---------------------------------------------------------------- read side

const BEAT_KEY = "rn:desk:beat"; // last time a desk beat finished
let beatWrittenAt = 0;
const DAY_KEY = (t: number) => `rn:desk:day:${new Date(t).toISOString().slice(0, 10)}`;

/** The equity line for the desk page: the last 12 hours, one point every ~5 minutes (the full line is /api/desk/equity). */
async function equityForPage() {
  const xs = ((await redis().lrange<{ t: number; eq: number; live?: boolean }>(K.deskEq, -720, -1)) || []) as { t: number; eq: number; live?: boolean }[];
  const step = Math.max(1, Math.ceil(xs.length / 150));
  return xs.filter((_, i) => i % step === 0 || i === xs.length - 1);
}

/** What the desk is doing right now, what it is waiting for, and what unlocks next. */
async function rightNow(learnS: Learn) {
  const r = redis();
  const now = Date.now();
  const lat = async (k: string) => {
    const xs = ((await r.lrange<number>(`rn:lat:${k}`, 0, 99).catch(() => [])) || []).map(Number).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return xs.length ? { p50: xs[Math.floor(xs.length / 2)], n: xs.length } : null;
  };
  const speedP = memo("desk:speed:view", 60_000, () => Promise.all([lat("call"), lat("early"), lat("flash"), lat("intake_rpc"), lat("sig2fill"), lat("stream")]).then(([call, early, flash, chain, fill, stream]) => ({ call, early, flash, chain, fill, stream })));
  const [beat, day, hist, nano, st, rpc] = await Promise.all([
    r.get<number>(BEAT_KEY),
    r.hgetall<Record<string, number>>(DAY_KEY(now)),
    memo("desk:hist:view", 30_000, () => getHistory()).catch(() => null as any),
    memo("desk:nano:view", 60_000, () => loadModel(K.nano)),
    r.hmget<Record<string, number>>(K.stat, "bond_n"),
    r.get<{ at: number; day?: { budget: number; used: number; pace: number } }>("rn:rpc").catch(() => null),
  ]);
  const d = (day || {}) as Record<string, number>;
  // the day's chain budget (v0.1.36): past pace the rats (King calls) and the agents (CATCH) wait, the desk does not
  const bd = rpc && now - Number(rpc.at || 0) < 120_000 && rpc.day?.budget ? rpc.day : null;
  const fails = Object.entries(d)
    .filter(([k]) => k.startsWith("f:"))
    .map(([k, v]) => ({ rule: k.slice(2), n: Number(v) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 4);
  return {
    beatAt: beat ? Number(beat) : null,
    running: !!beat && now - Number(beat) < 90_000,
    today: { seen: Number(d.seen || 0), passed: Number(d.passed || 0), fails },
    kingBond: Number((st as any)?.bond_n || 0),
    budget: bd ? { used: bd.used, pace: bd.pace, budget: bd.budget, ratsPaused: bd.used >= bd.pace * 1.05, agentsPaused: bd.used >= bd.pace } : null,
    nano: { n: nano.nl || 0, min: NANO_MIN }, // v0.1.41: live lessons
    early: { n: learnS.earlyStat.n, min: LEARN_RULES.earlyMin, on: learnS.earlyOn },
    stalkOn: learnS.stalkOn,
    history: hist ? { phase: hist.phase, done: hist.done ?? 0, lessons: hist.lessons ?? 0, clock: hist.clock ?? null } : null,
    // how fast the protocol is: seconds after a launch is born (median of the last 100)
    speed: await speedP.catch(() => null),
  };
}

export async function getDesk() {
  const r = redis();
  const s = await getSettings();
  const p = r.pipeline();
  p.get(K.deskState);
  p.hgetall(K.deskPos);
  p.lrange(K.deskEv, 0, 59);
  p.hgetall(K.deskAgent);
  p.get(K.deskVet);
  p.hgetall(K.deskStalk);
  p.hlen(K.deskShadow);
  p.hlen(K.deskAfter);
  // v0.1.41: the slow parts (equity, learning, COACH, FILM, PM, ghost counts, the wallet balance) at most once a
  // minute per process; the page is rebuilt every few seconds by the worker (lib/site.ts) for every viewer
  const [[st, pos, ev, agents, vet, stalks, nShadow, nAfter], trades, eqs] = (await Promise.all([p.exec(), deskTrades().then((t) => t.slice(0, 60)), memo("desk:eq", 60_000, () => equityForPage())])) as [any[], Trade[], { t: number; eq: number; live?: boolean }[]];
  const state: DeskState = st || (await loadState(s.desk.start));
  await withSeries(K.deskPos, pos, true);
  const learnS = await memo("desk:learn:view", 30_000, loadLearn);
  const addr = deskWalletAddress() || state.wallet || process.env.DESK_WALLET_ADDRESS || null;
  const walletSol = addr ? await memo("desk:wsol:view", 20_000, () => cachedBalance(addr)) : null;
  // the exam reads up to 2,000 trades (with their entry context) and 3,000 equity points: once per 30s for every
  // visitor, not on every page poll
  const exC = await r.get<{ at: number; ex: Exam }>(EXAM_FULL).catch(() => null);
  const fresh = !!exC && Date.now() - Number(exC.at) < 30_000 && Array.isArray(exC.ex?.checks);
  const ex = fresh ? exC!.ex : await exam(state, walletSol);
  if (!fresh) await r.set(EXAM_FULL, { at: Date.now(), ex }, { ex: 120 }).catch(() => null);
  // the page draws a small sparkline: 90 points of each path are plenty (positions carry up to 360)
  for (const k of Object.keys(pos || {})) {
    const ser = pos[k]?.series;
    if (Array.isArray(ser) && ser.length > 90) {
      const step = Math.ceil(ser.length / 90);
      pos[k].series = ser.filter((_: unknown, i: number) => i % step === 0 || i === ser.length - 1);
    }
  }
  const arms = ARMS.map((a) => {
    const x = learnS.arms[String(a)];
    return { arm: a, n: x.n, fills: x.fills, mean: x.n ? Math.round((Math.exp(x.sum / x.n) - 1) * 1000) / 10 : null };
  });
  return {
    mode: s.desk.mode,
    live: state.live,
    wallet: addr, // the desk wallet is public, paper or live
    walletSol,
    walletReady: !!addr,
    cfg: s.desk,
    state,
    exam: ex,
    positions: Object.values(pos || {}).map((x: any) => ({ ...x, watch: undefined, nWatch: (x.watch || []).length })),
    trades: trades || [],
    events: ev || [],
    equity: eqs || [],
    agents: agents || {},
    vet: vet || null,
    stalks: Object.values(stalks || {}),
    coach: await memo("desk:coach:view", 60_000, () => coachStats()).catch(() => null),
    film: await memo("desk:film:view", 60_000, () => filmStats()).catch(() => null),
    pm: await memo("desk:pm:view", 20_000, () => pmView()).catch(() => null),
    ghost: await memo("desk:ghost:view", 30_000, async () => {
      const r = redis();
      const [open, n] = await Promise.all([r.hlen(GHOST_POS), r.llen(GHOST_TRADES)]);
      return { open: open || 0, fills: n || 0, max: GHOST_MAX };
    }).catch(() => null),
    wire: await wireViewPublic(40).catch(() => null),
    learn: { ...learnS, arms, shadows: nShadow || 0, reviewing: nAfter || 0, rules: LEARN_RULES, xConnected: !!process.env.X_BEARER_TOKEN },
    now: await rightNow(learnS).catch(() => null),
  };
}


// ---------------------------------------------------------------- track record (public)

const TRIPS_KEY = "rn:desk:trips"; // closed trades with their chart and context
// GHOST DESK: signals that pass every check on the coin but are blocked only by the desk itself (daily loss limit,
// full slots, a paused strategy, no paper balance left) are traded anyway in a separate book, with the same entries
// and exits. Ghost trades never touch the balance, the exam or the track record; COACH, FILM and the priors learn
// from them, so the desk keeps learning on its worst and busiest days.
export const GHOST_POS = "rn:ghost:pos";
// CATCH on the curve: real money only once its own closed trades there (ghost and real, after fees and slippage)
// prove it. Every closed CATCH trade adds its result to the list for its stage; the curve stage unlocks at 30+ trades
// averaging +5% or better with 30%+ winners, and locks again the moment the last 30 fall below that.
const STAGE_RES = (stage: "curve" | "pool") => `rn:ct:res:${stage}`;
async function noteStageResult(p: Pos) {
  if (p.reentry && p.costSol > 0 && !p.ghost) {
    await redis().lpush(REENT_RES, Math.round((p.soldSol / p.costSol - 1) * 1000) / 10);
    await redis().ltrim(REENT_RES, 0, 49);
  }
  if (p.how !== "catch" || !(p.costSol > 0)) return;
  const stage = p.ctx?.curve != null && !p.gradSeen ? "curve" : "pool";
  const r = redis();
  await r.lpush(STAGE_RES(stage), Math.round(((p.soldSol / p.costSol) - 1) * 1000) / 10);
  await r.ltrim(STAGE_RES(stage), 0, 59);
}
export const CURVE_UNLOCK = { n: 30, avg: 5, win: 0.3 };
const REENT = "rn:desk:reent"; // stopped-out coins watched for a reclaim of the entry (30 minutes)
const REENT_RES = "rn:desk:res:reentry"; // results of re-entries (% after costs)
const REENTRY_NEXT = new Set<string>();
/** Re-entries stay on until their own last 20 results average below zero with under 35% winners; back on above +5%. */
export async function reentryRecord() {
  return memo("desk:reentry", 60_000, async () => {
    const xs = ((await redis().lrange<number>(REENT_RES, 0, 19).catch(() => [])) || []).map(Number).filter(Number.isFinite);
    const n = xs.length;
    const avg = n ? xs.reduce((a, x) => a + x, 0) / n : 0;
    const win = n ? xs.filter((x) => x > 0).length / n : 0;
    const prevOn = (await redis().get<number>("rn:desk:reent:on").catch(() => 1)) ?? 1;
    let on = !!Number(prevOn);
    if (n >= 20 && on && avg < 0 && win < 0.35) on = false;
    else if (n >= 20 && !on && avg > 5) on = true;
    if (on !== !!Number(prevOn)) await redis().set("rn:desk:reent:on", on ? 1 : 0).catch(() => null);
    return { n, avg: Math.round(avg * 10) / 10, win: Math.round(win * 100), on };
  });
}
export async function catchStageRecord(stage: "curve" | "pool") {
  return memo(`ct:stage:${stage}`, 60_000, async () => {
    const xs = ((await redis().lrange<number>(STAGE_RES(stage), 0, 29).catch(() => [])) || []).map(Number).filter(Number.isFinite);
    const n = xs.length;
    const avg = n ? xs.reduce((a, x) => a + x, 0) / n : 0;
    const win = n ? xs.filter((x) => x > 0).length / n : 0;
    return { n, avg: Math.round(avg * 10) / 10, win: Math.round(win * 100), earned: n >= CURVE_UNLOCK.n && avg >= CURVE_UNLOCK.avg && win >= CURVE_UNLOCK.win };
  });
}
const GHOST_TRADES = "rn:ghost:trades";
const GHOST_TRIPS = "rn:ghost:trips";
// v0.1.40: change counters of the four big lists (lib/lcache.ts listCached): readers fetch only the newest rows
const SEQ = { trades: "rn:desk:trades:seq", trips: "rn:desk:trips:seq", gtrades: "rn:ghost:trades:seq", gtrips: "rn:ghost:trips:seq" };
const tradeId = (t: Trade) => t.id;
const tripMetaId = (m: TripMeta) => `${m.mint}|${m.openedAt}`;
export const deskTrades = () => listCached<Trade>(K.deskTrades, SEQ.trades, 2000, tradeId);
const ghostTrades = () => listCached<Trade>(GHOST_TRADES, SEQ.gtrades, 2000, tradeId);
const tripMetas = (ghost: boolean) => listCached<TripMeta>(ghost ? GHOST_TRIPS : TRIPS_KEY, ghost ? SEQ.gtrips : SEQ.trips, 1000, tripMetaId);
const GHOST_MAX = 10;
const DESK_RULES = new Set(["daily_loss_ok", "open_slots"]);
const GHOSTABLE = new Set([...DESK_RULES, "nano_agrees"]);
// strategies with their own slot count (the King's lane never fills up with them, nor they with the King's)
const OWN_LANE = new Set(["wire", "mind", "momo", "catch", "flash"]);
/**
 * A position takes a slot only while its cost is at risk. Once initials are taken the rest is house money: it rides on
 * the trail and frees the slot, so a handful of moonbags can never freeze the desk (seen in the 12h sim: 7 bags held
 * every slot for 6 hours and the desk stopped trading).
 */
const takesSlot = (p: Pos) => !p.tp1Done;
export const VET_KEY = (m: string) => `rn:vet:${m}`; // the last VET verdict on a coin (7 days)
const ENTRY_KEY = (m: string) => `rn:entry:${m}`; // checks, flow and buzz of the signal that is about to be bought

/** Curve price (SOL per token) at a given curve %, so drawdowns can be read from the curve high. */
function curvePx(progress: number) {
  const sold = (Math.max(0, Math.min(100, progress)) / 100) * 793.1e6;
  const vTok = 1073e6 - sold;
  return (30 * 1073e6) / vTok / vTok;
}
const mcUsd = (px: number, sol: number | null) => (px > 0 && sol ? Math.round(px * SUPPLY * sol) : null);

async function entryCtx(rec: Launch, px: number, real: number, how: Pos["how"]): Promise<EntryCtx> {
  const now = Date.now();
  const [sol, sig] = await Promise.all([solUsd().catch(() => null), redis().get<{ checks: EntryCtx["checks"]; flow: string; buzz: string; chase: number }>(ENTRY_KEY(rec.mint)).catch(() => null)]);
  const t = rec.tape;
  const g = rec.g;
  const callPx = rec.call?.px || 0;
  return {
    createdAt: rec.createdAt,
    ageMs: now - rec.createdAt,
    curve: real > 0 && rec.outcome !== "BONDED" ? progressFromSol(real) : null,
    callAt: rec.call?.at ?? rec.early?.at ?? null,
    callCurve: rec.call?.progress ?? rec.early?.curve ?? null,
    callMc: callPx ? mcUsd(callPx, sol) : null,
    chasePct: callPx ? Math.round(pct(px, callPx) * 10) / 10 : null,
    king: rec.call ? { score: rec.call.score, verdict: rec.call.verdict } : null,
    nano: rec.call?.nano ? { score: rec.call.nano.score, verdict: rec.call.nano.verdict } : null,
    early: rec.early ? { score: rec.early.score, verdict: rec.early.verdict } : null,
    checks: sig?.checks || [],
    flow: how === "stalk" ? "bought the pullback after the bounce" : sig?.flow ?? null,
    buzz: sig?.buzz ?? null,
    tape: t ? { n: t.n, vel: t.vel, uniq: t.uniq, organic: t.organic ?? null, spb: t.solPerBuy, buyShare: t.buyShare, bundle: t.bundleShare, bundleN: t.bundleN, snipers: t.sniperN, top5: t.top5, devSold: t.devSold } : null,
    graph: g ? { funder: g.funder ?? null, clN: g.clN, clB: g.clB, clRatio: g.clRatio, smartN: g.smartN } : null,
    dev: { launches: rec.devN ?? 0, bonded: rec.devB ?? 0, buySol: rec.devBuySol ?? 0 },
    socials: { x: !!rec.twitter, tg: !!rec.telegram, web: !!rec.website },
    meta: rec.meta ? { hot: rec.meta.hot ?? null, copy: !!rec.meta.copy } : null,
    solUsd: sol,
    sleeve: sleeveOf(how, rec.wire?.vamp),
    wire: rec.wire ? { h: rec.wire.h, text: rec.wire.text, how: rec.wire.how, lagSec: rec.wire.lagSec, trust: (await accountOf(rec.wire.h).catch(() => ({ w: 0 }))).w } : null,
    wallets: await (async () => {
      const bs = await buyersOf(rec.mint).catch(() => []);
      return bs.length ? bs.slice(0, 8).map((x: any) => ({ name: x.cls === "smart" ? "smart wallet" : x.name, cls: CLASS_LABEL[x.cls as keyof typeof CLASS_LABEL] || x.cls, conf: x.conf, sol: x.sol, minsBefore: Math.round((now - x.at) / 60_000) })) : null;
    })(),
    mind: await (async () => {
      const j = await mindJudgement(rec.mint).catch(() => null);
      return j ? { verdict: j.verdict, conviction: j.conviction, thesis: j.thesis, narrative: j.narrative, reasons: j.reasons, risks: j.risks } : null;
    })(),
    card: await (async () => {
      const ln = await lensDossier(rec.mint).catch(() => null);
      return {
        plus: rec.call?.why?.plus || [],
        minus: rec.call?.why?.minus || [],
        parts: rec.call?.parts ?? null,
        nc: rec.call?.nc ?? null,
        lens: ln && ln.done ? { score: ln.score, flags: ln.flags, good: ln.good } : null,
      };
    })(),
  };
}
/** Attach the LENS dossier to a trade's context when it was not ready at the buy. */
async function withLens(ctx: EntryCtx | undefined, mint: string) {
  if (!ctx || ctx.card?.lens) return ctx;
  const ln = await lensDossier(mint).catch(() => null);
  if (!ln?.done) return ctx;
  return { ...ctx, card: { plus: ctx.card?.plus || [], minus: ctx.card?.minus || [], parts: ctx.card?.parts ?? null, nc: ctx.card?.nc ?? null, lens: { score: ln.score, flags: ln.flags, good: ln.good } } };
}
type TripMeta = { mint: string; symbol: string; openedAt: number; closedAt: number; king: number; nano: number | null; how: string; entryPx: number; peakPx: number; exitPx: number; series: [number, number][]; ctx?: EntryCtx };

export type Trip = {
  mint: string;
  symbol: string;
  openedAt: number;
  closedAt: number | null;
  open: boolean;
  live: boolean;
  costSol: number;
  backSol: number; // SOL received from sells so far
  valueSol: number; // what is still held, at the live price (open trips)
  pnlSol: number; // realized + unrealized
  pnlPct: number;
  why: string; // why it bought
  exits: { at: number; sol: number; reason: string; pnlPct: number | null; sig?: string; px?: number; mc?: number | null; tokens?: number }[];
  buySig?: string;
  holdMs: number;
  tokens?: number; // bought
  held?: number; // still held
  entryMc?: number | null; // USD market cap at the buy
  exitMc?: number | null; // at the last sell
  nowMc?: number | null; // live, open trips
  peakMc?: number | null; // best seen while held
  ctx?: EntryCtx | null;
  after?: Check[]; // COACH follow-ups after the exit
  // context for the detail view
  king?: number;
  nano?: number | null;
  how?: string;
  entryPx?: number;
  peakPct?: number | null; // best price seen while held, vs entry
  exitPct?: number | null; // last sell price vs entry
  series?: [number, number][];
};

/** Every trade the desk made, grouped into round trips: entry, each exit, result. Open trips at the live price. */
export async function getRecord(onlyMint?: string, book: "real" | "ghost" = "real") {
  const r = redis();
  const ghost = book === "ghost";
  const [trades, posMap, st, metas, sol] = await Promise.all([
    ghost ? ghostTrades() : deskTrades(),
    r.hgetall<Record<string, Pos>>(ghost ? GHOST_POS : K.deskPos).then((x) => withSeries(ghost ? GHOST_POS : K.deskPos, x, true)),
    r.get<DeskState>(K.deskState),
    tripMetas(ghost),
    solUsd().catch(() => null),
  ]);
  const metaBy: Record<string, TripMeta> = {};
  for (const m of (metas || []) as TripMeta[]) metaBy[`${m.mint}|${m.openedAt}`] = m;
  const list = ((trades || []) as Trade[]).slice().reverse(); // oldest first
  const pos = (posMap || {}) as Record<string, Pos>;
  const trips: Trip[] = [];
  const openBy: Record<string, Trip> = {};
  const costOut = new Map<Trip, number>();
  for (const t of list) {
    if (t.side === "buy") {
      const prev = openBy[t.mint];
      if (prev) {
        prev.open = false;
        prev.closedAt = prev.exits.length ? prev.exits[prev.exits.length - 1].at : t.at;
      }
      const trip: Trip = { mint: t.mint, symbol: t.symbol, openedAt: t.at, closedAt: null, open: true, live: t.live, costSol: t.sol, backSol: 0, valueSol: 0, pnlSol: 0, pnlPct: 0, why: t.reason, exits: [], buySig: t.sig, holdMs: 0, tokens: t.tokens, entryMc: t.mc ?? (t.px ? mcUsd(t.px, sol) : null), ctx: t.ctx ?? null };
      trips.push(trip);
      openBy[t.mint] = trip;
    } else {
      const trip = openBy[t.mint];
      if (!trip) continue;
      trip.backSol += t.sol;
      // what this sale cost us at entry, from the sell's own books (proceeds minus its P&L): exact, fees included
      if (t.pnlSol != null) costOut.set(trip, (costOut.get(trip) || 0) + (t.sol - t.pnlSol));
      trip.exits.push({ at: t.at, sol: t.sol, reason: t.reason, pnlPct: t.pnlPct ?? null, sig: t.sig, px: t.px, mc: t.mc ?? (t.px ? mcUsd(t.px, sol) : null), tokens: t.tokens });
    }
  }
  const now = Date.now();
  for (const trip of trips) {
    const p = pos[trip.mint];
    const isOpen = trip.open && !!p && openBy[trip.mint] === trip;
    trip.open = isOpen;
    if (!isOpen && trip.closedAt == null) trip.closedAt = trip.exits.length ? trip.exits[trip.exits.length - 1].at : trip.openedAt;
    // v0.1.36: P&L the same way the books count it. Before, a trip cost only its size (the tip, priority fee and
    // account rent were left out) and an open position was valued at the mid price, so the track record showed
    // +0.009 SOL realized while the balance was down 3.9%. Now: the real cost (the position's own, or what its sells
    // say it cost), and an open position at what selling it would bring after every cost.
    if (isOpen && p) trip.costSol = p.costSol;
    else if (costOut.has(trip)) trip.costSol = costOut.get(trip)!;
    else trip.costSol = (list.find((x) => x.side === "buy" && x.mint === trip.mint && x.at === trip.openedAt)?.cost) ?? trip.costSol;
    trip.valueSol = isOpen && p ? sellProceeds(p.tokens, p.lastPx || 0, p.mkt?.grad ?? !!p.gradSeen, p.mkt?.real ?? 0, COST, true) : 0;
    trip.pnlSol = r4(trip.backSol + trip.valueSol - trip.costSol);
    trip.pnlPct = trip.costSol ? Math.round(((trip.backSol + trip.valueSol) / trip.costSol - 1) * 1000) / 10 : 0;
    trip.backSol = r4(trip.backSol);
    trip.valueSol = r4(trip.valueSol);
    trip.costSol = r4(trip.costSol);
    trip.holdMs = (trip.closedAt ?? now) - trip.openedAt;
    // context: live position while open, the saved record once closed
    const m = metaBy[`${trip.mint}|${trip.openedAt}`];
    const src = isOpen && p ? { king: p.king, nano: p.nano, how: p.how || "direct", entryPx: p.entryPx, peakPx: Math.max(p.peakPx || 0, p.lastPx || 0), series: (p.series || []).map(([t, x]) => [t, x] as [number, number]) } : m;
    if (src) {
      trip.king = src.king;
      trip.nano = src.nano;
      trip.how = src.how;
      trip.entryPx = src.entryPx;
      trip.peakPct = src.entryPx ? Math.round((src.peakPx / src.entryPx - 1) * 1000) / 10 : null;
      const step = Math.max(1, Math.ceil(src.series.length / 90));
      trip.series = src.series.filter((_, i, a) => i % step === 0 || i === a.length - 1);
    }
    const lastExit = trip.exits[trip.exits.length - 1];
    trip.exitPct = trip.entryPx && lastExit?.px ? Math.round((lastExit.px / trip.entryPx - 1) * 1000) / 10 : null;
    trip.exitMc = !isOpen ? lastExit?.mc ?? null : null;
    trip.nowMc = isOpen && p ? (p.usd ?? mcUsd(p.lastPx, sol)) : null;
    trip.held = isOpen && p ? p.tokens : 0;
    if (!trip.ctx) trip.ctx = (isOpen && p ? p.ctx : m?.ctx) ?? null;
    const sol0 = trip.ctx?.solUsd ?? sol;
    const peakPx = isOpen && p ? Math.max(p.peakPx || 0, p.lastPx || 0) : m?.peakPx;
    trip.peakMc = peakPx ? mcUsd(peakPx, sol0) : null;
  }
  const closed = trips.filter((t) => !t.open);
  const recent = onlyMint ? closed.filter((t) => t.mint === onlyMint) : closed.slice(-60);
  const fid = (t: Trip) => `${ghost ? "g:" : ""}${tripId(t.mint, t.openedAt)}`;
  const fol = await followsFor(recent.map(fid)).catch(() => ({} as Record<string, Check[]>));
  for (const t of recent) t.after = fol[fid(t)] || [];
  const wins = closed.filter((t) => t.pnlSol > 0);
  const sum = (a: Trip[], f: (t: Trip) => number) => a.reduce((x, t) => x + f(t), 0);
  const best = closed.reduce<Trip | null>((b, t) => (!b || t.pnlPct > b.pnlPct ? t : b), null);
  const worst = closed.reduce<Trip | null>((b, t) => (!b || t.pnlPct < b.pnlPct ? t : b), null);
  const start = st?.live ? st.liveStart ?? st.start : st?.start ?? 0;
  if (ghost) {
    // the ghost book has no balance: its return is on what it staked
    const staked = sum(trips, (t) => t.costSol);
    const pnl = sum(trips, (t) => t.pnlSol);
    return {
      live: false,
      ghost: true,
      summary: {
        trips: trips.length, open: trips.filter((t) => t.open).length, closed: closed.length, wins: wins.length,
        winRate: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : null,
        realizedSol: r4(sum(closed, (t) => t.pnlSol)), openSol: r4(sum(trips.filter((t) => t.open), (t) => t.pnlSol)),
        start: r4(staked), equity: r4(staked + pnl), returnPct: staked ? Math.round((pnl / staked) * 1000) / 10 : null,
        best: best ? { symbol: best.symbol, mint: best.mint, pnlPct: best.pnlPct } : null,
        worst: worst ? { symbol: worst.symbol, mint: worst.mint, pnlPct: worst.pnlPct } : null,
        avgHoldMs: closed.length ? Math.round(sum(closed, (t) => t.holdMs) / closed.length) : null,
        since: trips.length ? trips[0].openedAt : null,
      },
      trips: onlyMint ? trips.reverse().filter((t) => t.mint === onlyMint) : trips.reverse().slice(0, 300).map((t, i) => (i < 60 ? t : { ...t, series: undefined, ctx: undefined })),
    };
  }
  return {
    live: !!st?.live,
    summary: {
      trips: trips.length,
      open: trips.filter((t) => t.open).length,
      closed: closed.length,
      wins: wins.length,
      winRate: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : null,
      realizedSol: r4(sum(closed, (t) => t.pnlSol)),
      openSol: r4(sum(trips.filter((t) => t.open), (t) => t.pnlSol)),
      start: r4(start),
      equity: r4(st?.equity ?? start),
      returnPct: start ? Math.round((((st?.equity ?? start) / start) - 1) * 1000) / 10 : null,
      best: best ? { symbol: best.symbol, mint: best.mint, pnlPct: best.pnlPct } : null,
      worst: worst ? { symbol: worst.symbol, mint: worst.mint, pnlPct: worst.pnlPct } : null,
      avgHoldMs: closed.length ? Math.round(sum(closed, (t) => t.holdMs) / closed.length) : null,
      since: st?.startedAt ?? null,
    },
    // charts only for the newest 60 trades, so the record stays light
    trips: onlyMint
      ? trips.reverse().filter((t) => t.mint === onlyMint)
      : trips.reverse().slice(0, 300).map((t, i) => (i < 60 ? t : { ...t, series: undefined, ctx: undefined })),
  };
}
