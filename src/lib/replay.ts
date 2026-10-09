// REPLAY (v0.1.59, roadmap step 6): test entry and exit rules on the archived history in minutes instead of waiting
// days of live paper trades. Every King call the archive holds, with the curve path of the hour after it (one snapshot
// per 10 seconds), is traded again under every combination of entry rule and exit settings, with the desk's costs
// (0.1 SOL a trade, venue fee, slippage on the curve, tip and priority fee, account rent).
//
// Against fooling ourselves: calls are split by time. The best settings are picked on the older 70% ("train") and
// reported on the newest 30% ("test"), which they never saw. A setting that only shines on train is overfit.
// Limits: curve coins only (a coin that migrates is sold at the migration price), entry checks limited to what the call
// itself records (verdict, scores, curve, farm flag, bundle share).
import { SITE } from "@/config/site";
import { ATA_RENT, sellProceeds, slipOf, txCost, venueFee, type CostCfg } from "./costs";

export type Tick = { at: number; progress: number; mcSol: number; realSol: number; complete: boolean };
export type CallRow = { mint: string; symbol: string; at: number; score: number; verdict: string; nanoScore: number | null; nanoVerdict: string | null; progress: number; farm: boolean; bundle: number | null; ticks: Tick[] };

export type Entry = { id: string; label: string; take: (c: CallRow) => boolean };
const D = (SITE as any).desk || {};
const MIN_CURVE = Number(D.minCurve ?? 10);
const MAX_CURVE = Number(D.maxCurve ?? 70);
export const ENTRIES: Entry[] = [
  { id: "desk", label: "desk rules (King BOND, nano BOND, curve window)", take: (c) => c.verdict === "BOND" && c.nanoVerdict === "BOND" && c.progress >= MIN_CURVE && c.progress <= MAX_CURVE },
  { id: "king", label: "King BOND, no nano rule", take: (c) => c.verdict === "BOND" && c.progress >= MIN_CURVE && c.progress <= MAX_CURVE },
  { id: "king_any", label: "King BOND, any curve", take: (c) => c.verdict === "BOND" && c.progress >= MIN_CURVE },
  { id: "strict", label: "King 70+ and nano 60+", take: (c) => c.score >= 70 && (c.nanoScore ?? 0) >= 60 && c.progress >= MIN_CURVE && c.progress <= MAX_CURVE },
  { id: "nano", label: "nano BOND, any King verdict", take: (c) => c.nanoVerdict === "BOND" && c.progress >= MIN_CURVE && c.progress <= MAX_CURVE },
  { id: "king60", label: "King 60+, any verdict", take: (c) => c.score >= 60 && c.progress >= MIN_CURVE && c.progress <= MAX_CURVE },
];
export type Exit = { initials: number; trail: number; stop: number; timeMin: number };
export const EXITS: Exit[] = [];
for (const initials of [1.4, 2]) for (const trail of [0.25, 0.4]) for (const stop of [0.25, 0.4]) for (const timeMin of [15, 45]) EXITS.push({ initials, trail, stop, timeMin });
const exitLabel = (x: Exit) => `initials ${x.initials}x, trail ${Math.round(x.trail * 100)}%, stop ${Math.round(x.stop * 100)}%, time ${x.timeMin}m`;

const SOL = 0.1;
const COST: CostCfg = { jitoTipMinSol: D.jitoTipMinSol, jitoTipMaxSol: D.jitoTipMaxSol, paperPrioritySol: D.paperPrioritySol };
const pxOf = (t: Tick) => t.mcSol / 1e9;

/** One trade: buy at the first snapshot at or after the call, then the exit rules on the path. null: no usable path. */
export function simulate(c: CallRow, x: Exit): { pnl: number; pct: number; why: string } | null {
  const path = c.ticks.filter((t) => t.at >= c.at - 2_000).sort((a, b) => a.at - b.at);
  if (path.length < 2 || path[0].at - c.at > 30_000) return null; // no price within 30s of the call: not replayable
  const t0 = path[0];
  const px0 = pxOf(t0);
  if (!(px0 > 0) || t0.complete) return null;
  const fillPx = px0 * (1 + slipOf(SOL, false, t0.realSol));
  const tokens0 = (SOL * (1 - venueFee(false, px0 * 1e9))) / fillPx;
  const cost = SOL + txCost(SOL, COST) + ATA_RENT;
  let tokens = tokens0;
  let back = 0;
  let peak = px0;
  let initials = false;
  let why = "end of path";
  const sell = (frac: number, px: number, real: number) => {
    const amt = frac >= 1 ? tokens : tokens * frac;
    back += sellProceeds(amt, px, false, real, COST, frac >= 1);
    tokens -= amt;
  };
  for (const t of path.slice(1)) {
    const px = pxOf(t);
    if (!(px > 0)) continue;
    if (t.complete) {
      sell(1, px, t.realSol);
      why = "migrated";
      break;
    }
    peak = Math.max(peak, px);
    const x0 = px / fillPx;
    if (!initials && x0 >= x.initials) {
      sell(0.5, px, t.realSol);
      initials = true;
      continue;
    }
    if (x0 <= 1 - x.stop) {
      sell(1, px, t.realSol);
      why = "stop";
      break;
    }
    if (initials && px <= peak * (1 - x.trail)) {
      sell(1, px, t.realSol);
      why = "trail";
      break;
    }
    if (t.at - t0.at >= x.timeMin * 60_000 && (!initials || x0 < 1.1)) {
      sell(1, px, t.realSol);
      why = "time";
      break;
    }
  }
  if (tokens > 1e-9) {
    const last = path[path.length - 1];
    sell(1, pxOf(last), last.realSol);
  }
  const pnl = back - cost;
  return { pnl, pct: (pnl / cost) * 100, why };
}

export type Stat = { n: number; wins: number; winRate: number; avgPct: number; pnl: number; pfLessBest: number };
export function stats(rs: { pnl: number; pct: number }[]): Stat {
  const n = rs.length;
  const wins = rs.filter((r) => r.pnl > 0).length;
  const pnls = rs.map((r) => r.pnl);
  const less = pnls.slice();
  if (less.length) less.splice(less.indexOf(Math.max(...less)), 1);
  const gw = less.filter((x) => x > 0).reduce((a, x) => a + x, 0);
  const gl = -less.filter((x) => x < 0).reduce((a, x) => a + x, 0);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return { n, wins, winRate: n ? r1((wins / n) * 100) : 0, avgPct: n ? r1(rs.reduce((a, r) => a + r.pct, 0) / n) : 0, pnl: Math.round(pnls.reduce((a, x) => a + x, 0) * 1e4) / 1e4, pfLessBest: gl > 0 ? Math.round((gw / gl) * 100) / 100 : gw > 0 ? 99 : 0 };
}

/** Every entry rule x every exit setting; best settings per entry chosen on train, reported on test. */
export function runReplay(calls: CallRow[]) {
  const usable = calls.filter((c) => !c.farm && !(c.bundle != null && c.bundle > 0.6)).sort((a, b) => a.at - b.at);
  const cut = Math.floor(usable.length * 0.7);
  const train = usable.slice(0, cut);
  const test = usable.slice(cut);
  const rows = ENTRIES.map((e) => {
    const tr = train.filter(e.take);
    const te = test.filter(e.take);
    const grid = EXITS.map((x) => {
      const a = tr.map((c) => simulate(c, x)).filter((r): r is NonNullable<typeof r> => !!r);
      return { x, train: stats(a) };
    });
    // the best exit on train: profit factor without the best trade first (robust to one lucky coin), then P&L
    const best = grid.filter((g) => g.train.n >= 5).sort((a, b) => b.train.pfLessBest - a.train.pfLessBest || b.train.pnl - a.train.pnl)[0] || grid[0];
    const bt = te.map((c) => simulate(c, best.x)).filter((r): r is NonNullable<typeof r> => !!r);
    return { entry: e.id, label: e.label, signals: tr.length + te.length, exit: exitLabel(best.x), exitCfg: best.x, train: best.train, test: stats(bt) };
  });
  const covered = usable.filter((c) => simulate(c, EXITS[0]) != null).length;
  return { at: Date.now(), calls: calls.length, usable: usable.length, covered, from: usable[0]?.at ?? null, to: usable[usable.length - 1]?.at ?? null, trainN: train.length, testN: test.length, rows };
}

/** Read the calls and their paths from the archive (worker). */
export async function loadCalls(pool: any, days = 14): Promise<CallRow[]> {
  const ls = await pool.query(
    `select mint, symbol, data from launches where call_score is not null and created_at > now() - ($1 || ' days')::interval and created_at < now() - interval '70 minutes' and data is not null limit 5000`,
    [String(days)],
  );
  const calls: CallRow[] = [];
  for (const r of ls.rows) {
    const d = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
    const c = d?.call;
    if (!c?.at) continue;
    calls.push({ mint: r.mint, symbol: r.symbol, at: Number(c.at), score: Number(c.score) || 0, verdict: c.verdict, nanoScore: c.nano?.score ?? null, nanoVerdict: c.nano?.verdict ?? null, progress: Number(c.progress) || 0, farm: !!c.farm, bundle: d?.tape?.bundleShare ?? null, ticks: [] });
  }
  if (!calls.length) return calls;
  const by = new Map(calls.map((c) => [c.mint, c]));
  const ts = await pool.query(`select mint, at, progress, mc_sol, real_sol, complete from ticks where mint = any($1) order by mint, at`, [calls.map((c) => c.mint)]);
  for (const t of ts.rows) {
    const c = by.get(t.mint);
    const at = new Date(t.at).getTime();
    if (c && at >= c.at - 2_000 && at <= c.at + 62 * 60_000) c.ticks.push({ at, progress: Number(t.progress), mcSol: Number(t.mc_sol), realSol: Number(t.real_sol), complete: !!t.complete });
  }
  return calls;
}
