// REGIME switch (v0.1.63, roadmap step 8): the market state turns the desk's strategies on, to half size, or off.
//
// Two kinds of evidence, read every 5 minutes in the worker:
//   1. The market: launches per hour and the share that graduates (last hours vs the day), SOL's trend (6h, 24h).
//   2. How each strategy is doing right now: the ARENA books trade every King, minute-1 and MOMO signal live, so their
//      last trips (8 hours, one result per coin) are the strategy's current hit rate. A strategy that stopped working
//      in this market shows it there first.
// Only King, minute-1 (early) and MOMO are switched (the strategies ARENA measures). ARENA itself never stops: it is
// the measurement. Signals the switch blocks go to the ghost desk, so "what the switch saved" is a real number.
// Hysteresis: worse applies at once; better needs two readings in a row and 30 minutes since the last switch.
// REGIME_MODE: on (default) | shadow (shown, the desk ignores it) | off.
// v0.1.66 PROMOTE: the desk only trades a strategy through a variant whose own ARENA record proves it (see promote()).
import { K, hourKey, redis } from "./redis";
import { memo } from "./memo";
import { VARIANTS } from "./arena";

export type GSleeve = "king" | "early" | "momo" | "wire";
export const GATED: GSleeve[] = ["king", "early", "momo", "wire"];
const GROUP: Record<string, GSleeve> = Object.fromEntries(VARIANTS.map((v) => [v.id, v.path]));
export const REGIME_VIEW = "rn:regime:view";
const SAVED = "rn:regime:saved";
const WINDOW_MS = 8 * 3600_000;
const COINS = 12; // the last 12 coins per strategy
const MIN_HOLD = 30 * 60_000;

export type MarketState = "hot" | "normal" | "cold" | "dead";
export type Market = { launchesNow: number | null; launchesBase: number | null; gradNow: number | null; gradBase: number | null; migrationsHour: number | null; sol6: number | null; sol24: number | null; state: MarketState; why: string[] };
export type Hit = { n: number; wins: number; winRate: number; avgPct: number };
export type Level = "on" | "half" | "off";
export type Gate = { level: Level; w: number; why: string; since: number; up: number };
export type Gates = Record<GSleeve, Gate>;
export type Switch = { at: number; sleeve: GSleeve; from: Level; to: Level; why: string };

export const regimeMode = (): "on" | "shadow" | "off" => {
  const m = String(process.env.REGIME_MODE || "on").toLowerCase();
  return m === "off" ? "off" : m === "shadow" ? "shadow" : "on";
};
const W: Record<Level, number> = { on: 1, half: 0.5, off: 0 };
const RANK: Record<Level, number> = { off: 0, half: 1, on: 2 };
const r1 = (x: number) => Math.round(x * 10) / 10;

/** The market state from hourly counters. rows[i] = the hour i hours ago (0 = the current, partial hour). */
export function classify(rows: { d: number; b: number; g: number | null }[], sol6: number | null, sol24: number | null): Market {
  const sum = (from: number, to: number, f: (x: (typeof rows)[0]) => number) => rows.slice(from, to).reduce((a, x) => a + f(x), 0);
  const full = (from: number, to: number) => rows.slice(from, to).filter((x) => x.d > 0).length;
  // launches: the last 3 complete hours vs the last 24
  const n3 = full(1, 4), n24 = full(1, 25);
  const launchesNow = n3 >= 2 ? sum(1, 4, (x) => x.d) / n3 : null;
  const launchesBase = n24 >= 6 ? sum(1, 25, (x) => x.d) / n24 : null;
  // graduation share by launch hour: coins need time to bond, so hours 2 to 4 ago vs hours 2 to 25 ago
  const dN = sum(2, 5, (x) => x.d), bN = sum(2, 5, (x) => x.b);
  const dB = sum(2, 26, (x) => x.d), bB = sum(2, 26, (x) => x.b);
  const gradNow = dN >= 300 ? (bN / dN) * 100 : null;
  const gradBase = dB >= 2000 ? (bB / dB) * 100 : null;
  const migrationsHour = rows[1]?.g ?? null;
  const why: string[] = [];
  const gr = gradNow != null && gradBase != null && gradBase > 0 ? gradNow / gradBase : null;
  const lr = launchesNow != null && launchesBase != null && launchesBase > 0 ? launchesNow / launchesBase : null;
  const gTxt = gr != null ? `graduations ${r1(gradNow!)}% of launches vs ${r1(gradBase!)}% over the day` : null;
  const s24 = sol24 != null ? `SOL ${sol24 >= 0 ? "+" : ""}${r1(sol24)}% in 24h` : null;
  const s6 = sol6 != null ? `SOL ${sol6 >= 0 ? "+" : ""}${r1(sol6)}% in 6h` : null;
  const lTxt = lr != null ? `launches ${Math.round(launchesNow!)}/h vs ${Math.round(launchesBase!)}/h` : null;
  // the reasons that set the state come first (the switch quotes the first two)
  const cause: (string | null)[] = [];
  let state: MarketState = "normal";
  if ((gr != null && gr <= 0.45) || (sol24 != null && sol24 <= -10)) {
    state = "dead";
    cause.push(gr != null && gr <= 0.45 ? gTxt : null, sol24 != null && sol24 <= -10 ? s24 : null);
  } else if ((gr != null && gr <= 0.7) || (sol24 != null && sol24 <= -5) || (sol6 != null && sol6 <= -4)) {
    state = "cold";
    cause.push(gr != null && gr <= 0.7 ? gTxt : null, sol24 != null && sol24 <= -5 ? s24 : null, sol6 != null && sol6 <= -4 ? s6 : null);
  } else if (gr != null && gr >= 1.3 && (lr == null || lr >= 0.8)) {
    state = "hot";
    cause.push(gTxt);
  }
  for (const x of [...cause, gTxt, lTxt, s24, s6]) if (x && !why.includes(x)) why.push(x);
  return { launchesNow: launchesNow == null ? null : Math.round(launchesNow), launchesBase: launchesBase == null ? null : Math.round(launchesBase), gradNow: gradNow == null ? null : Math.round(gradNow * 100) / 100, gradBase: gradBase == null ? null : Math.round(gradBase * 100) / 100, migrationsHour, sol6, sol24, state, why };
}

/** Each strategy's live hit rate from the ARENA trips: last 8 hours, one result per coin (averaged over the books). */
export function hitsOf(trips: { v: string; mint: string; closedAt: number; pnlPct: number }[], now = Date.now()): Record<GSleeve, Hit> {
  const out = {} as Record<GSleeve, Hit>;
  for (const s of GATED) {
    const by = new Map<string, { at: number; sum: number; n: number }>();
    for (const t of trips) {
      if (GROUP[t.v] !== s || now - t.closedAt > WINDOW_MS) continue;
      const c = by.get(t.mint) || { at: 0, sum: 0, n: 0 };
      c.at = Math.max(c.at, t.closedAt);
      c.sum += t.pnlPct;
      c.n++;
      by.set(t.mint, c);
    }
    const coins = [...by.values()].sort((a, b) => b.at - a.at).slice(0, COINS).map((c) => c.sum / c.n);
    const wins = coins.filter((x) => x > 0).length;
    out[s] = { n: coins.length, wins, winRate: coins.length ? Math.round((wins / coins.length) * 100) : 0, avgPct: coins.length ? r1(coins.reduce((a, x) => a + x, 0) / coins.length) : 0 };
  }
  return out;
}

/** Where each strategy should be now, with hysteresis against the previous gates. */
export function decide(m: Market, hits: Record<GSleeve, Hit>, prev: Partial<Gates> | null, now = Date.now()): { gates: Gates; switches: Switch[] } {
  const gates = {} as Gates;
  const switches: Switch[] = [];
  for (const s of GATED) {
    const h = hits[s] || { n: 0, wins: 0, winRate: 0, avgPct: 0 };
    const rec = `last ${h.n} coins won ${h.winRate}%, avg ${h.avgPct >= 0 ? "+" : ""}${h.avgPct}%`;
    const streak = h.n >= 8 && h.winRate < 25 && h.avgPct < -10;
    const hot = h.n >= 6 && h.winRate >= 45 && h.avgPct > 0;
    const weak = h.n >= 6 && h.avgPct < 0 && h.winRate < 35;
    // MOMO trades migrated coins: the launch market matters less, SOL's fall still does
    const solOnly = s === "momo" || s === "wire"; // migrated coins and tweet coins: the launch market matters less
    const dead = solOnly ? m.sol24 != null && m.sol24 <= -10 : m.state === "dead";
    const cold = solOnly ? (m.sol24 != null && m.sol24 <= -5) || (m.sol6 != null && m.sol6 <= -4) : m.state === "cold";
    let target: Level = "on";
    let why = h.n ? `ARENA ${rec}; market ${m.state}` : `market ${m.state}; no ARENA trips in 8h yet`;
    if (streak) (target = "off"), (why = `ARENA ${rec}: this strategy is not working right now`);
    else if (dead && !hot) (target = "off"), (why = `market ${m.state}${m.why.length ? ` (${m.why.slice(0, 2).join(", ")})` : ""}`);
    else if (weak) (target = "half"), (why = `ARENA ${rec}`);
    else if (cold && !hot) (target = "half"), (why = `market ${m.state}${m.why.length ? ` (${m.why.slice(0, 2).join(", ")})` : ""}`);
    else if (hot && (dead || cold)) why = `market ${m.state}, but ARENA ${rec}: kept on`;
    const p = prev?.[s];
    const cur: Level = p?.level ?? "on";
    let level = cur;
    let up = 0;
    let since = p?.since ?? now;
    if (RANK[target] < RANK[cur]) level = target;
    else if (RANK[target] > RANK[cur]) {
      up = (p?.up ?? 0) + 1;
      if (up >= 2 && now - since >= MIN_HOLD) (level = target), (up = 0);
      else why = `${why} (back up after 2 readings and 30 min)`;
    }
    if (level !== cur) {
      since = now;
      switches.push({ at: now, sleeve: s, from: cur, to: level, why });
    }
    gates[s] = { level, w: W[level], why, since, up };
  }
  return { gates, switches };
}

// ---- worker side

async function marketNow(): Promise<Market> {
  const r = redis();
  const now = Date.now();
  const hours = Array.from({ length: 26 }, (_, i) => hourKey(now - i * 3600_000));
  const p = r.pipeline();
  for (const h of hours) p.hmget(K.hr(h), "d", "b", "g");
  p.hmget("rn:solh", hourKey(now), hourKey(now - 3600_000), hourKey(now - 6 * 3600_000), hourKey(now - 7 * 3600_000), hourKey(now - 24 * 3600_000), hourKey(now - 25 * 3600_000));
  const res = (await p.exec()) as any[];
  const rows = res.slice(0, 26).map((x) => ({ d: Number(x?.d || 0), b: Number(x?.b || 0), g: x?.g == null ? null : Number(x.g) }));
  const sp = res[26] || {};
  const nowPx = Number(sp[hourKey(now)] || sp[hourKey(now - 3600_000)] || 0);
  const px6 = Number(sp[hourKey(now - 6 * 3600_000)] || sp[hourKey(now - 7 * 3600_000)] || 0);
  const px24 = Number(sp[hourKey(now - 24 * 3600_000)] || sp[hourKey(now - 25 * 3600_000)] || 0);
  const ch = (a: number, b: number) => (a && b ? r1((a / b - 1) * 100) : null);
  return classify(rows, ch(nowPx, px6), ch(nowPx, px24));
}

// ---- PROMOTE (v0.1.66). Every variant's record from its ARENA trips (last 3 days, last 30 trips). A strategy trades on
// the desk only through its promoted variant: proven = 15+ trips, 35%+ won, average +2% or better after every cost,
// profit factor 1.1+ without its best trip. The promoted variant keeps its place while it holds (average 0% or better,
// profit factor 1.0+); a challenger takes over only when it is proven and averages 3 points more. No proven variant:
// the strategy sits out on the desk (the ghost desk and ARENA keep trading it).
export type VRec = { n: number; wins: number; winRate: number; avgPct: number; pfLessBest: number; pnl: number };
export const PROMO = { minN: 15, minWin: 35, minAvg: 2, minPf: 1.1, holdAvg: 0, holdPf: 1, margin: 3, windowMs: 3 * 86400_000, last: 30 };
type Trip = { v: string; mint: string; closedAt: number; pnlPct: number; pnl?: number };
export function recordsOf(trips: Trip[], now = Date.now()): Record<string, VRec> {
  const out: Record<string, VRec> = {};
  for (const v of VARIANTS) {
    const mine = trips.filter((t) => t.v === v.id && now - t.closedAt <= PROMO.windowMs).sort((a, b) => b.closedAt - a.closedAt).slice(0, PROMO.last);
    const n = mine.length;
    const wins = mine.filter((t) => t.pnlPct > 0).length;
    const pnls = mine.map((t) => (t.pnl != null ? t.pnl : t.pnlPct / 100));
    const less = pnls.slice();
    if (less.length) less.splice(less.indexOf(Math.max(...less)), 1);
    const gw = less.filter((x) => x > 0).reduce((a, x) => a + x, 0);
    const gl = -less.filter((x) => x < 0).reduce((a, x) => a + x, 0);
    out[v.id] = { n, wins, winRate: n ? Math.round((wins / n) * 100) : 0, avgPct: n ? r1(mine.reduce((a, t) => a + t.pnlPct, 0) / n) : 0, pfLessBest: gl > 0 ? Math.round((gw / gl) * 100) / 100 : gw > 0 ? 99 : 0, pnl: Math.round(pnls.reduce((a, x) => a + x, 0) * 1e4) / 1e4 };
  }
  return out;
}
export const proven = (x: VRec | undefined) => !!x && x.n >= PROMO.minN && x.winRate >= PROMO.minWin && x.avgPct >= PROMO.minAvg && x.pfLessBest >= PROMO.minPf;
const holds = (x: VRec | undefined) => !!x && x.n >= PROMO.minN && x.avgPct >= PROMO.holdAvg && x.pfLessBest >= PROMO.holdPf;
export type Promo = { picks: Record<GSleeve, string | null>; why: Record<GSleeve, string>; changes: { sleeve: GSleeve; from: string | null; to: string | null; why: string }[] };
const recTxt = (id: string, x: VRec) => `${VARIANTS.find((v) => v.id === id)?.label || id}: ${x.n} trips, ${x.winRate}% won, avg ${x.avgPct >= 0 ? "+" : ""}${x.avgPct}%`;
export function promote(recs: Record<string, VRec>, prev: Partial<Record<GSleeve, string | null>> | null): Promo {
  const picks = {} as Record<GSleeve, string | null>;
  const why = {} as Record<GSleeve, string>;
  const changes: Promo["changes"] = [];
  for (const s of GATED) {
    const ids = VARIANTS.filter((v) => v.path === s).map((v) => v.id);
    const best = ids.filter((id) => proven(recs[id])).sort((a, b) => recs[b].avgPct - recs[a].avgPct || recs[b].pnl - recs[a].pnl)[0] || null;
    const cur = prev?.[s] ?? null;
    let pick: string | null;
    if (cur && holds(recs[cur])) pick = best && best !== cur && recs[best].avgPct >= recs[cur].avgPct + PROMO.margin ? best : cur;
    else pick = best;
    picks[s] = pick;
    const lead = ids.filter((id) => recs[id]?.n).sort((a, b) => recs[b].avgPct - recs[a].avgPct)[0];
    why[s] = pick ? `trading ${recTxt(pick, recs[pick])}` : lead ? `proving: no variant proven yet (best so far ${recTxt(lead, recs[lead])}; needs ${PROMO.minN}+ trips, ${PROMO.minWin}%+ won, avg +${PROMO.minAvg}%+)` : "proving: no ARENA trips yet";
    if (pick !== cur) changes.push({ sleeve: s, from: cur, to: pick, why: why[s] });
  }
  return { picks, why, changes };
}
export const provingMode = () => String(process.env.PROVING_MODE || "on").toLowerCase() !== "off";

let LOCAL: { at: number; gates: Gates; picks: Record<GSleeve, string | null>; why: Record<GSleeve, string> } | null = null;

/** One reading (worker, every 5 minutes): ARENA records promote a variant per strategy, then the market and the
 *  promoted variant's own hit rate set its level. Published for the desk and the site. */
export async function regimeTick(trips: Trip[], now = Date.now()) {
  const r = redis();
  const view = (await r.get<any>(REGIME_VIEW).catch(() => null)) || null;
  const prev: Partial<Gates> | null = LOCAL?.gates || view?.gates || null;
  const recs = recordsOf(trips, now);
  const promo = promote(recs, LOCAL?.picks || view?.promo?.picks || null);
  const market = await marketNow();
  // hit rates of what the desk actually trades: the promoted variants (all of a strategy's books when none is)
  const picked = new Set(Object.values(promo.picks).filter(Boolean) as string[]);
  const hits = hitsOf(trips.filter((t) => picked.has(t.v) || !promo.picks[GROUP[t.v] as GSleeve]), now);
  const { gates, switches } = decide(market, hits, prev, now);
  LOCAL = { at: now, gates, picks: promo.picks, why: promo.why };
  const saved = ((await r.hgetall<Record<string, number>>(SAVED).catch(() => null)) || {}) as Record<string, number>;
  const history: Switch[] = [...switches.slice().reverse(), ...((view?.history as Switch[]) || [])].slice(0, 30);
  const promos = [...promo.changes.map((c) => ({ at: now, ...c })).reverse(), ...((view?.promo?.history as any[]) || [])].slice(0, 30);
  const mode = regimeMode();
  await r.set(REGIME_VIEW, { at: now, mode, proving: provingMode(), market, hits, gates, history, promo: { picks: promo.picks, why: promo.why, recs, history: promos, rules: PROMO }, saved: { n: Number(saved.n || 0), wins: Number(saved.w || 0), pnl: Number(saved.p || 0) / 1e4 } }, { ex: 86400 });
  if (mode !== "off") {
    const ev = [
      ...switches.map((s) => ({ agent: "REGIME", at: now, text: `${mode === "shadow" ? "(shadow) " : ""}${s.sleeve} ${s.from} → ${s.to}: ${s.why}`, tone: s.to === "on" ? "win" : "info" })),
      ...promo.changes.map((c) => ({ agent: "REGIME", at: now, text: c.to ? `PROMOTE: the desk's ${c.sleeve} trades now follow "${VARIANTS.find((v) => v.id === c.to)?.label}" (${c.why.replace(/^trading /, "")})` : `PROMOTE: ${c.sleeve} benched on the desk, no variant proven (${c.why.replace(/^proving: /, "")})`, tone: c.to ? "win" : "info" })),
    ];
    if (ev.length) await r.lpush(K.deskEv, ...ev).catch(() => null);
  }
  return { market, hits, gates, switches, promo, recs };
}

/** The desk asks before a buy: size multiplier for this strategy right now (1 = untouched), and the promoted variant
 *  whose rules (entry and exits) the desk must follow for it. */
export async function gateFor(sleeve: string): Promise<{ w: number; level: Level; why: string; variant?: string | null }> {
  const none = { w: 1, level: "on" as Level, why: "" };
  const s = (sleeve === "vamp" ? "wire" : sleeve) as GSleeve;
  if (!GATED.includes(s) || regimeMode() !== "on") return none;
  const now = Date.now();
  let g: { at: number; gates: Gates; picks?: Record<GSleeve, string | null>; why?: Record<GSleeve, string>; promo?: any } | null = LOCAL && now - LOCAL.at < 15 * 60_000 ? LOCAL : null;
  if (!g) {
    const v = (await memo("regime:gates", 60_000, async () => (await redis().get<any>(REGIME_VIEW).catch(() => null)) || null)) as any;
    g = v ? { at: v.at, gates: v.gates, picks: v.promo?.picks, why: v.promo?.why } : null;
  }
  const fresh = !!g?.gates && now - g.at <= 30 * 60_000;
  if (provingMode()) {
    if (!fresh) return { w: 0, level: "off", why: "proving: waiting for the first reading", variant: null };
    const pick = g!.picks?.[s] ?? null;
    if (!pick) return { w: 0, level: "off", why: g!.why?.[s] || "proving: no variant proven yet", variant: null };
    const x = g!.gates[s];
    return { w: x?.w ?? 1, level: x?.level ?? "on", why: x?.why || "", variant: pick };
  }
  if (!fresh) return none; // no fresh reading: never block on stale data
  const x = g!.gates[s];
  return x ? { w: x.w, level: x.level, why: x.why } : none;
}

/** A ghost trade the switch blocked closed: what the switch saved (or cost). */
export async function regimeSaved(pnlSol: number) {
  const p = redis().pipeline();
  p.hincrby(SAVED, "n", 1);
  if (pnlSol > 0) p.hincrby(SAVED, "w", 1);
  p.hincrby(SAVED, "p", Math.round(pnlSol * 1e4));
  await p.exec();
}

/** For tests. */
export const regimeForget = () => (LOCAL = null);
