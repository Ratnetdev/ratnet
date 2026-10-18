// v0.1.121 DESK SCALE. The desk's limits grow with its bank, so a found edge can compound past 10 SOL instead of
// stalling at the fixed caps (maxSol 0.5 x maxOpen 5 = at most 2.5 SOL in the market). At the starting bank nothing
// changes: every scaled limit is at least its configured value. Above it:
//  - size cap per trade: a share of the bank (scaleSolPct), never under maxSol, never over scaleSolMax
//  - open positions: grow with the square root of the bank (5 at 2 SOL, 16 at 20, 35 at 100, 100 at 1000)
//  - total exposure: at most deployPct of the bank at risk at once (cost still in open positions)
//  - per strategy: at most bookPct of the bank in one book, so one strategy (or one bad hour of it) can't sink the desk
// The coin's own liquidity still caps every buy: on the curve as before, and in a migrated pool by its SOL reserve.
// scale: false in the desk settings turns all of it off (the fixed caps apply again).

export type ScaleCfg = {
  maxSol: number;
  maxOpen: number;
  minSol: number;
  maxImpact?: number;
  momoMaxOpen?: number;
  maxBags?: number;
  scale?: boolean;
  scaleBase?: number;
  scaleSolPct?: number;
  scaleSolMax?: number;
  scaleOpenMax?: number;
  deployPct?: number;
  bookPct?: number;
};

export type Scale = {
  on: boolean;
  bank: number;
  maxSol: number;
  maxOpen: number;
  momoMaxOpen: number;
  maxBags: number;
  deployMax: number; // SOL at risk at once, all strategies
  bookMax: number; // SOL at risk at once in one strategy
};

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function scaleOf(bank: number, cfg: ScaleCfg): Scale {
  const b = Math.max(0, num(bank, 0));
  const momo0 = num(cfg.momoMaxOpen, 3);
  const bags0 = num(cfg.maxBags, 12);
  if (cfg.scale === false) return { on: false, bank: b, maxSol: cfg.maxSol, maxOpen: cfg.maxOpen, momoMaxOpen: momo0, maxBags: bags0, deployMax: Infinity, bookMax: Infinity };
  const base = Math.max(0.1, num(cfg.scaleBase, 2));
  const grow = Math.sqrt(Math.max(1, b / base));
  const solMax = Math.max(cfg.maxSol, num(cfg.scaleSolMax, 25));
  const openMax = Math.max(cfg.maxOpen, num(cfg.scaleOpenMax, 100));
  const maxSol = Math.min(solMax, Math.max(cfg.maxSol, (b * num(cfg.scaleSolPct, 10)) / 100));
  const maxOpen = Math.min(openMax, Math.max(cfg.maxOpen, Math.round(cfg.maxOpen * grow)));
  const momoMaxOpen = Math.min(40, Math.max(momo0, Math.round(momo0 * grow)));
  const maxBags = Math.min(150, Math.max(bags0, Math.round(bags0 * grow)));
  // floors keep the starting desk exactly as it was: 5 trades at the minimum always fit, overall and in one book
  const floor = 5 * cfg.minSol;
  const deployMax = Math.max(floor, (b * num(cfg.deployPct, 60)) / 100);
  const bookMax = Math.max(floor, (b * num(cfg.bookPct, 25)) / 100);
  return { on: true, bank: b, maxSol, maxOpen, momoMaxOpen, maxBags, deployMax, bookMax };
}

/** Largest buy into a migrated pool with `poolSol` SOL on its side that moves the price at most `impactPct` %. */
export function poolCap(poolSol: number, impactPct: number): number {
  if (!(poolSol > 0)) return 0;
  return poolSol * (Math.sqrt(1 + impactPct / 100) - 1);
}

/** SOL still at risk in a position: what it cost minus what its sells already took out. */
export const atRisk = (p: { costSol: number; soldSol?: number }) => Math.max(0, num(p.costSol, 0) - num(p.soldSol, 0));

/** The strategy a position belongs to: its GRID LIVE book, otherwise its entry lane. */
export const bookOf = (p: { gk?: string; how?: string }) => p.gk || `lane:${p.how || "direct"}`;

/**
 * How much more can go into one more position, given what is already open: null = the full size fits, otherwise the
 * room left (0 = none) and why. `book` is the strategy key of the new position.
 */
export function roomLeft(open: { costSol: number; soldSol?: number; gk?: string; how?: string }[], book: string, sc: Scale): { room: number; why: string } | null {
  if (!sc.on) return null;
  const all = open.reduce((a, p) => a + atRisk(p), 0);
  const mine = open.filter((p) => bookOf(p) === book).reduce((a, p) => a + atRisk(p), 0);
  const roomAll = sc.deployMax - all;
  const roomBook = sc.bookMax - mine;
  if (roomAll <= roomBook) return { room: Math.max(0, roomAll), why: `${all.toFixed(2)} of ${sc.deployMax.toFixed(2)} SOL at risk across the desk` };
  return { room: Math.max(0, roomBook), why: `${mine.toFixed(2)} of ${sc.bookMax.toFixed(2)} SOL at risk in this strategy` };
}

/** The ladder: what the limits are at each bank size (for /api/desk/scale and the review). */
export const LADDER = [2, 5, 10, 20, 50, 100, 250, 500, 1000];
