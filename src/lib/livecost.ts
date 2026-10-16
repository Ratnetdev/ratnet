// v0.1.96: PARITY. What a live transaction really pays in priority fee, from the desk's own landed transactions. Paper
// (the desk's paper books, GRID and GRID LIVE) charged a fixed 0.0003 SOL per transaction; the live wallet paid about
// 0.001 on 16 Oct (11 transactions: 0.0002 to 0.0019), so every paper round trip at 0.05 SOL looked ~3% better than live
// money could do. Paper now charges the median of the last 30 live transactions (10 needed, bounded 0.0001 to 0.003).
import { redis } from "./redis";

const KEY = "rn:exec:fees"; // newest first: priority + base fee per landed live transaction, in SOL
const KEEP = 30;
export const LIVE_FEE_MIN_N = 10;
const LO = 0.0001;
const HI = 0.003;
export const LIVE_FEE = { prioritySol: null as number | null, n: 0, at: 0 };

export function medianFee(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x) && x >= 0).slice(0, KEEP);
  if (v.length < LIVE_FEE_MIN_N) return null;
  const s = v.slice().sort((a, z) => a - z);
  const m = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return Math.round(Math.max(LO, Math.min(HI, m)) * 1e6) / 1e6;
}

function apply(xs: number[]) {
  LIVE_FEE.prioritySol = medianFee(xs);
  LIVE_FEE.n = Math.min(KEEP, xs.length);
  LIVE_FEE.at = Date.now();
}

/** Paper's priority fee per transaction: the live median once there are 10 live transactions, else the setting. */
export const paperPriority = (fallback: number) => LIVE_FEE.prioritySol ?? fallback;

/** Read the live record (worker boot, GRID runs). */
export async function loadLiveFees() {
  const xs = ((await redis().lrange<number>(KEY, 0, KEEP - 1).catch(() => [])) || []).map(Number);
  apply(xs);
  return LIVE_FEE;
}

/** One landed live transaction: its fee from the chain (lamports, priority + base). The tip is booked separately. */
export async function noteLiveFee(feeLamports: number) {
  if (!Number.isFinite(feeLamports) || feeLamports <= 0) return;
  const r = redis();
  await r.lpush(KEY, feeLamports / 1e9).catch(() => 0);
  await r.ltrim(KEY, 0, KEEP - 1).catch(() => null);
  await loadLiveFees().catch(() => null);
}
