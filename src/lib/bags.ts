// Bag snapshot: the bag that counts for a round is the LOWEST $RAT the wallet held during that round (the 12h before
// the close), sampled every few minutes. Buying right before the close adds nothing, dumping right after a payout
// costs the next one. Burning for a rat, a pup or a sniff is not selling: burns are added back before the minimum.
import { redis } from "./redis";
import { BURNW } from "./burns";

const MINK = (round: number) => `rn:bagmin:${round}`;

/** Record one sample per wallet: balance now + what it burned this round. Keeps the minimum. */
export async function sampleBags(round: number, bal: Record<string, number>) {
  const owners = Object.keys(bal);
  if (!owners.length) return;
  const r = redis();
  const [mins, burned] = await Promise.all([r.hmget<Record<string, number>>(MINK(round), ...owners), r.hmget<Record<string, number>>(BURNW(round), ...owners)]);
  const next: Record<string, number> = {};
  for (const o of owners) {
    const v = Number(bal[o] || 0) + Number(burned?.[o] || 0);
    const m = mins?.[o];
    if (m == null || v < Number(m)) next[o] = Math.round(v);
  }
  if (Object.keys(next).length) {
    await r.hset(MINK(round), next);
    await r.expire(MINK(round), 4 * 86400);
  }
}

/** The bag a wallet gets paid on for a round: min(lowest sample, balance at the close + burns this round). */
export async function bagFor(round: number, owner: string, balNow: number) {
  const r = redis();
  const [m, b] = await Promise.all([r.hget<number>(MINK(round), owner), r.hget<number>(BURNW(round), owner)]);
  const atClose = balNow + Number(b || 0);
  return m == null ? atClose : Math.min(Number(m), atClose);
}
