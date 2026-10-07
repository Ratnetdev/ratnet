// Time series for the charts behind the feed's stat cards: launches dug, graduations, the base rate and the King's
// BOND hit rate, per hour (last 24h or 72h) or per day (last 30 days). Rates are by launch time: the newest buckets
// keep rising as their coins resolve.
import { K, redis } from "./redis";

export type MPoint = { t: number; dug: number; bonded: number; base: number | null; bondN: number; bondHit: number; king: number | null; nanoN: number; nanoHit: number; nano: number | null };
const rate = (h: number, n: number) => (n ? Math.round((h / n) * 1000) / 10 : null);

function row(t: number, x: Record<string, unknown> | null): MPoint {
  const g = (k: string) => Number((x as any)?.[k] || 0);
  const d = g("d");
  const b = g("b");
  return { t, dug: d, bonded: b, base: rate(b, d), bondN: g("bn"), bondHit: g("bh"), king: rate(g("bh"), g("bn")), nanoN: g("nbn"), nanoHit: g("nbh"), nano: rate(g("nbh"), g("nbn")) };
}

export async function metrics(range: "24h" | "72h" | "30d") {
  const r = redis();
  const now = Date.now();
  const p = r.pipeline();
  let ts: number[];
  if (range === "30d") {
    const d0 = Math.floor(now / 86400_000) * 86400_000;
    ts = Array.from({ length: 30 }, (_, i) => d0 - (29 - i) * 86400_000);
    for (const t of ts) p.hgetall(`rn:dayh:${new Date(t).toISOString().slice(0, 10)}`);
  } else {
    const n = range === "72h" ? 72 : 24;
    const h0 = Math.floor(now / 3600_000) * 3600_000;
    ts = Array.from({ length: n }, (_, i) => h0 - (n - 1 - i) * 3600_000);
    for (const t of ts) p.hgetall(K.hr(new Date(t).toISOString().slice(0, 13)));
  }
  const rows = (await p.exec()) as (Record<string, unknown> | null)[];
  const points = ts.map((t, i) => row(t, rows[i]));
  // days before the per-day counters existed: fill dug and bonded from the older daily totals
  if (range === "30d") {
    const q = r.pipeline();
    for (const t of ts) q.hgetall(K.day(new Date(t).toISOString().slice(0, 10)));
    const old = (await q.exec()) as (Record<string, unknown> | null)[];
    points.forEach((pt, i) => {
      if (!pt.dug && old[i]) {
        pt.dug = Number((old[i] as any).dug || 0);
        pt.bonded = Number((old[i] as any).bonded || 0);
        pt.base = rate(pt.bonded, pt.dug);
      }
    });
  }
  // trim leading empty buckets (before the rats started)
  const first = points.findIndex((x) => x.dug > 0 || x.bondN > 0);
  return { range, bucket: range === "30d" ? "day" : "hour", points: first > 0 ? points.slice(first) : points };
}
