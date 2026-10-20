// v0.1.138 PROOF BOARD: what the live desk did against its own paper twin, how fast it fills, and how the King's
// calls are graded. Everything here is read from the records the desk and the rats already keep.
import { redis } from "./redis";
import { FILLS_LOG, type FillRec } from "./desk";
import type { LivePair } from "./gridlive";

const med = (xs: number[]) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, z) => x - z);
  return a[Math.floor(a.length / 2)];
};
const q = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, z) => x - z);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
};

/** Fill ledger summary: signal to landed and the fill against the signal price, overall and by path. */
export function fillSummary(fs: FillRec[]) {
  const live = fs.filter((f) => f.live);
  const xs = live.length ? live : fs;
  const by = (path: string) => {
    const a = xs.filter((f) => f.path === path);
    return { n: a.length, ms: med(a.map((f) => f.total)), slip: med(a.map((f) => f.slip).filter((v): v is number => v != null)) };
  };
  return {
    n: xs.length,
    live: live.length,
    ms: med(xs.map((f) => f.total)),
    p90: q(xs.map((f) => f.total), 0.9),
    wait: med(xs.map((f) => f.wait)),
    prep: med(xs.map((f) => f.prep)),
    land: med(xs.map((f) => f.land)),
    slip: med(xs.map((f) => f.slip).filter((v): v is number => v != null)),
    early: xs.filter((f) => f.early).length,
    fast: by("fast"),
    beat: by("beat"),
  };
}

/** One row per live trade (an older trade paired with several books shows their average paper result). */
export function pairRows(ps: LivePair[], n = 40) {
  const by = new Map<string, LivePair[]>();
  for (const p of ps) (by.get(`${p.mint}|${p.at}`) || by.set(`${p.mint}|${p.at}`, []).get(`${p.mint}|${p.at}`)!).push(p);
  return [...by.values()]
    .map((a) => {
      const paper = Math.round((a.reduce((s, p) => s + p.paper, 0) / a.length) * 10) / 10;
      return { mint: a[0].mint, sym: a[0].sym ?? null, at: a[0].at, live: a[0].live, paper, gap: Math.round((a[0].live - paper) * 10) / 10, exact: a.some((p) => p.exact), books: a.length };
    })
    .sort((x, z) => z.at - x.at)
    .slice(0, n);
}

export async function proofView() {
  const r = redis();
  const { getRecord } = await import("./desk");
  const { getStats } = await import("./stats");
  const [pairs, fills, gv, stats, rec] = await Promise.all([
    r.get<LivePair[]>("rn:grid:pairs").catch(() => null),
    r.lrange<FillRec>(FILLS_LOG, 0, 199).catch(() => [] as FillRec[]),
    r.get<any>("rn:gridlive:view").catch(() => null),
    getStats().catch(() => null as any),
    getRecord(undefined, "real").catch(() => null as any),
  ]);
  const s = rec?.summary || {};
  return {
    at: Date.now(),
    desk: { live: !!rec?.live, start: s.start ?? null, equity: s.equity ?? null, returnPct: s.returnPct ?? null, sessionPct: s.sessionPct ?? null, trips: s.closed ?? s.trips ?? null, winRate: s.winRate ?? null },
    gap: gv?.realGap ?? null,
    pairs: pairRows(pairs || []),
    fills: fillSummary(fills || []),
    recentFills: (fills || []).slice(0, 15).map((f) => ({ at: f.at, mint: f.mint, symbol: f.symbol, path: f.path, early: f.early, total: f.total, slip: f.slip })),
    grid: gv ? { books: gv.books?.length ?? 0, passed: (gv.books || []).filter((b: any) => b.live?.passed).length, trips: gv.trips ?? null, keep: gv.keep ?? null, bags: gv.bags ? { n: gv.bags.n, best: gv.bags.best, live: gv.bags.live, desk: gv.bags.desk, rows: gv.bags.rows } : null, ladder: gv.ladder?.all ? { n: gv.ladder.all.n, best: gv.ladder.all.best, rows: gv.ladder.all.rows } : null } : null,
    king: stats ? { dug: stats.dug, resolved: stats.resolved, baseRate: stats.baseRate, bond: stats.bond ? { n: stats.bond.res ?? stats.bond.n, hit: stats.bond.hit, rate: stats.bond.rate } : null } : null,
  };
}
