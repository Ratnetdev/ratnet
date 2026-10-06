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
