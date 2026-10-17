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
export function tapeTrade(t: { mint: string; user: string; isBuy: boolean; sol: number; at: number; creator?: string; mcSol?: number }) {
  if (t.creator && !DEV.has(t.mint)) DEV.set(t.mint, t.creator);
  flowTrade(t);
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
  FLOW.clear();
}

// ---------------------------------------------------------------- v0.1.105 KOL and EXIT flows
// Measured elsewhere (MadeOnSol, 533 KOL wallets, 1.13M trades): the first KOL buys at a ~$4.7K median market cap and a
// second follows within seconds; surge alerts were up an hour later 60% of the time, but only 6% when the early buyers
// were exiting. Our own record: copying KOL buys after the fact lost 12.4% at 1h. So the flow becomes features and an
// exit flag, never a buy trigger. From the firehose, every trade of every coin:
//   kf   tracked KOL wallets (HOUND's roster) that bought, and kmc the market cap (SOL) at the first KOL buy
//   kx   tracked KOL wallets that sold after buying
//   e20  the share of the coin's first 20 buyers (not the dev) that have sold (null until 10 buyers)
type Flow = { t0: number; first: Map<string, boolean>; kol: Map<string, number>; kmc: number | null; kx: Set<string> };
const FLOW = new Map<string, Flow>();
let KOLS = new Set<string>();
/** Worker, every 10 minutes: HOUND's KOL wallets (the roster in Redis). */
export const setKols = (ws: Iterable<string>) => (KOLS = new Set(ws));
export const kolCount = () => KOLS.size;
function flowTrade(t: { mint: string; user: string; isBuy: boolean; at: number; mcSol?: number }) {
  let f = FLOW.get(t.mint);
  if (!f) {
    if (!t.isBuy) return;
    FLOW.set(t.mint, (f = { t0: t.at, first: new Map(), kol: new Map(), kmc: null, kx: new Set() }));
    if (FLOW.size > 60_000) FLOW.delete(FLOW.keys().next().value as string);
  }
  const dev = DEV.get(t.mint);
  if (t.isBuy) {
    if (f.first.size < 20 && t.user !== dev && !f.first.has(t.user)) f.first.set(t.user, false);
    if (KOLS.has(t.user) && !f.kol.has(t.user)) {
      f.kol.set(t.user, t.at);
      if (f.kmc == null && t.mcSol) f.kmc = Math.round(t.mcSol * 10) / 10;
    }
  } else {
    if (f.first.has(t.user)) f.first.set(t.user, true);
    if (f.kol.has(t.user)) f.kx.add(t.user);
  }
}
export type FlowFeat = { kf: number; kmc: number | null; kx: number; e20: number | null };
export function flowFeatures(mint: string): FlowFeat {
  const f = FLOW.get(mint);
  if (!f) return { kf: 0, kmc: null, kx: 0, e20: null };
  const sold = [...f.first.values()].filter(Boolean).length;
  return { kf: f.kol.size, kmc: f.kmc, kx: f.kx.size, e20: f.first.size >= 10 ? Math.round((sold / f.first.size) * 100) / 100 : null };
}
/** Every 30s with tapeSweep: coins older than 3 hours leave the flow book. */
export function flowSweep(now = Date.now()) {
  for (const [m, f] of FLOW) if (now - f.t0 > 3 * 3600_000) FLOW.delete(m);
}
