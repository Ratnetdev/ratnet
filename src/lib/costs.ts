// What a trade really costs, the same on paper as live (v0.1.30). Before, paper paid a flat 1% fee and 2% slippage per
// side and nothing else; a live trade also pays a Jito tip and a priority fee per transaction, and the venue fee is
// 1.25% on the curve. At the desk's 0.05 SOL sizes the fixed part alone is several % per round trip, so paper looked
// far better than live could ever be.
//
// Venue fees (checked 7 Oct 2026):
//  - pump.fun bonding curve: 1.25% per trade (0.95% protocol + 0.30% creator)
//  - PumpSwap canonical pools: dynamic by market cap in SOL, 1.25% under 420 SOL down to 0.30% above 98,240 SOL
// Fixed per transaction: base fee, Jito tip (0.4% of the trade, between jitoTipMinSol and jitoTipMaxSol) and the
// priority fee (paperPrioritySol, 0.0005 SOL to start). The token account rent is paid on the
// buy and refunded when the account is closed on the full exit.

export const ATA_RENT = 0.00203928;
export const BASE_FEE = 0.000005;
export const LATENCY_SLIP = 0.01; // the price moves while the order lands (about a second)

const POOL_TIERS: [number, number][] = [
  [420, 0.0125], [1470, 0.012], [2460, 0.0115], [3440, 0.011], [4420, 0.0105], [9820, 0.01], [14740, 0.0095],
  [19650, 0.009], [24560, 0.0085], [29470, 0.008], [34380, 0.0075], [39300, 0.007], [44210, 0.0065], [49120, 0.006],
  [54030, 0.0055], [58940, 0.00525], [63860, 0.005], [68770, 0.00475], [73681, 0.0045], [78590, 0.00425],
  [83500, 0.004], [88400, 0.00375], [93330, 0.0035], [98240, 0.00325],
];

/** Venue fee as a fraction of the trade. mcSol = market cap in SOL. */
export function venueFee(grad: boolean, mcSol: number) {
  if (!grad) return 0.0125;
  for (const [hi, f] of POOL_TIERS) if (mcSol < hi) return f;
  return 0.003;
}

export type CostCfg = { jitoTipMinSol?: number; jitoTipMaxSol?: number; paperPrioritySol?: number; fastExec?: boolean };

/** Fixed SOL cost of one transaction of `sol` (tip + priority + base fee). */
export function txCost(sol: number, c: CostCfg = {}) {
  const tip = c.fastExec === false ? 0 : Math.max(c.jitoTipMinSol ?? 0.0003, Math.min(c.jitoTipMaxSol ?? 0.002, sol * 0.004));
  return tip + (c.paperPrioritySol ?? 0.0005) + BASE_FEE;
}

/**
 * Average-price slippage of a trade of `sol` SOL against a constant-product reserve: on the curve the reserve is the
 * virtual SOL (30 + real), in a pool it is the pool's SOL. Plus the latency slip.
 */
export function slipOf(sol: number, grad: boolean, real: number) {
  const reserve = grad ? Math.max(1, real) : 30 + Math.max(0, real);
  return LATENCY_SLIP + sol / (reserve + sol);
}

/** What selling `tokens` at `px` brings in after every cost (the liquidation value of a bag). */
export function sellProceeds(tokens: number, px: number, grad: boolean, real: number, c: CostCfg = {}, closesAccount = false) {
  const gross = tokens * px;
  if (gross <= 0) return 0;
  const net = gross * (1 - slipOf(gross, grad, real)) * (1 - venueFee(grad, px * 1e9)) - txCost(gross, c) + (closesAccount ? ATA_RENT : 0);
  return Math.max(0, net);
}

/** Round-trip cost of a position of `sol` as a fraction (both venue fees, fixed costs, both slips): for the exit lab. */
export function roundTripCost(sol: number, grad: boolean, real: number, mcSol: number, c: CostCfg = {}) {
  if (!(sol > 0)) return 0;
  return 2 * venueFee(grad, mcSol) + 2 * slipOf(sol, grad, real) + (2 * txCost(sol, c)) / sol;
}
