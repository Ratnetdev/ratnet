// v0.1.128: who is buying a coin right now. Every firehose buy by a watched wallet (a FOMO trader, an earner or a
// proven wallet) is noted per coin; the coin's state at a paper buy then carries, for the last 60 seconds:
//   fc  FOMO traders that bought (lib/fomotap.ts)
//   ea  earners that bought (lib/earners.ts)
//   pwi proven wallets that bought this coin, crews counted once (lib/crews.ts); pwr the same, every wallet counted
// RUG GUARD tests rules on them like on every other part of the state (lib/gridlive.ts RUG_RULES).
import { crewBuy, independent } from "./crews";
import { isBot, isEarner } from "./earners";
import { fomoBuy, fomoCrowd, fomoRegime, isFomo } from "./fomotap";
import { frBuy, frRecent } from "./frontrun";
// v0.1.132: SMART signals go to GRID LIVE's SMART family (set by the worker; no import cycle)
let SIGNAL: ((mint: string, sx: { fr?: number; fc?: number; st?: number }) => void) | null = null;
export const setSmartSignal = (f: typeof SIGNAL) => (SIGNAL = f);
const FC_FIRED = new Set<string>();
import { isProven, provenSet } from "./wallets";

const WIN_MS = 60_000;
const EARN = new Map<string, { w: string; at: number }[]>(); // mint -> earner buys
const BOTS = new Map<string, { w: string; at: number }[]>(); // mint -> bot buys (v0.1.130)
const note = (m: Map<string, { w: string; at: number }[]>, mint: string, w: string, at: number) => {
  let a = m.get(mint);
  if (!a) {
    a = [];
    m.set(mint, a);
    if (m.size > 30_000) m.delete(m.keys().next().value as string);
  }
  while (a.length && at - a[0].at > WIN_MS) a.shift();
  a.push({ w, at });
};
const recent = (m: Map<string, { w: string; at: number }[]>, mint: string, now: number) => [...new Set((m.get(mint) || []).filter((x) => now - x.at <= WIN_MS).map((x) => x.w))];
export const smartStats = { fomoBuys: 0, earnerBuys: 0, provenBuys: 0, botBuys: 0 };

export function smartTrade(t: { mint: string; user: string; isBuy: boolean; at: number; sol?: number }) {
  if (!t.isBuy || !t.user) return;
  // v0.1.132 FRONT-RUNNERS: every real buy is kept 4 minutes (callouts are matched against it); a known front-runner's
  // buy is a SMART signal
  const bot = isBot(t.user);
  if (frBuy(t.mint, t.user, t.sol ?? 0, t.at, bot) && SIGNAL) SIGNAL(t.mint, { fr: independent(frRecent(t.mint, t.at)) });
  if (bot) {
    note(BOTS, t.mint, t.user, t.at);
    smartStats.botBuys++;
    return; // a bot is never FOMO crowd, an earner or in a crew
  }
  const f = isFomo(t.user);
  const e = isEarner(t.user);
  const p = isProven(t.user);
  if (!f && !e && !p) return;
  if (f) {
    fomoBuy(t.mint, t.user, t.at);
    smartStats.fomoBuys++;
    // v0.1.132: the FOMO crowd arriving (5+ independent FOMO traders in a minute) is a SMART signal, once per coin
    const fw = fomoCrowd(t.mint, t.at);
    const fc = fw ? independent(fw) : 0;
    if (fc >= 5 && SIGNAL && !FC_FIRED.has(t.mint)) {
      FC_FIRED.add(t.mint);
      if (FC_FIRED.size > 20_000) FC_FIRED.delete(FC_FIRED.values().next().value as string);
      SIGNAL(t.mint, { fc });
    }
  }
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

export function smartFeatures(mint: string, now = Date.now()): { fc: number | null; ea: number; pwi: number; pwr: number; bt: number; fr: number; fm: number | null } {
  const fw = fomoCrowd(mint, now);
  const ew = [...new Set((EARN.get(mint) || []).filter((x) => now - x.at <= WIN_MS).map((x) => x.w))];
  const pw = provenSet(mint);
  return { fc: fw ? independent(fw) : null, ea: independent(ew), pwi: independent(pw), pwr: pw.size, bt: recent(BOTS, mint, now).length, fr: independent(frRecent(mint, now)), fm: fomoRegime(now) };
}
export const _smartReset = () => (EARN.clear(), BOTS.clear(), (smartStats.fomoBuys = smartStats.earnerBuys = smartStats.provenBuys = smartStats.botBuys = 0));
