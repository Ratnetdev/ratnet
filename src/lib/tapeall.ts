// v0.1.81: TAPE ALL. The last minute of trades on every coin (FIREHOSE), read the moment a strategy needs it:
// unique buyers, the share of SOL that was buying, whale buys (2+ SOL), and whether the dev has sold. Before this the
// TAPE agent read these once, at the call, for a shortlist only.
import { provenBuyers } from "./wallets";

type Tk = { at: number; user: string; buy: boolean; sol: number };
const WIN = new Map<string, Tk[]>();
const DEV = new Map<string, string>(); // mint -> creator
const DEV_SOLD = new Set<string>();
const KEEP_MS = 120_000;

export function tapeCreate(mint: string, creator: string) {
  DEV.set(mint, creator);
  if (DEV.size > 100_000) DEV.delete(DEV.keys().next().value as string);
}
export function tapeTrade(t: { mint: string; user: string; isBuy: boolean; sol: number; at: number; creator?: string }) {
  if (t.creator && !DEV.has(t.mint)) DEV.set(t.mint, t.creator);
  if (!t.isBuy && DEV.get(t.mint) === t.user) {
    DEV_SOLD.add(t.mint);
    if (DEV_SOLD.size > 100_000) DEV_SOLD.delete(DEV_SOLD.values().next().value as string);
  }
  let w = WIN.get(t.mint);
  if (!w) WIN.set(t.mint, (w = []));
  w.push({ at: t.at, user: t.user, buy: t.isBuy, sol: t.sol });
  if (w.length > 800) w.splice(0, w.length - 800);
}
/** Every 30s: forget coins that stopped trading. */
export function tapeSweep(now = Date.now()) {
  for (const [m, w] of WIN) {
    while (w.length && now - w[0].at > KEEP_MS) w.shift();
    if (!w.length) WIN.delete(m);
  }
}
export type LiveFeat = { pw: number; u60: number; bs60: number | null; wh: number; ds: boolean; n60: number };
/** The last 60 seconds of one coin. */
export function tapeFeatures(mint: string, now = Date.now()): LiveFeat {
  const w = (WIN.get(mint) || []).filter((x) => now - x.at <= 60_000);
  const buyers = new Set<string>();
  let b = 0;
  let s = 0;
  let wh = 0;
  for (const x of w) {
    if (x.buy) {
      buyers.add(x.user);
      b += x.sol;
      if (x.sol >= 2) wh++;
    } else s += x.sol;
  }
  return { pw: provenBuyers(mint), u60: buyers.size, bs60: b + s > 0 ? Math.round((b / (b + s)) * 100) / 100 : null, wh, ds: DEV_SOLD.has(mint), n60: w.length };
}
export const tapeSize = () => WIN.size;
export function _tapeReset() {
  WIN.clear();
  DEV.clear();
  DEV_SOLD.clear();
}
