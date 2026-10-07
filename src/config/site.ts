// Static constants. Live settings (CA, litter, costs) live in Redis and are edited on /admin.

export const SITE = {
  name: "RATNET",
  ticker: "RAT",
  tagline: "Pretraining the first model raised in the trenches.",
  sub: "From scratch. On nothing but what its rats dig up.",
  // the live domain; NEXT_PUBLIC_SITE_URL overrides it (local dev: set it to http://localhost:3000)
  url: process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "https://www.ratnet.network"),
  x: "https://x.com/Ratnetdev",
  handle: "@Ratnetdev",
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

// The minute-5 call is still made up to this age (the record shows it, marked late)...
export const CALL_MAX_AGE_MS = 15 * 60_000;
// ...but it only counts toward the public hit rate, the calibration and the desk if it was made by minute 7. Before
// v0.1.28 a call made at minute 14 counted as a "minute-5" call: it had seen 9 more minutes of the curve.
export const CALL_ON_TIME_MS = 7 * 60_000;

export const ROUND_MS = 12 * 60 * 60_000;
export const FEE_SPLIT = { compute: 0.6, owners: 0.4 };

export const DEFAULT_SETTINGS = {
  mint: "", // $RAT CA, set on /admin at launch
  decimals: 6,
  litter: { n: 1, size: 100, open: true },
  spawnCost: 100_000,
  repeatOff: 0.3, // every next rat from a wallet that already owns one costs 30% less
  pupCost: 25_000, // a pup rides with an adult rat: cheap entry, earns at PUP_WEIGHT when its rat earns
  pupMax: 1_000,
  sniffCost: 10_000,
  minWork: 50,
  freeSniff: true, // free sniffs while no CA is set (pre-launch preview)
  links: { x: "https://x.com/Ratnetdev", tg: "", pump: "", dex: "" },
  // trade buttons on every coin: your referral code per venue, and the link formats ({ca} = coin, {ref} = your code)
  refs: { pump: "", gmgn: "", axiom: "", fomo: "" },
  venueTpl: {
    pump: { ref: "https://pump.fun/coin/{ca}?ref={ref}", plain: "https://pump.fun/coin/{ca}" },
    dex: { ref: "https://dexscreener.com/solana/{ca}", plain: "https://dexscreener.com/solana/{ca}" },
    gmgn: { ref: "https://gmgn.ai/sol/token/{ref}_{ca}", plain: "https://gmgn.ai/sol/token/{ca}" }, // format from GMGN's docs
    axiom: { ref: "https://axiom.trade/t/{ca}/@{ref}", plain: "https://axiom.trade/t/{ca}" },
    fomo: { ref: "https://fomo.family/r/{ref}", plain: "https://fomo.family" }, // FOMO codes only count at signup
  },
  // HISTORIAN: replays past pump.fun launches so the models start trained (see src/lib/historian.ts)
  history: {
    on: true,
    days: 30, // how far back to replay (today first, then backwards)
    halfLife: 21, // days: a lesson this old weighs half (seasons change)
    scanPerRun: 400, // create txs parsed per step (1 RPC credit each), 16 at a time
    deepPerRun: 16, // launches fully rebuilt per step (~50 credits each), 6 at a time
    sample: 10, // learn every bonded launch plus 1 in this many of the rest (weighted back up)
    runner: true, // post-bond candles from GeckoTerminal for the runner model
  },
  desk: {
    mode: "auto" as "off" | "paper" | "auto" | "live", // auto = paper until the exam is passed, then live
    start: 1, // paper starting balance in SOL
    sizePct: 5, // % of equity per trade
    minSol: 0.05,
    maxSol: 0.5, // safety cap per trade; raise it as the wallet grows (the liquidity cap below still applies)
    maxImpact: 6, // % price impact a buy may cause on the curve: caps size by the coin's liquidity, so a big desk never apes 10 SOL into a 5K coin
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
    insiderExit: 50, // % of the watched insiders' bag sold: exit everything...
    insiderMinSupply: 2, // ...only if that is at least this % of the supply and the price is 8%+ off the peak
    devExit: 50, // % of the dev's bag sold: exit everything
    gradKeepP: 0.35, // at migration keep the runner bag only if P(next milestone) is at least this
    // entries v0.1.4
    maxChase: 60, // % above the call price: do not chase, stalk for a pullback instead
    maxBundle: 60, // % of SOL in from create-slot bundle wallets: pass
    tapeMinCurve: 5, // curve % at the call needed for the rats to read trades and wallets (RPC budget)
    earlyMinCurve: 3, // curve % at minute 1 for the early read
    stalkMins: 15, // how long a stalk waits for its pullback
    dailyLoss: 25, // % from day start: stop opening
    maxBags: 12, // positions held at once in total, house-money bags included; past it the quietest bag is sold
    bagStaleMin: 120, // house-money bag with no new high for this long (and under 3x) is sold
    // WIRE (tweet coins) and PM (strategy sleeves)
    wireMinW: 0.2, // trust an account's posts must have before WIRE sends its coins to the desk (seeds start at 0.3 to 0.5)
    wireMaxCurve: 85, // tweet coins move fast: allowed up to this curve %
    wireMaxOpen: 2, // tweet-coin positions open at once
    // MOMO (runners pulling real volume, mostly after migration): starting hints, FILM follows every skip
    momoMode: "on" as "on" | "off",
    momoMinVol5m: 25000, // USD volume in the last 5 minutes
    momoMinVol1h: 100000, // USD volume in the last hour
    momoMinBuyers5m: 40, // different buyers in the last 5 minutes
    momoMinBuyRatio: 1.05, // buyers vs sellers in the last 5 minutes
    momoMinLiq: 20000, // USD liquidity in the pool
    momoMinPoolSol: 40, // SOL in the pool before the desk buys
    momoMaxTop10: 35, // % of supply the top 10 holders may hold (pool excluded)
    momoMaxCh5: 60, // % up in 5 minutes past which it is chasing
    momoMaxAgeH: 24,
    momoMaxMc: 30000000,
    momoMaxOpen: 3,
    momoCooldownMin: 45, // minutes before the same coin can be signalled again
    momoInitials: 40, // % up: sell the initials (until MOMO's own record sets it)
    momoSl: -20, // stop loss before initials
    momoTimeStop: 40, // minutes without initials: out
    // CATCH (the sender catcher): coins moving like the ones that ran to $300K+, fast migrators and slow ones.
    // auto/on = trade its signals (prior score until its model has 300 labels, then the model's own cutoff); off = never
    catchMode: "on" as "auto" | "on" | "off",
    // FLASH (first-seconds reads at 15s, 45s, 90s from the live stream): auto = a look time trades only once its own
    // record earns a band (30+ looks, 10%+ and 5x the base rate bonded within the hour); on = the starting score too
    flashMode: "auto" as "auto" | "on" | "off",
    flashMaxOpen: 3,
    flashFreshMs: 6000, // a first-seconds signal older than this is stale
    flashMaxCurve: 65, // % curve at entry
    flashMaxChase: 40, // % the price may have run between the look and the entry
    flashPriorMin: 75, // "on" mode only
    flashSl: -30,
    flashTimeStop: 12,
    flashInitials: 100,
    catchTargetUsd: 300000, // a "sender": reaches max(this, 2x the market cap at the look) within the horizon
    catchHorizonH: 6,
    catchPriorMin: 72, // prior score (0-100) needed before the model is ready
    catchMinHit: 0.08, // once ready: trade the lowest score band hitting at least this often (and 6x the base rate)
    catchMinCurve: 15, // curve % before CATCH looks at a coin on the curve
    catchCurveTop: 40, // hottest curves looked at per pass
    catchSnapsPerPass: 30,
    catchMaxOpen: 3,
    catchMaxTop10: 40, // % top 10 holders may hold (curve/pool excluded)
    catchMinPoolSol: 30,
    catchCooldownMin: 30,
    catchInitials: 100, // % up: send ladder step 1 at 2x (until the exit lab learns CATCH's own number)
    catchFirstFrac: 0.4, // send ladder: share sold at the initials
    catchSendFrac: 0.3, // send ladder: share of the original bag sold at the target (catchTargetUsd); the rest trails
    catchSl: -18,
    catchTimeStop: 30,
    // MIND (the trader's mind): auto = trades its SEND calls only once its own record earns it; on = now; off = never
    mindMode: "auto" as "auto" | "on" | "off",
    mindMin: 75, // conviction MIND needs before a SEND goes to the desk
    mindMaxOpen: 2, // MIND positions open at once
    mindMinPoolSol: 20, // migrated coins: SOL in the pool needed before MIND may buy
    // EXEC speed: own transaction with a live priority fee and a Jito tip, sent through Helius Sender and the RPC
    fastExec: true,
    maxPriorityLamports: 3_000_000, // cap on the priority fee per trade (0.003 SOL)
    jitoTipMinSol: 0.0003,
    jitoTipMaxSol: 0.002, // tip = 0.4% of the trade, between these two
    flowWaitMs: 1500, // FLOW watches the curve this long before a King buy (tweet coins: no wait)
    ghostSol: 0.1, // ghost desk: fixed size per trade (not counted anywhere, only learned from)
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
export const CAP_FREE_BAG = 100_000; // per rat or pup; below this, earnings cap at 2x cost
export const PUP_WEIGHT = 0.25; // a pup weighs a quarter of its rat in the payout
export const PUP_ROYALTY = 0.2; // 20% of a pup's share goes to the owner of the rat it rides with
export const EARN_CAP_X = 2;

export const SCOUTS = ["SCOUT-1", "SCOUT-2", "SCOUT-3", "SCOUT-4", "SCOUT-5", "SCOUT-6", "SCOUT-7", "SCOUT-8"];
