// v0.1.128: who is buying a coin right now. Every firehose buy by a watched wallet (a FOMO trader, an earner or a
// proven wallet) is noted per coin; the coin's state at a paper buy then carries, for the last 60 seconds:
//   fc  FOMO traders that bought (lib/fomotap.ts)
//   ea  earners that bought (lib/earners.ts)
//   pwi proven wallets that bought this coin, crews counted once (lib/crews.ts); pwr the same, every wallet counted
// RUG GUARD tests rules on them like on every other part of the state (lib/gridlive.ts RUG_RULES).
import { crewBuy, independent } from "./crews";
import { isEarner } from "./earners";
import { fomoBuy, fomoCrowd, isFomo } from "./fomotap";
import { isProven, provenSet } from "./wallets";

const WIN_MS = 60_000;
const EARN = new Map<string, { w: string; at: number }[]>(); // mint -> earner buys
export const smartStats = { fomoBuys: 0, earnerBuys: 0, provenBuys: 0 };

export function smartTrade(t: { mint: string; user: string; isBuy: boolean; at: number }) {
  if (!t.isBuy || !t.user) return;
  const f = isFomo(t.user);
  const e = isEarner(t.user);
  const p = isProven(t.user);
  if (!f && !e && !p) return;
  if (f) (fomoBuy(t.mint, t.user, t.at), smartStats.fomoBuys++);
  if (e) {
    let a = EARN.get(t.mint);
    if (!a) {
      a = [];
      EARN.set(t.mint, a);
      if (EARN.size > 30_000) EARN.delete(EARN.keys().next().value as string);
    }
    while (a.length && t.at - a[0].at > WIN_MS) a.shift();
    a.push({ w: t.user, at: t.at });
    smartStats.earnerBuys++;
  }
  if (p) smartStats.provenBuys++;
  crewBuy(t.mint, t.user, t.at);
}

export function smartFeatures(mint: string, now = Date.now()): { fc: number | null; ea: number; pwi: number; pwr: number } {
  const fw = fomoCrowd(mint, now);
  const ew = [...new Set((EARN.get(mint) || []).filter((x) => now - x.at <= WIN_MS).map((x) => x.w))];
  const pw = provenSet(mint);
  return { fc: fw ? independent(fw) : null, ea: independent(ew), pwi: independent(pw), pwr: pw.size };
}
export const _smartReset = () => (EARN.clear(), (smartStats.fomoBuys = smartStats.earnerBuys = smartStats.provenBuys = 0));
