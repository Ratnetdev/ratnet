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

import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { K, dayKey, redis } from "./redis";
import { conn, getCurves, safeErr, CurveView, solUsd } from "./solana";
import { getMarket } from "./market";
import { readPools, type PoolRead } from "./pool";
import { getSettings } from "./settings";
import { tokenAmounts, progressFromSol, readTape } from "./tape";
import { xMentions } from "./buzz";
import { levelOf, loadRunner, MILESTONES, pNext, RK, Run } from "./runner";
import { NANO_MIN, type NanoModel } from "./nano";
import { agentLog, type AgentEv } from "./agents";
import { coachStats, coachStep, follow, followsFor, tripId, type Check } from "./coach";
import { filmStats, filmStep, logSkip } from "./film";
import { exitProfiles, noteExit, onClose as pmClose, onGhost as pmGhost, pmView, sleeveOf, sleeveWeight, type ExitProfile } from "./pm";
import { accountOf, notePnl, wireView } from "./wire";
import { getHistory } from "./historian";
import { enqueueLens, lensDossier } from "./lens";
import { mindJudgement } from "./mind";
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
  lastPx: number;
  peakPx: number;
  king: number;
  nano: number | null;
  live: boolean;
  series: Sample[];
  how?: "direct" | "stalk" | "early" | "wire" | "mind" | "momo";
  wire?: { h: string; tid: string; text: string; vamp?: boolean } | null; // the post a tweet coin was born from
  peakAt?: number; // when the price peaked while held (exit profiles)
  msHi?: number; // highest milestone the ladder has acted on
  pn?: number; // P(next milestone) at the last check
  noPxSince?: number; // first beat with no price (curve complete, not migrated yet)
  trail?: number; // current trailing stop width %
  usd?: number; // market cap USD now
  watch?: Watch[]; // insider token accounts and their balance at entry
  ins?: number | null; // insiders' bag now vs entry (1 = untouched)
  dev?: number | null; // dev's bag now vs entry
  gradSeen?: boolean;
  xm?: number | null;
  ctx?: EntryCtx;
  ghost?: string | null; // ghost desk position: why the real desk could not take it
  creator?: string;
  devSellPx?: number; // price when the dev sold past the line while we held (memes: we hold, COACH scores it)
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
  // PRIOR "holding floor": skip a coin that already dumped far from its high. A starting hint from the dev, not a law:
  // every coin it skips is followed in shadow, and COACH drops the rule if those coins do better than the ones bought.
  floorOn: boolean;
  floor: { n: number; sum: number }; // skipped-for-dump signals: count and summed 30-minute log return
  // PRIOR "socials": a coin with no X, website or Telegram is usually a quick rug, unless it is tied to a tweet.
  // Same deal as the floor: skipped coins are followed in shadow and COACH drops the prior if they do better.
  socialsOn: boolean;
  socials: { n: number; sum: number };
  // PRIOR "post traction": a tweet coin only counts when its post spawned a wave (3+ coins or 25+ SOL across them).
  // Most headlines move nothing. Skipped tweet coins are followed in shadow; COACH drops the prior if they do better.
  tractionOn: boolean;
  traction: { n: number; sum: number };
  // trail scale per strategy sleeve (tweet coins and vamps dump fast after the first push; King calls can run)
  trailBy: Record<string, number>;
};
export const LEARN_RULES = {
  devMin: 15, // dev-sell cases before the dev exit can switch itself on
  devSaved: 0.6, // share of cases where selling with the dev beat holding
  floorMax: 40, // % under the coin's high (since launch) where the floor prior skips it
  floorMin: 30, // skipped cases before COACH can overrule the floor prior
  floorEdge: 0.05, // skipped coins must beat bought coins by this much (30-minute log return) to overrule it
  socialsMin: 30, // skipped no-socials cases before COACH can overrule the socials prior
  socialsEdge: 0.05,
  tractionMin: 20, // skipped low-traction tweet coins before COACH can overrule the traction prior
  tractionEdge: 0.05,
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
    floorOn: true,
    floor: { n: 0, sum: 0 },
    socialsOn: true,
    socials: { n: 0, sum: 0 },
    tractionOn: true,
    traction: { n: 0, sum: 0 },
    trailBy: {},
  };
}

type ArmTrack = { hi: number; lo: number; armed: boolean; fill: number | null };
type Shadow = { k: string; mint: string; symbol: string; at: number; px0: number; hi: number; lo: number; last: number; early: boolean; arms: Record<string, ArmTrack>; tag?: "floor" | "socials" | "traction" };
type After = { mint: string; symbol: string; at: number; exitPx: number; peakHeld: number; reason: string; hi: number; lo: number; tunable: boolean; sl?: string };
type Stalk = { mint: string; symbol: string; at: number; px0: number; depth: number; hi: number; lo: number; armed: boolean; early: boolean };

export const EXAM = { trades: 30, winRate: 40, pnlPct: 10, maxDD: 30, minWallet: 0.5, liveMaxDD: 40 };
const FEE = 0.01; // pump.fun fee per side
const PAPER_SLIP = 0.02; // assumed slippage per side on paper
const WSOL = "So11111111111111111111111111111111111111112";
const LOOP_MS = 2000;
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
  return l ? { ...e, ...l, arms: { ...e.arms, ...(l.arms || {}) }, earlyStat: { ...e.earlyStat, ...(l.earlyStat || {}) }, devStat: { ...e.devStat, ...(l.devStat || {}) }, floor: { ...e.floor, ...(l.floor || {}) }, floorOn: l.floorOn ?? e.floorOn, socials: { ...e.socials, ...(l.socials || {}) }, socialsOn: l.socialsOn ?? e.socialsOn, traction: { ...e.traction, ...(l.traction || {}) }, tractionOn: l.tractionOn ?? e.tractionOn, trailBy: { ...(l.trailBy || {}) } } : e;
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

export async function resetDesk() {
  const r = redis();
  const s = await getSettings();
  await r.del(K.deskState, K.deskPos, K.deskTrades, K.deskEv, K.deskQ, K.deskEq, K.deskAgent, K.deskVet, K.deskShadow, K.deskAfter, K.deskStalk);
  await loadState(s.desk.start);
}

function wallet(): Keypair | null {
  const sec = process.env.DESK_WALLET_SECRET;
  if (!sec) return null;
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

async function swap(kp: Keypair, inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number) {
  const q = await fetch(`${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`, {
    headers: jupHeaders(),
    cache: "no-store",
  });
  if (!q.ok) throw new Error(`no route (${q.status})`);
  const quote = await q.json();
  if (!quote?.outAmount) throw new Error("no route");
  const s = await fetch(`${JUP}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json", ...jupHeaders() },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 3_000_000, priorityLevel: "veryHigh" } },
    }),
    cache: "no-store",
  });
  if (!s.ok) throw new Error(`swap build failed (${s.status})`);
  const { swapTransaction } = await s.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([kp]);
  const raw = tx.serialize();
  const c = conn();
  const sig = await c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  // rebroadcast every 1.5s until confirmed or 25s pass
  const t0 = Date.now();
  while (Date.now() - t0 < 25_000) {
    const st = await c.getSignatureStatuses([sig]);
    const v = st.value[0];
    if (v?.err) throw new Error(`tx failed ${sig.slice(0, 8)}`);
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") return { sig, outRaw: BigInt(quote.outAmount) };
    await c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`not confirmed ${sig.slice(0, 8)}`);
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
  }
  if (b.ghost?.length) {
    p.lpush(GHOST_TRADES, ...b.ghost);
    p.ltrim(GHOST_TRADES, 0, 1999);
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

export async function exam(state: DeskState, walletSol: number | null): Promise<Exam> {
  const trades = ((await redis().lrange<Trade>(K.deskTrades, 0, 499)) || []).filter((t) => t.side === "sell" && !t.live && t.pnlSol != null);
  // a position can close in several sells; group by mint to count each round trip once
  const byPos: Record<string, number> = {};
  for (const t of trades) byPos[t.mint] = (byPos[t.mint] || 0) + (t.pnlSol || 0);
  const rounds = Object.values(byPos);
  const last = rounds.slice(0, 50);
  const wins = last.filter((x) => x > 0).length;
  const winRate = last.length ? (wins / last.length) * 100 : 0;
  const pnlPct = pct(state.equity, state.start);
  // worst drawdown over the last 30 trades (not all time), so one bad stretch can't lock the exam forever
  const buys = ((await redis().lrange<Trade>(K.deskTrades, 0, 1999)) || []).filter((t) => t.side === "buy" && !t.live);
  const since = buys.length ? buys[Math.min(buys.length, EXAM.trades) - 1].at : Date.now();
  const eqs = (((await redis().lrange<{ t: number; eq: number; live: boolean }>(K.deskEq, -3000, -1)) || []) as { t: number; eq: number; live: boolean }[]).filter((x) => !x.live && x.t >= since);
  let peak = 0;
  let dd30 = 0;
  for (const x of [...eqs, { t: Date.now(), eq: state.equity, live: false }]) {
    peak = Math.max(peak, x.eq);
    if (peak > 0) dd30 = Math.max(dd30, ((peak - x.eq) / peak) * 100);
  }
  const checks = [
    { label: "paper round trips", need: `≥ ${EXAM.trades}`, now: String(rounds.length), ok: rounds.length >= EXAM.trades },
    { label: "win rate", need: `≥ ${EXAM.winRate}%`, now: `${winRate.toFixed(0)}%`, ok: winRate >= EXAM.winRate },
    { label: "paper profit", need: `≥ +${EXAM.pnlPct}%`, now: fmtPct(pnlPct), ok: pnlPct >= EXAM.pnlPct },
    { label: "worst drawdown (last 30 trades)", need: `≤ ${EXAM.maxDD}%`, now: `${dd30.toFixed(0)}%`, ok: dd30 <= EXAM.maxDD },
    { label: "funded wallet", need: `≥ ${EXAM.minWallet} SOL`, now: walletSol == null ? "none" : `${walletSol.toFixed(2)} SOL`, ok: walletSol != null && walletSol >= EXAM.minWallet },
  ];
  return { trades: rounds.length, winRate, pnlPct, maxDD: Math.round(dd30 * 10) / 10, walletSol, checks, passed: checks.every((c) => c.ok) };
}

// ---------------------------------------------------------------- prices

type Px = { px: number; real: number; curve: CurveView | null; grad: boolean };
async function priceOf(mints: string[]) {
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
  return px;
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

const PRIOR_RULES: Record<string, "floor" | "socials" | "traction"> = { holding_floor: "floor", has_socials: "socials", post_traction: "traction" };

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
  if (sh.tag === "floor" || sh.tag === "socials" || sh.tag === "traction") {
    // a coin a prior skipped: would buying it anyway have paid?
    const ret = Math.log(Math.max(1e-9, end) / sh.px0);
    const tg = sh.tag;
    const st = tg === "floor" ? l.floor : tg === "socials" ? l.socials : l.traction;
    st.n++;
    st.sum += ret;
    const direct = l.arms["0"];
    const takenMean = direct.n ? direct.sum / direct.n : 0;
    const skipMean = st.sum / st.n;
    const was = tg === "floor" ? l.floorOn : tg === "socials" ? l.socialsOn : l.tractionOn;
    const min = tg === "floor" ? LEARN_RULES.floorMin : tg === "socials" ? LEARN_RULES.socialsMin : LEARN_RULES.tractionMin;
    const edge = tg === "floor" ? LEARN_RULES.floorEdge : tg === "socials" ? LEARN_RULES.socialsEdge : LEARN_RULES.tractionEdge;
    const now = st.n >= min ? !(skipMean > takenMean + edge) : was;
    if (tg === "floor") l.floorOn = now;
    else if (tg === "socials") l.socialsOn = now;
    else l.tractionOn = now;
    const what = tg === "floor" ? "dumped from its high" : tg === "socials" ? "no X, website or Telegram" : "a post that spawned no wave";
    log(b, "COACH", `${sh.tag} review $${sh.symbol} (skipped, ${what}): ${fmtPct((Math.exp(ret) - 1) * 100)} in 30m. skipped avg ${fmtPct((Math.exp(skipMean) - 1) * 100)} vs bought ${fmtPct((Math.exp(takenMean) - 1) * 100)} over ${st.n} cases`, ret > 0 ? "bad" : "ok", { mint: sh.mint, symbol: sh.symbol });
    if (was !== now) log(b, "COACH", now ? `${sh.tag} prior back on: skipped coins are doing worse than the ones bought` : `${sh.tag} prior overruled: coins it skipped (${what}) did better than the ones bought`, "win");
    return;
  }
  const parts: string[] = [];
  for (const a of ARMS) {
    const t = sh.arms[String(a)];
    const arm = l.arms[String(a)];
    const ret = t.fill ? Math.log(Math.max(1e-9, end) / t.fill) : 0;
    arm.n++;
    arm.sum += ret;
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
  l.stalkOn = bestEdge >= LEARN_RULES.stalkEdge;
  l.stalkArm = l.stalkOn ? best : 0;
  log(b, "COACH", `entry review $${sh.symbol}${sh.early ? " (early read)" : ""}: ${parts.join(", ")}`, "info", { mint: sh.mint, symbol: sh.symbol });
  if (l.stalkOn !== was) log(b, "COACH", l.stalkOn ? `pullback entries unlocked: waiting for a -${best}% dip beats buying now by ${(bestEdge * 100).toFixed(0)}%` : "pullback entries locked again: buying now is doing as well", l.stalkOn ? "win" : "info");
}

function reviewExit(l: Learn, a: After, b: Batch): boolean {
  // decide once the coin has shown us which way it went after we sold
  const ranAfter = a.hi >= a.exitPx * 2;
  const dumped = a.lo <= a.exitPx * 0.6;
  const expired = Date.now() - a.at > LEARN_RULES.coachHours * 3600_000;
  if (!ranAfter && !dumped && !expired) return false;
  const coin = { mint: a.mint, symbol: a.symbol };
  l.reviews++;
  const gaveBack = a.peakHeld > 0 ? 1 - a.exitPx / a.peakHeld : 0;
  const sl = a.sl || "king";
  l.trailBy ||= {};
  const cur = l.trailBy[sl] ?? l.trailK;
  if (ranAfter && a.tunable) {
    l.early++;
    l.trailBy[sl] = Math.min(1.6, cur * 1.06);
    if (sl === "king") l.trailK = l.trailBy[sl];
    log(b, "COACH", `$${a.symbol} ran to ${(a.hi / a.exitPx).toFixed(1)}x after we sold (${a.reason}). ${sl} trails widened to ${l.trailBy[sl].toFixed(2)}x`, "bad", coin);
  } else if (a.tunable && gaveBack >= 0.4) {
    l.late++;
    l.trailBy[sl] = Math.max(0.5, cur * 0.97);
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
  l.earlyOn = s.n >= LEARN_RULES.earlyMin && er >= mr;
}

// ---------------------------------------------------------------- the loop

/**
 * One desk session: loops every 2s for up to `budgetMs`, handling entries from the queue and exits for every position.
 * Called by the cron pinger (budget ~55s) so coverage is continuous with one ping a minute.
 */
export async function deskSession(budgetMs = 50_000, onBeat?: () => Promise<unknown>) {
  const r = redis();
  const got = await r.set("rn:lock:desk", Date.now(), { nx: true, ex: Math.ceil(budgetMs / 1000) + 8 });
  if (!got) return { skipped: "busy" };
  const t0 = Date.now();
  let loops = 0;
  const b: Batch = { ev: [], trades: [] };
  try {
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
    const kp = wallet();
    let lastBeat = 0;
    let sol = (await solUsd()) || 0;
    let runModel: NanoModel = await loadRunner();
    let prof: Record<string, ExitProfile> = await exitProfiles(cfg.initialsAt, cfg.timeStop).catch(() => ({}));
    let emp: Record<string, number> = (await r.hgetall<Record<string, number>>(RK.emp)) || {};
    let runs: Record<string, Run | null> = {};
    let lastRunsAt = 0;
    const recent: Record<string, Sample[]> = {}; // 2s samples kept in memory for the flow read

    let lastErrAt = 0;
    let hadErr = false;
    let digging: Promise<unknown> | null = null;
    let walletAt = 0;
    let walletSolC: number | null = null;
    while (Date.now() - t0 < budgetMs) {
      loops++;
      const now = Date.now();
      try {
      // the dig runs next to the desk, never in front of it: positions keep their 2s beat while the rats dig
      if (onBeat && !digging && now - lastBeat > 10_000) {
        lastBeat = now;
        digging = onBeat().catch(() => null).finally(() => (digging = null));
      }
      const posMap = (await r.hgetall<Record<string, Pos>>(K.deskPos)) || {};
      const positions = Object.values(posMap);
      // signals older than 3 minutes are stale by the desk's own rule: drop them quietly, newest calls first
      const stale = Number((await r.zremrangebyscore(K.deskQ, 0, now - 180_000)) || 0);
      if (stale) log(b, "VET", `dropped ${stale} stale signal${stale > 1 ? "s" : ""} (older than 3 minutes)`, "info");
      const queued = ((await r.zrange<string[]>(K.deskQ, 0, 9, { rev: true })) || []) as string[];
      const slow = loops % 3 === 1; // shadows, stalks and coach every ~6s
      const shadows = slow ? (await r.hgetall<Record<string, Shadow>>(K.deskShadow)) || {} : {};
      const afters = slow ? (await r.hgetall<Record<string, After>>(K.deskAfter)) || {} : {};
      const stalks = (await r.hgetall<Record<string, Stalk>>(K.deskStalk)) || {};

      // --- promotion / demotion
      if (kp && now - walletAt > 15_000) {
        walletAt = now;
        walletSolC = (await conn().getBalance(kp.publicKey).catch(() => 0)) / 1e9;
      }
      const walletSol = kp ? walletSolC : null;
      if (!state.live && (cfg.mode === "live" || cfg.mode === "auto") && kp && !positions.length) {
        const ex = cfg.mode === "live" ? { passed: walletSol != null && walletSol >= EXAM.minWallet } : await exam(state, walletSol);
        if (ex.passed) {
          state.live = true;
          state.liveStart = walletSol;
          state.promotedAt = now;
          state.peakEq = walletSol || 0;
          log(b, "LEDGER", `exam passed. going live with ${walletSol?.toFixed(3)} SOL`, "win");
        }
      }

      const closeAll = !!(await r.get("rn:desk:closeall"));
      if (closeAll) await r.del("rn:desk:closeall");

      const ghosts = Object.values(((await r.hgetall<Record<string, Pos>>(GHOST_POS)) || {}) as Record<string, Pos>);
      // --- prices for everything we hold, stalk, shadow, review or might buy (ghost positions in the same batch)
      const px = await priceOf(
        Array.from(new Set([...positions.map((p) => p.mint), ...ghosts.map((p) => p.mint), ...queued.map((x) => x.replace(/^[wmr]:/, "")), ...Object.keys(stalks), ...Object.values(shadows).map((x) => x.mint), ...Object.values(afters).map((x) => x.mint)]))
      );
      if (now - lastRunsAt > 10_000) {
        lastRunsAt = now;
        sol = (await solUsd()) || sol;
        const ms = positions.map((p) => p.mint);
        const got2 = ms.length ? await r.mget<(Run | null)[]>(...ms.map(RK.run)) : [];
        runs = Object.fromEntries(ms.map((m, i) => [m, got2[i]]));
        if (loops % 30 === 1) {
          runModel = await loadRunner();
          prof = await exitProfiles(cfg.initialsAt, cfg.timeStop).catch(() => prof);
          emp = (await r.hgetall<Record<string, number>>(RK.emp)) || {};
        }
      }

      // --- insiders (every other beat): token balances of the dev, bundle wallets, snipers, top early buyers
      if (loops % 2 === 1) {
        const accs = Array.from(new Set([...positions, ...ghosts].flatMap((p) => (p.watch || []).map((w) => w.acc))));
        if (accs.length) {
          const amt = await tokenAmounts(accs).catch(() => null);
          if (amt)
            for (const p of [...positions, ...ghosts]) {
              const w = p.watch || [];
              const dev = w.filter((x) => x.role === "dev" && x.base > 0);
              const ins = w.filter((x) => x.role !== "dev" && x.base > 0);
              const base = ins.reduce((a, x) => a + x.base, 0);
              p.ins = base ? Math.round((ins.reduce((a, x) => a + (amt[x.acc] ?? x.base), 0) / base) * 1000) / 1000 : null;
              p.dev = dev.length ? Math.round(((amt[dev[0].acc] ?? dev[0].base) / dev[0].base) * 1000) / 1000 : null;
            }
        }
      }

      // the exit rules (RISK), shared by the real desk and the ghost desk so both trade exactly alike
      const decide = (p: Pos, q: Px, gt = "") => {
        p.noPxSince = undefined;
        p.lastPx = q.px;
        if (q.px > p.peakPx) p.peakAt = now;
        p.peakPx = Math.max(p.peakPx, q.px);
        const rs = (recent[p.mint] ||= []);
        // this strategy's own exit profile (initials, time stop) and COACH's trail scale for it
        const sl = sleeveOf(p.how, p.wire?.vamp);
        const pf = prof[sl];
        // MOMO coins move fast both ways: tighter starting exits until their own record says otherwise
        const mo = sl === "momo";
        const c2: any = cfg;
        const initialsAt = pf?.initials ?? (mo ? c2.momoInitials ?? 40 : cfg.initialsAt);
        const timeStop = pf?.timeStop ?? (mo ? c2.momoTimeStop ?? 40 : cfg.timeStop);
        const stopAt = mo ? c2.momoSl ?? -20 : cfg.sl;
        const trailK = learnS.trailBy?.[sl] ?? (mo ? 0.6 : learnS.trailK);
        rs.push([now, q.px, q.real]);
        while (rs.length && now - rs[0][0] > 60_000) rs.shift();
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
        const keep = cfg.moonbag * p.tokens0;
        const toBag = p.tokens > keep ? (p.tokens - keep) / p.tokens : 0;
        let sellFrac = 0;
        let reason = "";
        let tunable = false;
        if (p.dev != null && p.dev <= 1 - cfg.devExit / 100 && !learnS.devExitOn && !p.devSellPx) {
          p.devSellPx = q.px;
          log(b, "RISK", `$${p.symbol}${gt}: dev sold ${Math.round((1 - p.dev) * 100)}% of their bag. holding: on memes a dev sell is normal. COACH scores what selling here would have done`, "info", p);
        }
        if (closeAll) [sellFrac, reason] = [1, "manual close"];
        else if (p.dev != null && p.dev <= 1 - cfg.devExit / 100 && learnS.devExitOn) [sellFrac, reason] = [1, `dev sold ${Math.round((1 - p.dev) * 100)}% of their bag (dev exit earned by COACH)`];
        else if (p.ins != null && p.ins <= 1 - cfg.insiderExit / 100) [sellFrac, reason] = [1, `insiders dumped ${Math.round((1 - p.ins) * 100)}% (bundle, snipers, top buyers)`];
        else if (!p.tp1Done) {
          if (gain <= stopAt) [sellFrac, reason] = [1, `stop loss ${fmtPct(gain)}`];
          else if (drain <= -20) [sellFrac, reason] = [1, `sellers took over: curve ${drain.toFixed(0)}% in 40s`];
          else if (gain >= initialsAt) [sellFrac, reason] = [cfg.initialsFrac, `initials at ${mult.toFixed(1)}x${initialsAt !== cfg.initialsAt ? ` (${sl} coins peak around ${pf!.medPk}x)` : ""}, cost is back`];
          else if (q.grad && !p.gradSeen) {
            p.gradSeen = true;
            if (p.pn < cfg.gradKeepP) [sellFrac, reason] = [1, `migrated before initials, P(next) ${Math.round(p.pn * 100)}%: out`];
          } else if (age >= timeStop) [sellFrac, reason] = [1, `time stop ${Math.round(age)}m at ${fmtPct(gain)}${timeStop !== cfg.timeStop ? ` (${sl} coins peak within ${pf!.medTtp}m)` : ""}`];
        } else {
          // house money: trail + milestone ladder + migration check
          const width = Math.max(15, Math.min(65, trailFor(cfg.trail, mult) * trailK * (0.85 + 0.3 * p.pn)));
          p.trail = Math.round(width);
          if (q.px <= p.peakPx * (1 - width / 100)) {
            [sellFrac, reason, tunable] = [1, `trailing stop ${p.trail}% off the peak (${(p.peakPx / p.entryPx).toFixed(1)}x), out at ${mult.toFixed(1)}x`, true];
          } else if (lv > (p.msHi ?? -1) && lv >= 0) {
            // only de-risk at a milestone when the runner model rates the next one as weak; strong coins keep running
            const f = Math.min(p.pn < cfg.ladderBelow ? cfg.ladderMax * (1 - p.pn / cfg.ladderBelow) : 0, toBag);
            p.msHi = lv;
            if (f >= 0.03) [sellFrac, reason, tunable] = [f, `${usdS(MILESTONES[lv])} reached, P(next ${usdS(MILESTONES[Math.min(lv + 1, MILESTONES.length - 1)])}) ${Math.round(p.pn * 100)}%`, true];
            else log(b, "RISK", `$${p.symbol}${gt} at ${usdS(MILESTONES[lv])}, P(next) ${Math.round(p.pn * 100)}%: holding`, "ok", p);
          } else if (q.grad && !p.gradSeen) {
            p.gradSeen = true;
            if (p.pn < cfg.gradKeepP && toBag > 0.03) [sellFrac, reason] = [toBag, `migrated, P(next) ${Math.round(p.pn * 100)}%: down to the moonbag`];
            else log(b, "RISK", `$${p.symbol}${gt} migrated, P(next) ${Math.round(p.pn * 100)}%: runner bag stays`, "ok", p);
          }
        }
        return { sellFrac, reason, tunable, lv };
      };

      // --- exits (RISK)
      for (const p of positions) {
        const q = px[p.mint];
        if (!q) {
          // no price: the curve completed but the coin has not (or never) migrated. after 30 minutes it is written off
          p.noPxSince ||= now;
          if (now - p.noPxSince > 30 * 60_000) {
            const ok = await sell(b, state, p, 1, 0, "curve full but never migrated: written off", cfg.slippageBps, kp);
            if (ok) await r.hdel(K.deskPos, p.mint);
          } else await r.hset(K.deskPos, { [p.mint]: p });
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
          if (ok && p.tokens <= 0 && p.devSellPx) {
            // COACH: would selling with the dev have beaten holding?
            const saved = q.px < p.devSellPx;
            learnS.devStat.n++;
            if (saved) learnS.devStat.saved++;
            else learnS.devStat.cost++;
            const was = learnS.devExitOn;
            const ds = learnS.devStat;
            learnS.devExitOn = ds.n >= LEARN_RULES.devMin && ds.saved / ds.n >= LEARN_RULES.devSaved;
            log(b, "COACH", `$${p.symbol} dev-sell review: ${saved ? "selling with the dev would have been better" : "holding through the dev sell paid"} (${(q.px / p.devSellPx).toFixed(2)}x since). ${ds.saved}/${ds.n} cases favour the dev exit`, saved ? "bad" : "ok", p);
            if (was !== learnS.devExitOn) log(b, "COACH", learnS.devExitOn ? "dev exit switched on: selling with the dev has been better" : "dev exit switched off: holding through dev sells is doing better", "win");
            await r.set(K.deskLearn, learnS);
          }
          if (ok && p.tokens <= 0) {
            // COACH follows the coin after we leave it
            await r.hset(K.deskAfter, { [p.mint]: { mint: p.mint, symbol: p.symbol, at: now, exitPx: q.px, peakHeld, reason, hi: q.px, lo: q.px, tunable, sl: sleeveOf(p.how, p.wire?.vamp) } satisfies After });
          }
        }
        if (p.tokens > 0) await r.hset(K.deskPos, { [p.mint]: p });
        else await r.hdel(K.deskPos, p.mint);
      }

      // --- ghost desk exits: the same rules, in the ghost book
      for (const p of ghosts) {
        const q = px[p.mint];
        if (!q) {
          p.noPxSince ||= now;
          if (now - p.noPxSince > 30 * 60_000) {
            await ghostSell(b, p, 1, 0, "curve full but never migrated: written off");
            await r.hdel(GHOST_POS, p.mint);
          } else await r.hset(GHOST_POS, { [p.mint]: p });
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
          if (closed && p.devSellPx) {
            const saved = q.px < p.devSellPx;
            learnS.devStat.n++;
            if (saved) learnS.devStat.saved++;
            else learnS.devStat.cost++;
            learnS.devExitOn = learnS.devStat.n >= LEARN_RULES.devMin && learnS.devStat.saved / learnS.devStat.n >= LEARN_RULES.devSaved;
            learnDirty = true;
          }
          // COACH reviews ghost exits like real ones (trail too tight or too loose)
          if (closed) await r.hset(K.deskAfter, { [`g:${p.mint}`]: { mint: p.mint, symbol: p.symbol, at: now, exitPx: q.px, peakHeld, reason: d.reason, hi: q.px, lo: q.px, tunable: d.tunable, sl: sleeveOf(p.how, p.wire?.vamp) } satisfies After });
        }
        if (p.tokens > 0) await r.hset(GHOST_POS, { [p.mint]: p });
        else await r.hdel(GHOST_POS, p.mint);
      }

      // --- entries (VET -> FLOW -> BUZZ -> SIZE -> EXEC); signals that pass VET are also shadowed for learning
      const eq = await equity(state, kp, px);
      if (eq.dayKey !== state.dayKey) {
        state.dayKey = eq.dayKey;
        state.dayStart = eq.value;
      }
      for (const q0 of queued) {
        await r.zrem(K.deskQ, q0);
        const wireSig = q0.startsWith("w:");
        const mindSig = q0.startsWith("m:");
        const momoSig = q0.startsWith("r:");
        const m = wireSig || mindSig || momoSig ? q0.slice(2) : q0;
        if (momoSig) {
          await r.zrem(K.deskQ, q0);
          if (px[m]) await momoEntry(b, state, m, px[m], cfg, eq.value, walletSol, kp, posMap).catch((e) => log(b, "VET", `MOMO signal: ${safeErr(e)}`, "bad"));
          continue;
        }
        const rec = await r.get<Launch>(K.launch(m));
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
        const liveNow = Object.values(((await r.hgetall<Record<string, Pos>>(K.deskPos)) || {}) as Record<string, Pos>);
        const open = liveNow.filter((p) => (wireSig ? p.how === "wire" : p.how !== "wire" && p.how !== "mind")).length;
        // a BOND call the rats could not tape in time: read its trades now, before VET (desk lane, ~1s)
        if (!rec.tape && !wireSig) {
          const tp = await readTape(m, rec.creator, rec.createdAt).catch(() => null);
          if (tp) {
            rec.tape = tp;
            await r.set(K.launch(m), rec, { keepTtl: true });
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
          { rule: "nano_agrees", ok: early || !cfg.needNano || rec.call!.nano?.verdict === "BOND", v: `${rec.call?.nano ? `${rec.call.nano.verdict} ${rec.call.nano.score}` : "learning"}${cfg.needNano ? "" : " (not required yet)"}` },
          { rule: "curve_window", ok: curve <= cfg.maxCurve && (early || curve >= cfg.minCurve), v: `${curve}%` },
          { rule: "dev_not_serial", ok: !((rec.devN ?? 0) >= cfg.serialDev && (rec.devB ?? 0) === 0), v: `${rec.devN ?? 0} launches, ${rec.devB ?? 0} bonded` },
          { rule: "dev_buy_sane", ok: rec.devBuySol <= cfg.maxDevBuy, v: `${rec.devBuySol} SOL` },
          // memes: a dev sell is normal, so it only blocks once COACH has proven the dev exit
          { rule: "dev_not_selling", ok: !learnS.devExitOn || !t || t.devSold <= 0.25, v: t ? `${t.devSold} SOL out${learnS.devExitOn ? "" : " (info only)"}` : "not read" },
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
          await r.hset(K.deskShadow, { [sh.k]: sh });
        }
        await r.set(K.deskVet, { mint: m, symbol: rec.symbol, at: now, checks }, { ex: 3600 });
        await r.set(VET_KEY(m), { at: now, checks, passed: !checks.find((c) => !c.ok) }, { ex: 7 * 86400 });
        // daily tally for the "right now" panel: how many signals were checked, and what stopped them
        const dk = DAY_KEY(now);
        await r.hincrby(dk, fail ? `f:${fail.rule}` : "passed", 1);
        await r.hincrby(dk, "seen", 1);
        await r.expire(dk, 3 * 86400);
        // blocked only by the desk itself (loss limit, full slots), not by anything about the coin: the ghost desk takes it
        const deskBlock = !!fail && fails.every((c) => DESK_RULES.has(c.rule)) && !posMap[m] && !stalks[m];
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
          await r.hset(K.deskShadow, { [sh.k]: sh });
        }
        if (early && !learnS.earlyOn) {
          const es = learnS.earlyStat;
          log(b, "VET", `$${rec.symbol} early read is clean. shadow only: early entries unlock at ${LEARN_RULES.earlyMin} resolved reads beating the minute-5 King (now ${es.n}, ${es.n ? Math.round((es.hit / es.n) * 100) : 0}% vs ${es.mainN ? Math.round((es.mainHit / es.mainN) * 100) : 0}%)`, "info", coin);
          continue;
        }
        if (!deskBlock) log(b, "VET", `$${rec.symbol} clean: curve ${curve}%, dev ${rec.devN ?? 0}/${rec.devB ?? 0}${t ? `, bundle ${Math.round(t.bundleShare * 100)}%` : ""}${g?.smartN ? `, ${g.smartN} smart wallets` : ""}`, "ok", coin);

        // FLOW: live pressure on the curve over a few seconds plus the last hour of trades
        const before = q.real;
        await new Promise((res) => setTimeout(res, 3000));
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
      }

      // --- stalks: buy the pullback once it bounces
      for (const sk of Object.values(stalks)) {
        const q = px[sk.mint];
        const coin = { mint: sk.mint, symbol: sk.symbol };
        if (!q || q.grad || now - sk.at > cfg.stalkMins * 60_000 || q.px < sk.px0 * 0.5) {
          await r.hdel(K.deskStalk, sk.mint);
          log(b, "SIZE", `$${sk.symbol} stalk ended: ${!q ? "no price" : q.grad ? "migrated" : q.px < sk.px0 * 0.5 ? "broke down" : "no pullback in time"}`, "info", coin);
          continue;
        }
        const t: ArmTrack = { hi: sk.hi, lo: sk.lo, armed: sk.armed, fill: null };
        stepArm(t, sk.depth, q.px, sk.px0);
        if (t.fill != null) {
          await r.hdel(K.deskStalk, sk.mint);
          const rec = await r.get<Launch>(K.launch(sk.mint));
          if (!rec) continue;
          log(b, "FLOW", `$${sk.symbol} pulled back ${Math.round((1 - t.lo / t.hi) * 100)}% and bounced. entering ${fmtPct(pct(q.px, sk.px0))} vs the signal`, "ok", coin);
          await enter(b, state, rec, q.px, q.real, eq.value, walletSol, kp, cfg, "stalk", null);
        } else await r.hset(K.deskStalk, { [sk.mint]: { ...sk, hi: t.hi, lo: t.lo, armed: t.armed } });
      }

      // --- learning: shadows (entries) and COACH (exits), every ~6s
      if (slow) {
        for (const sh of Object.values(shadows)) {
          const q = px[sh.mint];
          if (q) {
            sh.last = q.px;
            sh.hi = Math.max(sh.hi, q.px);
            sh.lo = Math.min(sh.lo, q.px);
            for (const a of ARMS) if (a) stepArm(sh.arms[String(a)], a, q.px, sh.px0);
          }
          if (now - sh.at >= LEARN_RULES.shadowMins * 60_000 || !q) {
            if (q) {
              scoreShadow(learnS, sh, b);
              learnDirty = true;
            }
            await r.hdel(K.deskShadow, sh.k || sh.mint);
          } else await r.hset(K.deskShadow, { [sh.k || sh.mint]: sh });
        }
        for (const [ak, a] of Object.entries(afters)) {
          const q = px[a.mint];
          if (q) {
            a.hi = Math.max(a.hi, q.px);
            a.lo = Math.min(a.lo, q.px);
          }
          if (reviewExit(learnS, a, b)) {
            learnDirty = true;
            await r.hdel(K.deskAfter, ak);
          } else await r.hset(K.deskAfter, { [ak]: a });
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
      }

      // --- the homepage shows how close the desk is to its own wallet (every ~30s)
      if (loops % 15 === 1) {
        const ex = await exam(state, walletSol);
        await r.set(K.deskExam, { at: now, live: state.live, passed: ex.checks.filter((c) => c.ok).length, total: ex.checks.length, checks: ex.checks.map((c) => ({ l: c.label, ok: c.ok, now: c.now, need: c.need })), walletSol, wallet: kp ? kp.publicKey.toBase58() : null }, { ex: 600 });
      }

      // --- books
      const eq2 = await equity(state, kp, px);
      state.equity = eq2.value;
      state.peakEq = Math.max(state.peakEq, eq2.value);
      const dd = state.peakEq ? -pct(eq2.value, state.peakEq) : 0;
      state.maxDD = Math.max(state.maxDD, dd);
      if (state.live && state.liveStart && pct(eq2.value, state.liveStart) <= -EXAM.liveMaxDD) {
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
      await r.set(K.deskState, state);
      await r.set(BEAT_KEY, now);
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
    await r.set(K.deskLearn, learnS);
    return { loops };
  } catch (e) {
    log(b, "LEDGER", `desk error: ${safeErr(e)}`, "bad");
    await flushLog(b).catch(() => {});
    return { error: safeErr(e), loops };
  } finally {
    await r.del("rn:lock:desk");
  }
}

function fallbackRun(p: Pos): Run {
  return { mint: p.mint, symbol: p.symbol, createdAt: p.openedAt, bondedAt: null, hi: -1, pk: 0, xs: {}, s: { king: p.king, nano: p.nano, smartN: 0, clRatio: 1, bundleShare: 0, uniq: 0, solPerBuy: 0, buyShare: 0.5, copy: false, lift: 1, funder: null, early: [] } };
}

type Cfg = Awaited<ReturnType<typeof getSettings>>["desk"];

async function enter(b: Batch, state: DeskState, rec: Launch, px: number, real: number, eqValue: number, walletSol: number | null, kp: Keypair | null, cfg: Cfg, how: "direct" | "stalk" | "early" | "wire" | "mind" | "momo", xm: number | null) {
  const r = redis();
  const coin = { mint: rec.mint, symbol: rec.symbol };
  enqueueLens(r, rec.mint, "buy");
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
    await ghostEnter(b, rec, px, real, how, `${sl} sleeve paused by PM`, cfg);
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
    await ghostEnter(b, rec, px, real, how, `no paper balance free (${avail.toFixed(3)} SOL)`, cfg);
    return;
  }
  log(b, "SIZE", `${size.toFixed(3)} SOL on $${rec.symbol} (${cfg.sizePct}% of desk, ${how} entry)`, "info", coin);
  if (!px) return;
  const pos = await buy(b, state, rec, size, px, cfg.slippageBps, kp, real, how);
  if (!pos) return;
  // RISK watches the insiders' bags from here: dev, bundle wallets, snipers, top early buyers
  const ins = rec.tape?.insiders || [];
  if (ins.length) {
    const amt = await tokenAmounts(ins.map((i) => i.acc)).catch(() => ({} as Record<string, number>));
    pos.watch = ins.map((i) => ({ acc: i.acc, role: i.role, base: amt[i.acc] ?? 0 })).filter((w) => w.base > 0);
    const held = pos.watch.filter((w) => w.role !== "dev").length;
    log(b, "RISK", `watching ${pos.watch.length} insider bags on $${rec.symbol}${pos.watch.some((w) => w.role === "dev") ? " incl. the dev" : ""}${held ? `, ${held} bundle/sniper/top wallets` : ""}`, "info", coin);
  }
  pos.xm = xm;
  await r.hset(K.deskPos, { [rec.mint]: pos });
}

async function equity(state: DeskState, kp: Keypair | null, px: Record<string, { px: number }>) {
  const pos = Object.values((await redis().hgetall<Record<string, Pos>>(K.deskPos)) || {}).filter((p) => p.live === state.live);
  const held = pos.reduce((a, p) => a + p.tokens * (px[p.mint]?.px ?? p.lastPx) * (1 - FEE), 0);
  const cash = state.live && kp ? (await conn().getBalance(kp.publicKey).catch(() => 0)) / 1e9 : state.cash;
  return { value: cash + held, dayKey: dayKey() };
}

async function buy(b: Batch, state: DeskState, rec: Launch, sol: number, px: number, slip: number, kp: Keypair | null, real: number, how: Pos["how"]): Promise<Pos | null> {
  const coin = { mint: rec.mint, symbol: rec.symbol };
  let tokens = 0;
  let sig: string | undefined;
  let fillPx = px;
  if (state.live && kp) {
    try {
      const res = await swap(kp, WSOL, rec.mint, BigInt(Math.floor(sol * 1e9)), slip);
      tokens = Number(res.outRaw) / 1e6;
      sig = res.sig;
      fillPx = sol / Math.max(tokens, 1e-9);
    } catch (e) {
      log(b, "EXEC", `buy $${rec.symbol} failed: ${safeErr(e)}`, "bad", coin);
      return null;
    }
  } else {
    fillPx = px * (1 + PAPER_SLIP);
    tokens = (sol * (1 - FEE)) / fillPx;
    state.cash -= sol;
  }
  const now = Date.now();
  const why = how === "momo" ? `MOMO: ${rec.description || "traction after migration"}` : how === "mind" ? `MIND SEND ${(await mindJudgement(rec.mint).catch(() => null))?.conviction ?? ""}` : how === "wire" ? `@${rec.wire?.h} post (${rec.wire?.how})` : how === "early" ? `early read BOND ${rec.early?.score}` : `King ${rec.call?.verdict} ${rec.call?.score}${how === "stalk" ? ", bought the pullback" : ""}`;
  const ctx = await entryCtx(rec, fillPx, real, how).catch(() => undefined);
  b.trades.push({ id: `${now}${rec.mint.slice(0, 4)}b`, mint: rec.mint, symbol: rec.symbol, side: "buy", at: now, sol: r4(sol), tokens, px: fillPx, reason: why, live: state.live, sig, mc: ctx ? mcUsd(fillPx, ctx.solUsd) : null, ctx });
  log(b, "EXEC", `bought $${rec.symbol} for ${sol.toFixed(3)} SOL${state.live ? "" : " (paper)"}`, "ok", coin);
  return {
    mint: rec.mint,
    symbol: rec.symbol,
    name: rec.name,
    openedAt: now,
    entryPx: fillPx,
    costSol: sol,
    tokens,
    tokens0: tokens,
    soldSol: 0,
    tp1Done: false,
    lastPx: px,
    peakPx: px,
    king: rec.call?.score ?? rec.early?.score ?? 0,
    nano: rec.call?.nano?.score ?? null,
    live: state.live,
    series: [[now, px, real]],
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
  const known = await r.get<Launch>(K.launch(m));
  // a coin the rats may never have dug (launched before they watched, or long ago): enough to trade and to show
  const rec: Launch = known || ({ mint: m, sig: "", createdAt: now - h.ageMin * 60_000, creator: "", name: h.name, symbol: h.symbol, uri: "", image: "", description: "", twitter: "", telegram: "", website: "", devBuySol: 0, devN: 0, devB: 0, dugAt: now, dugBy: "MOMO", p0: 0, mcap0: 0, cp: {}, outcome: q.grad ? "BONDED" : undefined } as Launch);
  rec.description = `$${Math.round(h.v5 / 1000)}K volume in 5m, ${h.buyers5} buyers vs ${h.sellers5} sellers`;
  const coin = { mint: m, symbol: rec.symbol };
  const open = Object.values(posMap).filter((p) => p.how === "momo").length;
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
    { rule: "open_slots", ok: open < (c.momoMaxOpen ?? 3) && !posMap[m], v: `${open}/${c.momoMaxOpen ?? 3} MOMO slots` },
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
  await enter(b, state, rec, q.px, q.grad ? 0 : q.real, eqValue, walletSol, kp, cfg, "momo", null);
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
  const open = Object.values(posMap).filter((p) => p.how === "mind").length;
  const checks = [
    { rule: "mind_send", ok: !!j && j.verdict === "SEND" && j.conviction >= (c.mindMin ?? 75), v: j ? `${j.verdict} ${j.conviction}: ${j.thesis.slice(0, 90)}` : "no judgement" },
    { rule: "fresh_signal", ok: !!j && now - j.at < 10 * 60_000, v: j ? `${Math.round((now - j.at) / 1000)}s old` : "-" },
    { rule: "liquidity_ok", ok: !q.grad || q.real >= (c.mindMinPoolSol ?? 20), v: q.grad ? `${Math.round(q.real)} SOL in the pool` : `on the curve, ${q.curve?.progress ?? "?"}%` },
    { rule: "not_a_farm", ok: !t?.farm?.farm, v: t?.farm?.farm ? t.farm.why : t ? `${t.organic ?? "?"} organic traders` : "not read" },
    { rule: "bundle_ok", ok: q.grad || !t || t.bundleShare * 100 <= cfg.maxBundle, v: t ? `${Math.round(t.bundleShare * 100)}% of SOL in` : "not read" },
    { rule: "open_slots", ok: open < (c.mindMaxOpen ?? 2) && !posMap[m], v: `${open}/${c.mindMaxOpen ?? 2} MIND slots` },
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
  if (p.live && kp) {
    try {
      const have = await tokenBalanceRaw(kp.publicKey, p.mint);
      const raw = frac >= 1 ? have : (have * BigInt(Math.round(frac * 1000))) / 1000n;
      if (raw <= 0n) {
        p.tokens = 0;
        return true;
      }
      const res = await swap(kp, p.mint, WSOL, raw, slip);
      proceeds = Number(res.outRaw) / 1e9;
      sig = res.sig;
    } catch (e) {
      log(b, "RISK", `sell $${p.symbol} failed, retrying next beat: ${safeErr(e)}`, "bad", coin);
      return false;
    }
  } else {
    proceeds = amt * px * (1 - PAPER_SLIP) * (1 - FEE);
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
    // keep the whole trade for the public track record: chart, the call behind it, peak while held
    const step = Math.max(1, Math.ceil((p.series?.length || 0) / 90));
    const series = (p.series || []).filter((_, i, a) => i % step === 0 || i === a.length - 1).map(([t, x]) => [t, x] as [number, number]);
    await redis().lpush(TRIPS_KEY, { mint: p.mint, symbol: p.symbol, openedAt: p.openedAt, closedAt: Date.now(), king: p.king, nano: p.nano, how: p.how || "direct", entryPx: p.entryPx, peakPx: Math.max(p.peakPx || 0, px), exitPx: px, series, ctx: await withLens(p.ctx, p.mint) } satisfies TripMeta);
    await redis().ltrim(TRIPS_KEY, 0, 999);
    // COACH keeps watching the coin after we leave it: 5m, 15m, 1h, 2h, 6h, 1d, 7d
    await follow({ id: tripId(p.mint, p.openedAt), mint: p.mint, symbol: p.symbol, creator: p.creator, createdAt: p.ctx?.createdAt, closedAt: Date.now(), entryPx: p.entryPx, exitPx: px, exitGrad: !!p.gradSeen, reason }).catch(() => {});
    log(b, "COACH", `following $${p.symbol} after the exit: checks at 5m, 15m, 1h, 2h, 6h, 1d and 7d, and what moved it`, "info", coin);
    await noteExit(sleeveOf(p.how, p.wire?.vamp), Math.max(p.peakPx || 0, px) / p.entryPx, ((p.peakAt ?? p.openedAt) - p.openedAt) / 60_000).catch(() => {});
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
async function ghostEnter(b: Batch, rec: Launch, px: number, real: number, how: Pos["how"], blocked: string, cfg: Cfg) {
  const r = redis();
  const coin = { mint: rec.mint, symbol: rec.symbol };
  if (!px || (await r.hexists(GHOST_POS, rec.mint))) return;
  if (((await r.hlen(GHOST_POS)) || 0) >= GHOST_MAX) {
    log(b, "SIZE", `$${rec.symbol}: ghost desk full (${GHOST_MAX} open), not followed`, "info", coin);
    return;
  }
  const sol = cfg.ghostSol ?? 0.1;
  const fillPx = px * (1 + PAPER_SLIP);
  const tokens = (sol * (1 - FEE)) / fillPx;
  const now = Date.now();
  const ctx = await entryCtx(rec, fillPx, real, how).catch(() => undefined);
  const why = how === "momo" ? `MOMO: ${rec.description || "traction after migration"}` : how === "mind" ? `MIND SEND ${(await mindJudgement(rec.mint).catch(() => null))?.conviction ?? ""}` : how === "wire" ? `@${rec.wire?.h} post (${rec.wire?.how})` : how === "early" ? `early read BOND ${rec.early?.score}` : `King ${rec.call?.verdict} ${rec.call?.score}`;
  (b.ghost ||= []).push({ id: `${now}${rec.mint.slice(0, 4)}b`, mint: rec.mint, symbol: rec.symbol, side: "buy", at: now, sol, tokens, px: fillPx, reason: `${why} · ghost: ${blocked}`, live: false, mc: ctx ? mcUsd(fillPx, ctx.solUsd) : null, ctx });
  const pos: Pos = { mint: rec.mint, symbol: rec.symbol, name: rec.name, openedAt: now, entryPx: fillPx, costSol: sol, tokens, tokens0: tokens, soldSol: 0, tp1Done: false, lastPx: px, peakPx: px, king: rec.call?.score ?? rec.early?.score ?? 0, nano: rec.call?.nano?.score ?? null, live: false, series: [[now, px, real]], how, msHi: -1, ctx, creator: rec.creator, ghost: blocked, wire: rec.wire ? { h: rec.wire.h, tid: rec.wire.tid, text: rec.wire.text, vamp: !!rec.wire.vamp } : null, ...(rec.outcome === "BONDED" ? { gradSeen: true } : {}) };
  const ins = rec.tape?.insiders || [];
  if (ins.length) {
    const amt = await tokenAmounts(ins.map((i) => i.acc)).catch(() => ({} as Record<string, number>));
    pos.watch = ins.map((i) => ({ acc: i.acc, role: i.role, base: amt[i.acc] ?? 0 })).filter((w) => w.base > 0);
  }
  await r.hset(GHOST_POS, { [rec.mint]: pos });
  log(b, "EXEC", `ghost desk bought $${rec.symbol} for ${sol} SOL (the real desk is blocked: ${blocked}). not counted, learned from`, "info", coin);
}

/** Sell in the ghost book. Returns true when the position is fully closed. */
async function ghostSell(b: Batch, p: Pos, frac: number, px: number, reason: string) {
  const coin = { mint: p.mint, symbol: p.symbol };
  const amt = frac >= 1 ? p.tokens : p.tokens * frac;
  const proceeds = amt * px * (1 - PAPER_SLIP) * (1 - FEE);
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
  const step = Math.max(1, Math.ceil((p.series?.length || 0) / 90));
  const series = (p.series || []).filter((_, i, a) => i % step === 0 || i === a.length - 1).map(([t, x]) => [t, x] as [number, number]);
  await redis().lpush(GHOST_TRIPS, { mint: p.mint, symbol: p.symbol, openedAt: p.openedAt, closedAt: now, king: p.king, nano: p.nano, how: p.how || "direct", entryPx: p.entryPx, peakPx: Math.max(p.peakPx || 0, px), exitPx: px, series, ctx: await withLens(p.ctx, p.mint) } satisfies TripMeta);
  await redis().ltrim(GHOST_TRIPS, 0, 999);
  // COACH follows ghost exits too (5m to 7d), and PM hears how a paused strategy would have done
  await follow({ id: `g:${tripId(p.mint, p.openedAt)}`, mint: p.mint, symbol: p.symbol, creator: p.creator, createdAt: p.ctx?.createdAt, closedAt: now, entryPx: p.entryPx, exitPx: px, exitGrad: !!p.gradSeen, reason }).catch(() => {});
  await noteExit(sleeveOf(p.how, p.wire?.vamp), Math.max(p.peakPx || 0, px) / p.entryPx, ((p.peakAt ?? p.openedAt) - p.openedAt) / 60_000).catch(() => {});
  const note = await pmGhost(sleeveOf(p.how, p.wire?.vamp), Math.log(Math.max(1e-6, p.soldSol) / Math.max(1e-9, p.costSol))).catch(() => null);
  if (note) log(b, "PM", note, "win");
  const total = p.soldSol - p.costSol;
  log(b, "LEDGER", `ghost desk closed $${p.symbol} ${total >= 0 ? "+" : ""}${total.toFixed(3)} SOL (${fmtPct(pct(p.soldSol, p.costSol))}). not counted`, "info", coin);
  return true;
}

// ---------------------------------------------------------------- read side

const BEAT_KEY = "rn:desk:beat"; // last time a desk beat finished
const DAY_KEY = (t: number) => `rn:desk:day:${new Date(t).toISOString().slice(0, 10)}`;

/** What the desk is doing right now, what it is waiting for, and what unlocks next. */
async function rightNow(learnS: Learn) {
  const r = redis();
  const now = Date.now();
  const [beat, day, hist, nano, st] = await Promise.all([
    r.get<number>(BEAT_KEY),
    r.hgetall<Record<string, number>>(DAY_KEY(now)),
    getHistory().catch(() => null as any),
    loadModel(K.nano),
    r.hmget<Record<string, number>>(K.stat, "bond_n"),
  ]);
  const d = (day || {}) as Record<string, number>;
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
    nano: { n: nano.n, min: NANO_MIN },
    early: { n: learnS.earlyStat.n, min: LEARN_RULES.earlyMin, on: learnS.earlyOn },
    stalkOn: learnS.stalkOn,
    history: hist ? { phase: hist.phase, done: hist.done ?? 0, lessons: hist.lessons ?? 0, clock: hist.clock ?? null } : null,
  };
}

export async function getDesk() {
  const r = redis();
  const s = await getSettings();
  const p = r.pipeline();
  p.get(K.deskState);
  p.hgetall(K.deskPos);
  p.lrange(K.deskTrades, 0, 59);
  p.lrange(K.deskEv, 0, 59);
  p.lrange(K.deskEq, -720, -1);
  p.hgetall(K.deskAgent);
  p.get(K.deskVet);
  p.hgetall(K.deskStalk);
  p.hlen(K.deskShadow);
  p.hlen(K.deskAfter);
  const [st, pos, trades, ev, eqs, agents, vet, stalks, nShadow, nAfter] = (await p.exec()) as any[];
  const state: DeskState = st || (await loadState(s.desk.start));
  const learnS = await loadLearn();
  const addr = deskWalletAddress();
  const walletSol = addr ? (await conn().getBalance(new PublicKey(addr)).catch(() => 0)) / 1e9 : null;
  const ex = await exam(state, walletSol);
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
    coach: await coachStats().catch(() => null),
    film: await filmStats().catch(() => null),
    pm: await pmView().catch(() => null),
    ghost: await (async () => {
      const r = redis();
      const [open, n] = await Promise.all([r.hlen(GHOST_POS), r.llen(GHOST_TRADES)]);
      return { open: open || 0, fills: n || 0, max: GHOST_MAX };
    })().catch(() => null),
    wire: await wireView().catch(() => null),
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
const GHOST_TRADES = "rn:ghost:trades";
const GHOST_TRIPS = "rn:ghost:trips";
const GHOST_MAX = 10;
const DESK_RULES = new Set(["daily_loss_ok", "open_slots"]);
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
    r.lrange<Trade>(ghost ? GHOST_TRADES : K.deskTrades, 0, 1999),
    r.hgetall<Record<string, Pos>>(ghost ? GHOST_POS : K.deskPos),
    r.get<DeskState>(K.deskState),
    r.lrange<TripMeta>(ghost ? GHOST_TRIPS : TRIPS_KEY, 0, 999),
    solUsd().catch(() => null),
  ]);
  const metaBy: Record<string, TripMeta> = {};
  for (const m of (metas || []) as TripMeta[]) metaBy[`${m.mint}|${m.openedAt}`] = m;
  const list = ((trades || []) as Trade[]).slice().reverse(); // oldest first
  const pos = (posMap || {}) as Record<string, Pos>;
  const trips: Trip[] = [];
  const openBy: Record<string, Trip> = {};
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
      trip.exits.push({ at: t.at, sol: t.sol, reason: t.reason, pnlPct: t.pnlPct ?? null, sig: t.sig, px: t.px, mc: t.mc ?? (t.px ? mcUsd(t.px, sol) : null), tokens: t.tokens });
    }
  }
  const now = Date.now();
  for (const trip of trips) {
    const p = pos[trip.mint];
    const isOpen = trip.open && !!p && openBy[trip.mint] === trip;
    trip.open = isOpen;
    if (!isOpen && trip.closedAt == null) trip.closedAt = trip.exits.length ? trip.exits[trip.exits.length - 1].at : trip.openedAt;
    trip.valueSol = isOpen && p ? Math.max(0, p.tokens * (p.lastPx || 0)) : 0;
    trip.pnlSol = r4(trip.backSol + trip.valueSol - trip.costSol);
    trip.pnlPct = trip.costSol ? Math.round(((trip.backSol + trip.valueSol) / trip.costSol - 1) * 1000) / 10 : 0;
    trip.backSol = r4(trip.backSol);
    trip.valueSol = r4(trip.valueSol);
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
