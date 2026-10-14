// v0.1.71: GRID. The big search for a strategy that wins, run on the archive instead of waiting days of live paper.
// ARENA's 20 books all lose (last 30 trips each, -11% to -31% per trade after costs), so instead of guessing the next
// variant, GRID tries thousands of them on every archived call with a price path:
//   - filters: no filter, 18 single rules on the call (verdicts, scores, curve band, curve speed, buyers, SOL per buy,
//     bundles, snipers, smart wallets, dev sold, socials, age) and every pair of them (172 filters)
//   - entry timing: at the call, on confirmation (the curve climbs more first), on a dip, or 2 minutes later if still up
//   - exits: initials at 1.5x/2x/3x, trail 25/40%, stop 25/45%, time 15/60 min
// Every trade pays the desk's costs at the desk's size (venue fee, slippage on the curve, tip, priority fee, rent) and
// fills at the first price 2+ seconds after the signal (the desk is never at the signal's own price).
//
// Against fooling ourselves (with ~29,000 combinations, the best one on any data looks great by luck):
//   - calls split by time: settings ranked on the older 70% (train), judged only on the newest 30% (test)
//   - ranked only if train has 40+ trades, profit factor 1.1+ without the best trade, and BOTH halves of train positive
//   - "passes" = the test meets PROMOTE's bar: 20+ trips, 35%+ won, avg +2%+, PF 1.1+ without the best trade
// A pass is a candidate, not a strategy: it goes into ARENA next and must prove itself on live coins.
import { SITE } from "@/config/site";
import { ATA_RENT, sellProceeds, slipOf, txCost, venueFee, type CostCfg } from "./costs";

const D = (SITE as any).desk || {};
export const GRID_SOL = Number(D.minSol ?? 0.05); // the desk's trade size (5% of a 1 SOL paper desk)
const COST: CostCfg = { jitoTipMinSol: D.jitoTipMinSol, jitoTipMaxSol: D.jitoTipMaxSol, paperPrioritySol: D.paperPrioritySol };
const FILL_DELAY = 2_000;
const PATH_MS = 62 * 60_000; // the curve: the hour after the call
export const HOLD_MS = 6 * 3600_000; // v0.1.72: through the migration, up to 6 hours (lib/after.ts)

export type GCoin = {
  mint: string;
  symbol: string;
  at: number; // call time
  createdAt: number;
  verdict: string;
  score: number;
  nano: number | null;
  progress: number;
  rise60: number; // curve points gained in the minute before the call
  uniq: number | null;
  spb: number | null;
  bs: number | null;
  sn: number | null;
  sm: number;
  ds: boolean;
  soc: number;
  bonded?: boolean; // migrated (the senders: every coin that did millions in volume is one of these)
  bondSecs?: number | null;
  // the path from the call on (ms after the call), mcSol, real SOL, migrated
  t: Int32Array;
  mc: Float32Array;
  real: Float32Array;
  prog: Float32Array;
  done: Uint8Array;
};

export type Pred = { id: string; label: string; ok: (c: GCoin) => boolean };
export const PREDS: Pred[] = [
  { id: "bond", label: "King BOND", ok: (c) => c.verdict === "BOND" },
  { id: "watch", label: "King WATCH or BOND", ok: (c) => c.verdict === "BOND" || c.verdict === "WATCH" },
  { id: "s60", label: "King score 60+", ok: (c) => c.score >= 60 },
  { id: "n50", label: "nano 50+", ok: (c) => (c.nano ?? 0) >= 50 },
  { id: "p4", label: "curve 4-15%", ok: (c) => c.progress >= 4 && c.progress < 15 },
  { id: "p15", label: "curve 15-35%", ok: (c) => c.progress >= 15 && c.progress < 35 },
  { id: "p35", label: "curve 35-70%", ok: (c) => c.progress >= 35 && c.progress <= 70 },
  { id: "p70", label: "curve 70%+ (near migration)", ok: (c) => c.progress > 70 },
  { id: "r5", label: "curve +5 pts in the minute before", ok: (c) => c.rise60 >= 5 },
  { id: "r15", label: "curve +15 pts in the minute before", ok: (c) => c.rise60 >= 15 },
  { id: "u20", label: "20+ unique buyers", ok: (c) => (c.uniq ?? 0) >= 20 },
  { id: "u50", label: "50+ unique buyers", ok: (c) => (c.uniq ?? 0) >= 50 },
  { id: "spb", label: "0.3+ SOL per buy", ok: (c) => (c.spb ?? 0) >= 0.3 },
  { id: "bs", label: "bundles under 20%", ok: (c) => c.bs != null && c.bs < 0.2 },
  { id: "sn", label: "3 snipers or fewer", ok: (c) => c.sn != null && c.sn <= 3 },
  { id: "sm", label: "a smart wallet bought", ok: (c) => c.sm >= 1 },
  { id: "nods", label: "dev has not sold", ok: (c) => !c.ds },
  { id: "soc", label: "has a social link", ok: (c) => c.soc >= 1 },
  { id: "young", label: "called within 2 min of launch", ok: (c) => c.at - c.createdAt <= 120_000 },
];

export type Mode = { id: string; label: string; kind: "now" | "climb" | "dip" | "hold" | "mig"; a: number; win: number };
export const MODES: Mode[] = [
  { id: "now", label: "at the call", kind: "now", a: 0, win: 0 },
  { id: "c5", label: "once the curve gains 5 more points (within 3 min)", kind: "climb", a: 5, win: 3 },
  { id: "c10", label: "once the curve gains 10 more points (within 5 min)", kind: "climb", a: 10, win: 5 },
  { id: "c20", label: "once the curve gains 20 more points (within 10 min)", kind: "climb", a: 20, win: 10 },
  { id: "d15", label: "on a 15% dip (within 10 min)", kind: "dip", a: 0.15, win: 10 },
  { id: "d30", label: "on a 30% dip (within 10 min)", kind: "dip", a: 0.3, win: 10 },
  { id: "h2", label: "2 min after the call, if still above the call price", kind: "hold", a: 0, win: 2 },
  // v0.1.72: the senders were at ~80% curve when called and migrated ~8 minutes later: buy the migration itself
  { id: "mig", label: "when it migrates (within 30 min of the call)", kind: "mig", a: 0, win: 30 },
];

// v0.1.72: mig = what happens at the migration: "sell" (as before) or "hold" through it into the pool (up to 6 hours,
// the same initials, trail and stop on the pool price, at pool fees)
export type GExit = { initials: number; trail: number; stop: number; timeMin: number; mig: "sell" | "hold" };
export const GEXITS: GExit[] = [];
for (const mig of ["sell", "hold"] as const) for (const initials of [1.5, 2, 3]) for (const trail of [0.25, 0.4]) for (const stop of [0.25, 0.45]) for (const timeMin of [15, 60]) GEXITS.push({ initials, trail, stop, timeMin, mig });
export const exitText = (x: GExit) => `half at ${x.initials}x, trail ${Math.round(x.trail * 100)}%, stop -${Math.round(x.stop * 100)}%, out after ${x.timeMin}m without initials, ${x.mig === "hold" ? "holds through the migration (up to 6h)" : "sells at the migration"}`;

/** The tick the desk would fill at for a mode, or -1 (no entry). done: 0 curve, 1 the migration, 2 pool prices after it. */
export function entryIndex(c: GCoin, m: Mode): number {
  const n = c.t.length;
  if (!n) return -1;
  let trig = -1;
  if (m.kind === "mig") {
    for (let i = 0; i < n && c.t[i] <= m.win * 60_000; i++) {
      if (c.done[i] === 2) {
        trig = i;
        break;
      }
    }
    if (trig < 0) return -1;
    const want = c.t[trig] + FILL_DELAY;
    for (let j = trig; j < n; j++) if (c.t[j] >= want && c.done[j] === 2) return j;
    return -1;
  }
  if (m.kind === "now") {
    trig = 0;
    // the call needs a price close to it
    if (c.t[0] > 30_000) return -1;
  } else {
    const p0 = c.prog[0];
    const px0 = c.mc[0];
    for (let i = 1; i < n && c.t[i] <= m.win * 60_000; i++) {
      if (c.done[i]) return -1;
      if (m.kind === "climb" && c.prog[i] >= p0 + m.a) {
        trig = i;
        break;
      }
      if (m.kind === "dip" && c.mc[i] <= px0 * (1 - m.a)) {
        trig = i;
        break;
      }
    }
    if (m.kind === "hold") {
      // the last price at or before 2 minutes; enter if it is above the call's
      let k = -1;
      for (let i = 0; i < n && c.t[i] <= m.win * 60_000; i++) k = i;
      if (k < 0 || c.t[k] < 60_000 || !(c.mc[k] > px0) || c.done[k]) return -1;
      trig = k;
    }
    if (trig < 0) return -1;
  }
  // fill at the first price 2+ seconds after the signal
  const want = c.t[trig] + FILL_DELAY;
  for (let j = trig; j < n; j++) if (c.t[j] >= want) return c.done[j] ? -1 : j;
  return -1;
}

/** One round trip from fill tick j under exit x: P&L in SOL (null: no usable price). */
export function tradeFrom(c: GCoin, j: number, x: GExit, sol = GRID_SOL): number | null {
  const n = c.t.length;
  const px0 = c.mc[j] / 1e9;
  if (!(px0 > 0) || c.done[j] === 1) return null;
  const inPool = c.done[j] === 2; // bought after the migration (mode "mig")
  if (inPool && x.mig === "sell") return null;
  const fillPx = px0 * (1 + slipOf(sol, inPool, c.real[j]));
  let tokens = (sol * (1 - venueFee(inPool, c.mc[j]))) / fillPx;
  const cost = sol + txCost(sol, COST) + ATA_RENT;
  let back = 0;
  let peak = px0;
  let initials = false;
  const sell = (frac: number, k: number) => {
    const amt = frac >= 1 ? tokens : tokens * frac;
    back += sellProceeds(amt, c.mc[k] / 1e9, c.done[k] === 2, c.real[k], COST, frac >= 1);
    tokens -= amt;
  };
  const tEnd = c.t[j] + x.timeMin * 60_000;
  const hardEnd = x.mig === "hold" ? c.t[j] + HOLD_MS : Infinity;
  let k = j;
  for (let i = j + 1; i < n; i++) {
    const d = c.done[i];
    // the migration: sell there (as before), or ride on into the pool
    if (d && x.mig === "sell") return (sell(1, d === 1 ? i : k), back - cost);
    if (d === 1) continue; // the curve's last price; the pool prices follow
    if (c.t[i] > hardEnd) break;
    k = i;
    const px = c.mc[i] / 1e9;
    if (!(px > 0)) continue;
    if (px > peak) peak = px;
    const xr = px / fillPx;
    if (!initials && xr >= x.initials) {
      sell(0.5, i);
      initials = true;
      continue;
    }
    if (xr <= 1 - x.stop) return (sell(1, i), back - cost);
    if (initials && px <= peak * (1 - x.trail)) return (sell(1, i), back - cost);
    if (c.t[i] >= tEnd && (!initials || xr < 1.1)) return (sell(1, i), back - cost);
  }
  // the path ended (the coin stopped trading, or the time ran out): sold at the last price
  if (tokens > 1e-12) sell(1, k);
  return back - cost;
}

export type GStat = { n: number; wins: number; winRate: number; avgPct: number; pnl: number; pfLessBest: number };
const r1 = (v: number) => Math.round(v * 10) / 10;

type Acc = { n: number; w: number; s: number; ss: number; gw: number; gl: number; best: number; nA: number; sA: number; nB: number; sB: number };
const acc0 = (): Acc => ({ n: 0, w: 0, s: 0, ss: 0, gw: 0, gl: 0, best: -Infinity, nA: 0, sA: 0, nB: 0, sB: 0 });
function finish(a: Acc, cost: number): GStat & { t: number; halvesUp: boolean } {
  const gw = a.best > 0 ? a.gw - a.best : a.gw;
  const pf = a.gl > 0 ? gw / a.gl : gw > 0 ? 99 : 0;
  const mean = a.n ? a.s / a.n : 0;
  const sd = a.n > 1 ? Math.sqrt(Math.max(0, a.ss / a.n - mean * mean)) : 0;
  return {
    n: a.n,
    wins: a.w,
    winRate: a.n ? r1((a.w / a.n) * 100) : 0,
    avgPct: r1((mean / cost) * 100),
    pnl: Math.round(a.s * 1e4) / 1e4,
    pfLessBest: Math.round(pf * 100) / 100,
    t: sd > 0 ? (mean / sd) * Math.sqrt(a.n) : 0,
    halvesUp: a.nA >= 10 && a.nB >= 10 && a.sA > 0 && a.sB > 0,
  };
}
export const PASS = { minN: 20, minWin: 35, minAvg: 2, minPf: 1.1 };
export const RANK = { minN: 40, minPf: 1.1 };
const passes = (s: GStat) => s.n >= PASS.minN && s.winRate >= PASS.minWin && s.avgPct >= PASS.minAvg && s.pfLessBest >= PASS.minPf;

export type GRow = {
  key: string;
  filter: string;
  filterLabel: string;
  mode: string;
  modeLabel: string;
  exit: GExit;
  exitLabel: string;
  train: GStat;
  test: GStat;
  pass: boolean;
  senders: number; // migrated coins among its trades
  explore?: boolean; // v0.1.74: best on all calls, not ranked on train/test (only GRID LIVE judges it)
  seen?: { runs: number; ranked: number; passed: number }; // across earlier runs (gridHistory)
};
export const keyOf = (filter: string, mode: string, x: GExit) => `${filter}|${mode}|${x.initials}/${x.trail}/${x.stop}/${x.timeMin}/${x.mig}`;

/**
 * What the senders looked like at their call: of every migrated coin in the sample, how many the King called and how,
 * where the curve was, how long to migrate, and which rules were most over-represented among them (lift: how many times
 * more often a sender had the rule than an average call). The rules with the biggest lift are what to hunt.
 */
export function sendersStudy(cs: GCoin[], hit: boolean[][]) {
  const N = cs.length;
  const sIdx = cs.map((c, i) => (c.bonded ? i : -1)).filter((i) => i >= 0);
  const S = sIdx.length;
  const med = (a: number[]) => {
    const b = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
    return b.length ? b[Math.floor(b.length / 2)] : null;
  };
  const verdicts: Record<string, number> = {};
  for (const i of sIdx) verdicts[cs[i].verdict] = (verdicts[cs[i].verdict] || 0) + 1;
  const base = N ? S / N : 0;
  const lifts = PREDS.map((p, k) => {
    let n = 0, sn = 0;
    for (let i = 0; i < N; i++) if (hit[k][i]) (n++, cs[i].bonded && sn++);
    const rate = n ? sn / n : 0;
    return { id: p.id, label: p.label, calls: n, senders: sn, rate: Math.round(rate * 1000) / 10, lift: base > 0 ? Math.round((rate / base) * 100) / 100 : 0 };
  })
    .filter((x) => x.calls >= 30)
    .sort((a, b) => b.lift - a.lift);
  const fast = sIdx.filter((i) => (cs[i].bondSecs ?? Infinity) <= 3600).length;
  return {
    calls: N,
    senders: S,
    rate: Math.round(base * 1000) / 10,
    fast, // migrated within an hour of launch
    verdicts,
    medCurve: med(sIdx.map((i) => cs[i].progress)),
    medMinsToBond: (() => {
      const m = med(sIdx.map((i) => (cs[i].bondSecs != null ? (cs[i].createdAt + cs[i].bondSecs! * 1000 - cs[i].at) / 60_000 : NaN)));
      return m == null ? null : Math.round(m * 10) / 10;
    })(),
    lifts: lifts.slice(0, 8),
  };
}

/** The whole search. Coins: calls with their paths (any order). */
export async function runGrid(coins: GCoin[], opts: { top?: number; sol?: number } = {}) {
  // the worker's desk shares this thread: hand it the event loop between chunks of work
  const breathe = () => new Promise<void>((res) => setImmediate(res));
  const t0 = Date.now();
  const sol = opts.sol ?? GRID_SOL;
  const cost = sol + txCost(sol, COST) + ATA_RENT;
  const cs = coins.filter((c) => c.t.length >= 2).sort((a, b) => a.at - b.at);
  const N = cs.length;
  const cut = Math.floor(N * 0.7);
  const half = Math.floor(cut / 2);
  // every (mode, exit) outcome per coin, once: NaN = no trade
  const M = MODES.length;
  const X = GEXITS.length;
  const out: Float32Array[] = [];
  const entered = new Int32Array(M);
  for (let m = 0; m < M; m++) {
    await breathe();
    const js = cs.map((c) => entryIndex(c, MODES[m]));
    for (const j of js) if (j >= 0) entered[m]++;
    for (let x = 0; x < X; x++) {
      if (x % 6 === 0) await breathe();
      const a = new Float32Array(N).fill(NaN);
      if (MODES[m].kind === "mig" && GEXITS[x].mig === "sell") {
        out.push(a); // buying the migration only makes sense holding into the pool
        continue;
      }
      for (let i = 0; i < N; i++) {
        if (js[i] < 0) continue;
        const p = tradeFrom(cs[i], js[i], GEXITS[x], sol);
        if (p != null && Number.isFinite(p)) a[i] = p;
      }
      out.push(a);
    }
  }
  // filters: none, every rule, every pair of rules (as coin index lists)
  const hit = PREDS.map((p) => cs.map((c) => p.ok(c)));
  const filters: { id: string; label: string; idx: Int32Array }[] = [];
  const mk = (id: string, label: string, ok: (i: number) => boolean) => {
    const idx: number[] = [];
    for (let i = 0; i < N; i++) if (ok(i)) idx.push(i);
    if (idx.length >= 20) filters.push({ id, label, idx: Int32Array.from(idx) });
  };
  mk("all", "every call", () => true);
  for (let a = 0; a < PREDS.length; a++) mk(PREDS[a].id, PREDS[a].label, (i) => hit[a][i]);
  for (let a = 0; a < PREDS.length; a++) for (let b = a + 1; b < PREDS.length; b++) mk(`${PREDS[a].id}+${PREDS[b].id}`, `${PREDS[a].label} + ${PREDS[b].label}`, (i) => hit[a][i] && hit[b][i]);

  const stat = (o: Float32Array, idx: Int32Array, from: number, to: number) => {
    const a = acc0();
    for (const i of idx) {
      if (i < from || i >= to) continue;
      const p = o[i];
      if (p !== p) continue;
      a.n++;
      a.s += p;
      a.ss += p * p;
      if (p > 0) (a.w++, (a.gw += p));
      else a.gl -= p;
      if (p > a.best) a.best = p;
      if (i < half) (a.nA++, (a.sA += p));
      else (a.nB++, (a.sB += p));
    }
    return finish(a, cost);
  };
  type Cand = { f: number; m: number; x: number; tr: ReturnType<typeof stat> };
  const ranked: Cand[] = [];
  let tried = 0;
  let best: Cand | null = null; // the best train result of all, ranked or not (for the summary)
  for (let f = 0; f < filters.length; f++) {
    await breathe();
    for (let m = 0; m < M; m++) {
      for (let x = 0; x < X; x++) {
        tried++;
        const tr = stat(out[m * X + x], filters[f].idx, 0, cut);
        if (tr.n < RANK.minN) continue;
        if (!best || tr.t > best.tr.t) best = { f, m, x, tr };
        if (tr.avgPct > 0 && tr.pfLessBest >= RANK.minPf && tr.halvesUp) ranked.push({ f, m, x, tr });
      }
    }
  }
  ranked.sort((a, b) => b.tr.t - a.tr.t);
  // v0.1.74: EXPLORE. When nothing ranks (13-14 Oct: 0 of 56,448), GRID LIVE sat empty and no live evidence was
  // gathered at all. Explore rows are the best strategies on ALL calls (20+ trades, positive, PF 1+ without the best):
  // not proven by the train/test split, so they never count as passed here; GRID LIVE trades them in free slots and
  // its own 30-trip exam is the judge. Idle paper books gather nothing; an exploring book gathers evidence.
  const explorePool: Cand[] = [];
  for (let f = 0; f < filters.length; f++) {
    if (f % 20 === 0) await breathe();
    for (let m = 0; m < M; m++) {
      for (let x = 0; x < X; x++) {
        const al = stat(out[m * X + x], filters[f].idx, 0, N);
        if (al.n >= 20 && al.avgPct > 0 && al.pfLessBest >= 1) explorePool.push({ f, m, x, tr: al });
      }
    }
  }
  explorePool.sort((a, b) => b.tr.t - a.tr.t);
  // one row per filter + timing (its best exit), so the list is not 24 copies of one idea
  const seen = new Set<string>();
  const rows: GRow[] = [];
  const toRow = (c: Cand): GRow => {
    const te = stat(out[c.m * X + c.x], filters[c.f].idx, cut, N);
    const { t: _t, halvesUp: _h, ...train } = c.tr;
    const { t: _t2, halvesUp: _h2, ...test } = te;
    const o = out[c.m * X + c.x];
    let senders = 0;
    for (const i of filters[c.f].idx) if (o[i] === o[i] && cs[i].bonded) senders++;
    return { key: keyOf(filters[c.f].id, MODES[c.m].id, GEXITS[c.x]), filter: filters[c.f].id, filterLabel: filters[c.f].label, mode: MODES[c.m].id, modeLabel: MODES[c.m].label, exit: GEXITS[c.x], exitLabel: exitText(GEXITS[c.x]), train, test, pass: passes(test), senders };
  };
  for (const c of ranked) {
    // once per filter + timing, and once per identical set of trades (a pair that picks the same coins as a single
    // rule is the same strategy: the simpler one, ranked first on a tie, is kept)
    const k = `${c.f}:${c.m}`;
    const same = `${c.m}:${c.tr.n}:${c.tr.pnl}:${c.tr.wins}`;
    if (seen.has(k) || seen.has(same)) continue;
    seen.add(k);
    seen.add(same);
    rows.push(toRow(c));
    if (rows.length >= (opts.top ?? 25)) break;
  }
  const explore: GRow[] = [];
  const seenX = new Set<string>(rows.map((r) => `${r.filter}:${r.mode}`));
  for (const c of explorePool) {
    const k = `${filters[c.f].id}:${MODES[c.m].id}`;
    const same = `x${c.m}:${c.tr.n}:${c.tr.pnl}:${c.tr.wins}`;
    if (seenX.has(k) || seenX.has(same)) continue;
    seenX.add(k);
    seenX.add(same);
    const tr = stat(out[c.m * X + c.x], filters[c.f].idx, 0, cut);
    const r = toRow({ ...c, tr });
    explore.push({ ...r, pass: false, explore: true });
    if (explore.length >= 16) break;
  }
  // the honest baseline: every call, each timing, its best exit on train
  const base = MODES.map((_, m) => {
    let b: Cand | null = null;
    for (let x = 0; x < X; x++) {
      const tr = stat(out[m * X + x], filters[0].idx, 0, cut);
      if (tr.n >= 20 && (!b || tr.avgPct > b.tr.avgPct)) b = { f: 0, m, x, tr };
    }
    return b ? toRow(b) : null;
  }).filter((r): r is GRow => !!r);
  const passed = rows.filter((r) => r.pass);
  return {
    at: Date.now(),
    ms: Date.now() - t0,
    sol,
    coins: N,
    trainN: cut,
    testN: N - cut,
    from: cs[0]?.at ?? null,
    split: cs[cut]?.at ?? null,
    to: cs[N - 1]?.at ?? null,
    entered: MODES.map((m, i) => ({ mode: m.id, label: m.label, n: entered[i] })),
    pooled: cs.filter((c) => c.done.includes(2)).length, // v0.1.72: coins with pool prices after their migration
    tried,
    rankable: ranked.length,
    bestTrain: best ? toRow(best) : null,
    rows,
    explore,
    base,
    passed: passed.length,
    senders: sendersStudy(cs, hit),
    rules: { rank: RANK, pass: PASS },
  };
}
export type GridView = Awaited<ReturnType<typeof runGrid>>;

// ---- loading from the archive (worker)
const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Calls since v0.1.66 (when every call worth testing got the hour after it), with their paths. */
export async function loadGrid(pool: any, days = 14, max = 25_000): Promise<GCoin[]> {
  const since = await pool.query(`select min(opened_at) as at from trips where build >= '0.1.66'`).catch(() => ({ rows: [] }));
  const from = Math.max(Date.now() - days * 86400_000, since.rows[0]?.at ? new Date(since.rows[0].at).getTime() : 0);
  const ls = await pool.query(
    `select mint, symbol, created_at, outcome, bond_secs, data->'call' as call from launches
     where created_at > $1 and created_at < now() - interval '70 minutes' and data->'call' is not null
     order by created_at desc limit $2`,
    [new Date(from).toISOString(), max],
  );
  const coins = new Map<string, GCoin & { pre: { t: number; p: number }[]; tk: { t: number; mc: number; r: number; p: number; d: number }[] }>();
  for (const r of ls.rows) {
    const c = typeof r.call === "string" ? JSON.parse(r.call) : r.call;
    if (!c?.at || c.farm) continue;
    const tp = c.tp || {};
    const verdict = String(c.verdict || "DUST");
    const nanoV = c.nano?.verdict;
    const worth = (Number(c.progress) || 0) >= 4 || verdict !== "DUST" || (nanoV && nanoV !== "DUST") || (c.v1v && c.v1v !== "DUST");
    if (!worth) continue; // only these got the hour after the call (digger: followLonger)
    coins.set(r.mint, {
      mint: r.mint,
      symbol: r.symbol || "",
      at: Number(c.at),
      createdAt: new Date(r.created_at).getTime(),
      verdict,
      score: Number(c.score) || 0,
      nano: num(c.nano?.score),
      progress: Number(c.progress) || 0,
      rise60: 0,
      uniq: num(tp.uniq),
      spb: num(tp.spb),
      bs: num(tp.bs),
      sn: num(tp.sn),
      sm: Number(tp.sm) || 0,
      ds: !!tp.ds,
      soc: Number(c.soc) || 0,
      bonded: r.outcome === "BONDED",
      bondSecs: num(r.bond_secs),
      t: new Int32Array(0),
      mc: new Float32Array(0),
      real: new Float32Array(0),
      prog: new Float32Array(0),
      done: new Uint8Array(0),
      pre: [],
      tk: [],
    });
  }
  const mints = [...coins.keys()];
  for (let i = 0; i < mints.length; i += 1000) {
    const part = mints.slice(i, i + 1000);
    const ts = await pool.query(`select mint, at, progress, mc_sol, real_sol, complete, pool from ticks where mint = any($1) order by mint, at`, [part]);
    for (const t of ts.rows) {
      const c = coins.get(t.mint);
      if (!c) continue;
      const at = new Date(t.at).getTime();
      const p = Number(t.progress) || 0;
      if (at < c.at - 2_000) c.pre.push({ t: at, p });
      // the curve for the hour after the call; pool prices (after the migration) for up to 6 hours
      else if (at <= c.at + (t.pool ? HOLD_MS + 30 * 60_000 : PATH_MS)) c.tk.push({ t: at - c.at, mc: Number(t.mc_sol) || 0, r: Number(t.real_sol) || 0, p, d: t.pool ? 2 : t.complete ? 1 : 0 });
    }
  }
  const res: GCoin[] = [];
  for (const c of coins.values()) {
    if (c.tk.length < 2) continue;
    // curve speed: points gained since the last reading a minute or more before the call
    const old = c.pre.filter((x) => x.t <= c.at - 60_000).pop();
    c.rise60 = c.progress - (old ? old.p : 0);
    const n = c.tk.length;
    const g: GCoin = { ...c, t: new Int32Array(n), mc: new Float32Array(n), real: new Float32Array(n), prog: new Float32Array(n), done: new Uint8Array(n) };
    c.tk.forEach((x, k) => {
      g.t[k] = Math.max(0, x.t);
      g.mc[k] = x.mc;
      g.real[k] = x.r;
      g.prog[k] = x.p;
      g.done[k] = x.d;
    });
    delete (g as any).pre;
    delete (g as any).tk;
    res.push(g);
  }
  return res;
}

/** The Telegram note for a run with candidates (null: nothing passed). */
export function gridMessage(v: GridView): string | null {
  const ps = v.rows.filter((r) => r.pass);
  if (!ps.length) return null;
  const esc = (s: string) => s.replace(/[<>&]/g, " ");
  const lines = ps.slice(0, 5).map((r) => `• ${esc(r.filterLabel)}, ${esc(r.modeLabel)}\n  ${esc(r.exitLabel)}\n  test: ${r.test.n} trips, ${Math.round(r.test.winRate)}% won, avg ${r.test.avgPct >= 0 ? "+" : ""}${r.test.avgPct}%, PF ${r.test.pfLessBest}`);
  return `🧪 <b>GRID found ${ps.length} candidate${ps.length > 1 ? "s" : ""}</b>\nRanked on ${v.trainN} older calls, held up on ${v.testN} newer ones it never saw:\n\n${lines.join("\n\n")}\n\nNext: into ARENA, to prove it on live coins.`;
}

// ---- learning across runs: a strategy that holds up run after run is worth far more than one lucky run
export type GHist = { runs: number; keys: Record<string, { first: number; last: number; ranked: number; passed: number; label: string }> };
export function gridHistory(prev: GHist | null, v: GridView): GHist {
  const h: GHist = { runs: (prev?.runs ?? 0) + 1, keys: { ...(prev?.keys || {}) } };
  for (const r of v.rows) {
    const k = h.keys[r.key] || { first: h.runs, last: h.runs, ranked: 0, passed: 0, label: "" };
    k.ranked++;
    if (r.pass) k.passed++;
    k.last = h.runs;
    k.label = `${r.filterLabel}, buy ${r.modeLabel}`;
    h.keys[r.key] = k;
  }
  // forget what has not ranked in the last 20 runs (keeps the record small)
  for (const [k, x] of Object.entries(h.keys)) if (h.runs - x.last >= 20) delete h.keys[k];
  return h;
}
/** Put each row's record across runs on it. */
export function withSeen(v: GridView, h: GHist) {
  for (const r of v.rows) {
    const k = h.keys[r.key];
    if (k) r.seen = { runs: h.runs - k.first + 1, ranked: k.ranked, passed: k.passed };
  }
  return v;
}

/**
 * The strategies that go to the live GRID books (lib/gridlive.ts), best first: passed on the newest calls (most passes
 * across runs first), then those positive on the newest calls with 10+ trades, then the best on the older calls that the
 * newest could not judge yet. A strategy that lost on the newest calls never goes live. At most `max`.
 */
export function liveCandidates(v: GridView, max = 8): GRow[] {
  const cons = (r: GRow) => (r.seen?.passed ?? 0) * 2 + (r.seen?.ranked ?? 0);
  const passed = v.rows.filter((r) => r.pass).sort((a, b) => cons(b) - cons(a) || b.test.avgPct - a.test.avgPct);
  const hopeful = v.rows.filter((r) => !r.pass && r.test.n >= 10 && r.test.avgPct > 0 && r.test.pfLessBest >= 1).sort((a, b) => cons(b) - cons(a) || b.test.avgPct - a.test.avgPct);
  // free slots: the best on the older calls that the newest calls could not judge yet (under 10 test trades). Paper
  // costs nothing, and a live record is the fastest way to judge them
  const unjudged = v.rows.filter((r) => !r.pass && r.test.n < 10 && r.test.avgPct >= 0);
  // v0.1.74: then exploring strategies (best on all calls), so no slot sits idle
  const ex = (v.explore || []).filter((r) => !v.rows.some((x) => x.key === r.key));
  return [...passed, ...hopeful, ...unjudged, ...ex].slice(0, max);
}
