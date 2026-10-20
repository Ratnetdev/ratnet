// v0.1.128: who is buying a coin right now. Every firehose buy by a watched wallet (a FOMO trader, an earner or a
// proven wallet) is noted per coin; the coin's state at a paper buy then carries, for the last 60 seconds:
//   fc  FOMO traders that bought (lib/fomotap.ts)
//   ea  earners that bought (lib/earners.ts)
//   pwi proven wallets that bought this coin, crews counted once (lib/crews.ts); pwr the same, every wallet counted
// RUG GUARD tests rules on them like on every other part of the state (lib/gridlive.ts RUG_RULES).
import { crewBuy, independent } from "./crews";
import { isBot, isEarner } from "./earners";
import { fomoBuy, fomoCrowd, fomoRegime, isFomo } from "./fomotap";
import { frBuy, frRecent, isFrontRunner } from "./frontrun";
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

// v0.1.133 RAT KING CHECK: who bought each coin since the worker first saw it (capped sets, last 20K coins), so a check
// of any live coin can say who is in it, not only who bought in the last minute
type Tally = { at0: number; n: number; sol: number; u0?: number; last?: number; u: Set<string>; fomo: Set<string>; earn: Set<string>; proven: Set<string>; bot: Set<string>; fr: Set<string> };
const TALLY = new Map<string, Tally>();
const TALLY_MAX = 20_000;
const CAP = 300;
const put = (s: Set<string>, w: string) => s.size < CAP && s.add(w);
function tally(t: { mint: string; user: string; at: number; sol?: number }, kind: { bot: boolean; fomo: boolean; earn: boolean; proven: boolean; fr: boolean }) {
  let x = TALLY.get(t.mint);
  if (!x) {
    x = { at0: t.at, n: 0, sol: 0, u: new Set(), fomo: new Set(), earn: new Set(), proven: new Set(), bot: new Set(), fr: new Set() };
    TALLY.set(t.mint, x);
    if (TALLY.size > TALLY_MAX) TALLY.delete(TALLY.keys().next().value as string);
  }
  x.n++;
  x.last = t.at;
  x.sol += Math.min(t.sol ?? 0, 500);
  put(x.u, t.user);
  if (kind.bot) put(x.bot, t.user);
  if (kind.fomo) put(x.fomo, t.user);
  if (kind.earn) put(x.earn, t.user);
  if (kind.proven) put(x.proven, t.user);
  if (kind.fr) put(x.fr, t.user);
}
/** Who bought the coin since the worker first saw it. null = no buys seen. Crews count once (independent). */
export function smartRead(mint: string, now = Date.now()) {
  const x = TALLY.get(mint);
  if (!x) return null;
  const smart = [...x.fomo, ...x.earn, ...x.proven];
  return {
    since: x.at0,
    buys: x.n,
    buyers: Math.min(CAP, x.u.size + (x.u0 || 0)),
    buyersCapped: x.u.size + (x.u0 || 0) >= CAP,
    sol: Math.round(x.sol * 100) / 100,
    fomo: independent(x.fomo),
    earners: independent(x.earn),
    proven: independent(x.proven),
    bots: x.bot.size,
    front: independent(x.fr),
    smart: new Set(smart).size,
    smartCrews: independent(smart),
    now: smartFeatures(mint, now),
  };
}
// v0.1.134: the tally survives a worker restart (Redis, every 5 minutes): coins traded in the last 3 hours, the watched
// wallets kept (to dedupe after a load), plain buyers kept as a count
type TallyDump = Record<string, { a: number; l: number; n: number; s: number; u: number; f: string[]; e: string[]; p: string[]; b: string[]; r: string[] }>;
export function tallyDump(now = Date.now(), max = 4000, ageMs = 3 * 3600_000): TallyDump {
  const out: TallyDump = {};
  const xs = [...TALLY.entries()].filter(([, x]) => now - (x.last ?? x.at0) <= ageMs).sort((a, z) => (z[1].last ?? z[1].at0) - (a[1].last ?? a[1].at0)).slice(0, max);
  const cut = (s: Set<string>) => [...s].slice(0, 60);
  for (const [m, x] of xs) out[m] = { a: x.at0, l: x.last ?? x.at0, n: x.n, s: Math.round(x.sol * 100) / 100, u: Math.min(CAP, x.u.size + (x.u0 || 0)), f: cut(x.fomo), e: cut(x.earn), p: cut(x.proven), b: cut(x.bot), r: cut(x.fr) };
  return out;
}
export function tallyLoad(d: TallyDump | null | undefined) {
  let n = 0;
  for (const [m, v] of Object.entries(d || {})) {
    if (!v || TALLY.has(m) || typeof v.n !== "number") continue;
    TALLY.set(m, { at0: v.a, last: v.l, n: v.n, sol: v.s || 0, u0: v.u || 0, u: new Set(), fomo: new Set(v.f || []), earn: new Set(v.e || []), proven: new Set(v.p || []), bot: new Set(v.b || []), fr: new Set(v.r || []) });
    n++;
  }
  return n;
}
export type SmartRead = NonNullable<ReturnType<typeof smartRead>>;

export function smartTrade(t: { mint: string; user: string; isBuy: boolean; at: number; sol?: number }) {
  if (!t.isBuy || !t.user) return;
  try {
    const b0 = isBot(t.user);
    tally(t, { bot: b0, fomo: !b0 && isFomo(t.user), earn: !b0 && isEarner(t.user), proven: !b0 && isProven(t.user), fr: !b0 && isFrontRunner(t.user) });
  } catch {}
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
export const _smartReset = () => (EARN.clear(), BOTS.clear(), TALLY.clear(), (smartStats.fomoBuys = smartStats.earnerBuys = smartStats.provenBuys = smartStats.botBuys = 0));
