"use client";
// The charts behind the track record's numbers: equity over time, realized P&L trade by trade, the rolling win rate,
// every trade's result and how long each was held.
import { usePoll } from "./usePoll";
import Chart from "./Chart";
import type { Trip } from "./TripDetail";

export type RecKey = "return" | "realized" | "winrate" | "trades" | "hold";
const TITLE: Record<RecKey, string> = { return: "Equity", realized: "Realized P&L, trade by trade", winrate: "Win rate, last 10 trades", trades: "Every closed trade", hold: "Hold time per trade" };

export default function RecordCharts({ which, setWhich, trips, start }: { which: RecKey; setWhich: (k: RecKey) => void; trips: Trip[]; start: number }) {
  const eq = usePoll<{ points: { t: number; eq: number }[] }>(which === "return" ? "/api/desk/equity" : null, 30000).data;
  const closed = trips.filter((t) => !t.open && t.closedAt).sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  const label = (i: number) => (closed[i] ? `#${i + 1} $${closed[i].symbol}` : "");
  const body = (() => {
    if (which === "return") {
      const pts = (eq?.points || []).map((p) => ({ t: p.t, v: start ? Math.round((p.eq / start - 1) * 1000) / 10 : null }));
      return <Chart bucket="minute" unit="%" zeroBase={false} series={[{ name: "return since start", color: "var(--rat)", points: pts }]} empty="The equity line starts with the first minute of the desk." />;
    }
    if (which === "realized") {
      let cum = 0;
      const pts = closed.map((t) => ({ t: t.closedAt!, v: Math.round((cum += t.pnlSol) * 10000) / 10000 }));
      return <Chart unit=" ◎" digits={3} zeroBase={false} xLabel={label} series={[{ name: "realized, cumulative", color: "var(--rat)", points: pts }]} empty="No closed trades yet." />;
    }
    if (which === "winrate") {
      const pts = closed.map((t, i) => {
        const w = closed.slice(Math.max(0, i - 9), i + 1);
        return { t: t.closedAt!, v: Math.round((w.filter((x) => x.pnlSol > 0).length / w.length) * 1000) / 10 };
      });
      return <Chart unit="%" digits={0} xLabel={label} series={[{ name: "win rate, last 10", color: "var(--bond)", points: pts }, { name: "exam bar (40%)", color: "var(--dim)", dashed: true, points: pts.map((p) => ({ t: p.t, v: 40 })) }]} empty="No closed trades yet." />;
    }
    if (which === "hold") return <Chart kind="bar" unit="m" digits={0} xLabel={label} series={[{ name: "minutes held", color: "var(--watch)", points: closed.map((t) => ({ t: t.closedAt!, v: Math.round(t.holdMs / 60000) })) }]} empty="No closed trades yet." />;
    return <Chart kind="bar" polar unit="%" xLabel={label} series={[{ name: "result", color: "var(--rat)", points: closed.map((t) => ({ t: t.closedAt!, v: Math.round(t.pnlPct * 10) / 10 })) }]} empty="No closed trades yet." />;
  })();
  return (
    <div className="pb rec-chart">
      <div className="mchart-bar" style={{ marginBottom: 10 }}>
        <b className="small">{TITLE[which]}</b>
        <span className="seg">
          {(Object.keys(TITLE) as RecKey[]).map((k) => (
            <button key={k} className={which === k ? "on" : ""} onClick={() => setWhich(k)}>{k === "return" ? "equity" : k === "winrate" ? "win rate" : k}</button>
          ))}
        </span>
      </div>
      {body}
    </div>
  );
}
