// v0.1.130 CLASS GATE. The live desk only buys in market-cap classes that make money live.
//
// 19 Oct 15:00 to 20 Oct 05:00, 140 live trades, -0.87 SOL. By market cap at the buy:
//   under 5 SOL ($500)       72 trades  -0.44 SOL
//   5 to 27 SOL              9 trades  -0.06 SOL   2 won
//   27 to 31.5 SOL (launch)   19 trades  -0.12 SOL   0 won
//   31.5 to 96 SOL            28 trades  -0.28 SOL   5 won
//   96 SOL+ ($10K+)           12 trades  +0.03 SOL   5 won
// A class whose own live record (last 7 days, 8+ trades) is negative is off for live buys. Paper keeps trading every
// class, so a class comes back on by itself once the strategies the desk follows (books that passed) make 5%+ a trade
// in it on paper after costs, over their last 30+ trades there, with the desk's own take-profit steps.

export type Cls = "sub" | "low" | "launch" | "early" | "up";
export const CLASSES: { id: Cls; lo: number; hi: number; label: string }[] = [
  { id: "sub", lo: 0, hi: 5, label: "under 5 SOL" },
  { id: "low", lo: 5, hi: 27, label: "5 to 27 SOL" },
  { id: "launch", lo: 27, hi: 31.5, label: "launch price (27 to 31.5 SOL)" },
  { id: "early", lo: 31.5, hi: 96, label: "31.5 to 96 SOL" },
  { id: "up", lo: 96, hi: Infinity, label: "96 SOL+" },
];
export const classOf = (mcSol: number): Cls => CLASSES.find((c) => mcSol >= c.lo && mcSol < c.hi)?.id ?? "up";
export const classLabel = (c: Cls) => CLASSES.find((x) => x.id === c)?.label ?? c;

export const GATE = { liveN: 8, liveDays: 7, paperN: 30, paperLast: 60, paperMin: 0.05, cost: 0.06 };
export type LiveCls = { c: Cls; pnl: number; at: number };
let LIVE: LiveCls[] = [];
type PaperT = { mc0?: number; sh?: Record<string, number>; closedAt: number };
let PAPER: (() => PaperT[]) | null = null;
let PCACHE: { at: number; by: Record<string, number[]> } = { at: 0, by: {} };
export const gateStats = { skips: 0, last: "" };

export const setClassPaper = (f: () => PaperT[]) => ((PAPER = f), (PCACHE.at = 0));
export function noteLiveClass(mcSol: number, pnl: number, at = Date.now()): LiveCls {
  const x = { c: classOf(mcSol), pnl, at };
  LIVE = [x, ...LIVE].slice(0, 2000);
  return x;
}
export const loadLiveClass = (xs: LiveCls[]) => (LIVE = [...(xs || [])].filter((x) => x && x.c).sort((a, z) => z.at - a.at).slice(0, 2000));

function paperBy(now: number) {
  if (now - PCACHE.at < 60_000) return PCACHE.by;
  const by: Record<string, number[]> = {};
  const ts = (PAPER ? PAPER() : []).filter((t) => t.mc0 != null && typeof t.sh?.desk === "number").sort((a, z) => z.closedAt - a.closedAt);
  for (const t of ts) {
    const c = classOf(t.mc0!);
    const a = (by[c] ||= []);
    if (a.length < GATE.paperLast) a.push(t.sh!.desk - 1 - GATE.cost);
  }
  PCACHE = { at: now, by };
  return by;
}

export function classGate(c: Cls, now = Date.now()) {
  const lv = LIVE.filter((x) => x.c === c && now - x.at <= GATE.liveDays * 86_400_000);
  const live = { n: lv.length, pnl: Math.round(lv.reduce((s, x) => s + x.pnl, 0) * 1e4) / 1e4 };
  const pv = paperBy(now)[c] || [];
  const paper = { n: pv.length, avg: pv.length ? Math.round((pv.reduce((s, x) => s + x, 0) / pv.length) * 1000) / 10 : null };
  const losing = live.n >= GATE.liveN && live.pnl < 0;
  const back = paper.n >= GATE.paperN && (paper.avg ?? -1) >= GATE.paperMin * 100;
  const on = !losing || back;
  const why = !losing ? `live ${live.n} trades ${live.pnl >= 0 ? "+" : ""}${live.pnl} SOL` : back ? `live ${live.pnl} SOL on ${live.n}, but paper makes ${paper.avg}% a trade again on ${paper.n}` : `${classLabel(c)} lost ${live.pnl} SOL live on ${live.n} trades (paper ${paper.avg ?? "-"}% on ${paper.n})`;
  return { c, on, why, live, paper };
}
export const gateView = (now = Date.now()) => CLASSES.map((c) => ({ ...classGate(c.id, now), label: c.label }));
export const _gateReset = () => ((LIVE = []), (PAPER = null), (PCACHE = { at: 0, by: {} }), (gateStats.skips = 0));
