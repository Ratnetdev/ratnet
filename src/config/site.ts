// Static constants. Live settings (CA, litter, costs) live in Redis and are edited on /admin.

export const SITE = {
  name: "RATNET",
  ticker: "RAT",
  tagline: "Pretraining the first model raised in the trenches.",
  sub: "From scratch. On nothing but what its rats dig up.",
  url: process.env.NEXT_PUBLIC_SITE_URL || "https://ratnet.fun",
};

// pump.fun program + mint authority. The mint authority signs every pump.fun create tx,
// so its signature history is a clean stream of new launches.
export const PUMP_PROGRAM = process.env.PUMP_PROGRAM_ID || "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_MINT_AUTHORITY = process.env.PUMP_MINT_AUTHORITY || "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

// Bonding curve constants (pump.fun standard curve, 6 decimals).
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000n * 1_000_000n;
export const TOKEN_DECIMALS = 6;

// Checkpoints after creation (ms).
export const CHECKPOINTS = {
  t1: 60_000, // early read: the minute-1 model makes its own call (tracked separately)
  t5: 5 * 60_000, // Rat King makes its call here
  h1: 60 * 60_000,
  d1: 24 * 60 * 60_000, // outcome resolves here
} as const;

// A call only counts toward the public hit rate if it was made within this window after creation.
export const CALL_MAX_AGE_MS = 15 * 60_000;

export const ROUND_MS = 12 * 60 * 60_000;
export const FEE_SPLIT = { compute: 0.6, owners: 0.4 };

export const DEFAULT_SETTINGS = {
  mint: "", // $RAT CA, set on /admin at launch
  decimals: 6,
  litter: { n: 1, size: 100, open: true },
  spawnCost: 100_000,
  sniffCost: 10_000,
  minWork: 50,
  freeSniff: true, // free sniffs while no CA is set (pre-launch preview)
  links: { x: "", tg: "", pump: "", dex: "" },
  // HISTORIAN: replays past pump.fun launches so the models start trained (see src/lib/historian.ts)
  history: {
    on: true,
    days: 14, // how far back to replay
    scanPerRun: 150, // create txs parsed per step (1 RPC credit each)
    deepPerRun: 8, // launches fully rebuilt per step (~50 credits each)
    sample: 10, // learn every bonded launch plus 1 in this many of the rest (weighted back up)
    runner: true, // post-bond candles from GeckoTerminal for the runner model
  },
  desk: {
    mode: "auto" as "off" | "paper" | "auto" | "live", // auto = paper until the exam is passed, then live
    start: 1, // paper starting balance in SOL
    sizePct: 5, // % of equity per trade
    minSol: 0.05,
    maxSol: 0.5,
    maxOpen: 5,
    minCurve: 8, // only enter between these curve %
    maxCurve: 70,
    maxDevBuy: 5, // SOL
    serialDev: 5, // reject devs with this many launches and 0 bonds
    needNano: false, // require nano BOND too
    minFlow: 0.55, // share of 1h trades that are buys
    sl: -35, // % loss before initials: sell all
    timeStop: 45, // minutes without taking initials: sell all
    // exits v0.1.4 (research: take initials at 2x, keep a moonbag, widen the trail as it runs, exit on insider dumps)
    initialsAt: 100, // % gain: sell initialsFrac to get the cost back
    initialsFrac: 0.5,
    moonbag: 0.2, // share of the original bag never sold by the ladder, only by the trail or a hard exit
    ladderMax: 0.5, // at a new milestone sell up to this share of what is left...
    ladderBelow: 0.4, // ...only when P(next milestone) is under this, scaled: P 0 sells ladderMax, P 0.4+ sells nothing
    trail: [30, 40, 45, 50], // trailing stop % from the peak at <3x, 3-10x, 10-30x, 30x+ (scaled by COACH and the runner model)
    insiderExit: 50, // % of the watched insiders' bag sold: exit everything
    devExit: 50, // % of the dev's bag sold: exit everything
    gradKeepP: 0.35, // at migration keep the runner bag only if P(next milestone) is at least this
    // entries v0.1.4
    maxChase: 60, // % above the call price: do not chase, stalk for a pullback instead
    maxBundle: 60, // % of SOL in from create-slot bundle wallets: pass
    tapeMinCurve: 5, // curve % at the call needed for the rats to read trades and wallets (RPC budget)
    earlyMinCurve: 3, // curve % at minute 1 for the early read
    stalkMins: 15, // how long a stalk waits for its pullback
    dailyLoss: 25, // % from day start: stop opening
    slippageBps: 1500,
  },
};
export type Settings = typeof DEFAULT_SETTINGS;

// Bag multiplier per rat (owner balance / rats owned).
export const BAG_TIERS = [
  { min: 2_500_000, mult: 2.0 },
  { min: 1_000_000, mult: 1.5 },
  { min: 500_000, mult: 1.25 },
  { min: 100_000, mult: 1.0 },
];
export const CAP_FREE_BAG = 100_000; // per rat; below this, earnings cap at 2x cost
export const EARN_CAP_X = 2;

export const SCOUTS = ["SCOUT-1", "SCOUT-2", "SCOUT-3", "SCOUT-4", "SCOUT-5", "SCOUT-6", "SCOUT-7", "SCOUT-8"];
