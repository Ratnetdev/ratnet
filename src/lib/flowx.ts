// v0.1.105: the EXIT FLOWS record (GRID LIVE, lib/gridlive.ts): on the same paper trips, the actual result vs selling
// when the flow turned. Its own small module so the review page does not load GRID LIVE.
export type FlowX = { k: string; mint: string; at: number; act: number; flag: number; why: string };
export function flowxStats(xs: FlowX[]) {
  const n = xs.length;
  const avg = (f: (x: FlowX) => number) => (n ? Math.round((xs.reduce((a, x) => a + f(x), 0) / n) * 10) / 10 : null);
  return { n, actAvg: avg((x) => x.act), flagAvg: avg((x) => x.flag), flagBetter: xs.filter((x) => x.flag > x.act).length, byWhy: { e20: xs.filter((x) => x.why === "e20").length, kol: xs.filter((x) => x.why === "kol").length } };
}
