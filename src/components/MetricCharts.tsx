"use client";
// The charts behind the feed's stat cards: pick a metric and a range, hover for the numbers.
import { usePoll } from "./usePoll";
import Chart from "./Chart";

export type MetricKey = "dug" | "king" | "base" | "bonded";
type P = { t: number; dug: number; bonded: number; base: number | null; bondN: number; bondHit: number; king: number | null; nano: number | null };
type M = { range: string; bucket: "hour" | "day"; points: P[] };
const TITLE: Record<MetricKey, string> = { dug: "Launches dug", king: "King hit rate (BOND calls)", base: "Trench base rate", bonded: "Graduated" };

export default function MetricCharts({ metric, setMetric, range, setRange }: { metric: MetricKey; setMetric: (m: MetricKey) => void; range: "24h" | "72h" | "30d"; setRange: (r: "24h" | "72h" | "30d") => void }) {
  const d = usePoll<M>(`/api/metrics?range=${range}`, 60000).data;
  const pts = d?.points || [];
  const bucket = d?.bucket || "hour";
  const per = bucket === "day" ? "per day" : "per hour";
  const body = (() => {
    if (metric === "dug") return <Chart kind="bar" bucket={bucket} digits={0} series={[{ name: `launches ${per}`, color: "var(--rat)", points: pts.map((p) => ({ t: p.t, v: p.dug })) }]} />;
    if (metric === "bonded") return <Chart kind="bar" bucket={bucket} digits={0} series={[{ name: `graduations ${per}`, color: "var(--bond)", points: pts.map((p) => ({ t: p.t, v: p.bonded })) }]} />;
    if (metric === "base") return <Chart bucket={bucket} unit="%" digits={2} series={[{ name: "launches that graduated", color: "var(--rat)", points: pts.map((p) => ({ t: p.t, v: p.base })) }]} />;
    return (
      <Chart
        bucket={bucket}
        unit="%"
        series={[
          { name: "King BOND calls that bonded", color: "var(--bond)", points: pts.map((p) => ({ t: p.t, v: p.bondN ? p.king : null })) },
          { name: "base rate (any launch)", color: "var(--dim)", dashed: true, points: pts.map((p) => ({ t: p.t, v: p.base })) },
        ]}
      />
    );
  })();
  return (
    <section className="panel mt">
      <div className="ph mchart-bar">
        <span><b>{TITLE[metric]}</b> · {per}</span>
        <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className="seg">
            {(Object.keys(TITLE) as MetricKey[]).map((k) => (
              <button key={k} className={metric === k ? "on" : ""} onClick={() => setMetric(k)}>{k === "dug" ? "dug" : k === "king" ? "King hit" : k === "base" ? "base rate" : "graduated"}</button>
            ))}
          </span>
          <span className="seg">
            {(["24h", "72h", "30d"] as const).map((r) => (
              <button key={r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}</button>
            ))}
          </span>
        </span>
      </div>
      <div className="pb">
        {body}
        <div className="mchart-note">By launch time. {metric === "king" || metric === "base" ? "The newest buckets keep rising as their coins resolve (a call counts as a miss until it bonds)." : "Hover a bar for the exact number."}</div>
      </div>
    </section>
  );
}
