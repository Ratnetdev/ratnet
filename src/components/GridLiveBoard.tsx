"use client";
// v0.1.71: GRID LIVE. GRID's best strategies trading on live coins (paper), each exactly as GRID tested it.
import { usePoll } from "./usePoll";
import { ago } from "./fmt";
import { col, sgn } from "./TripDetail";

type L = { n: number; wins: number; winRate: number; avgPct: number; pnl: number; pfLessBest: number; passed: boolean };
type Book = { key: string; label: string; exitLabel: string; since: number; grid: { testN: number; testAvg: number; pass: boolean }; open: { mint: string; symbol: string; pnlPct: number }[]; watching: number; live: L };
type Trip = { k: string; mint: string; symbol: string; closedAt: number; pnlPct: number; why: string };
type V = { at: number | null; books?: Book[]; recent?: Trip[]; trips?: number };

const pf = (x: number) => (x >= 99 ? "no losses" : x.toFixed(2));

export default function GridLiveBoard() {
  const d = usePoll<V>("/api/desk/gridlive", 30_000).data;
  if (!d || !d.at) return null;
  const books = d.books || [];
  return (
    <section className="panel mt" id="gridlive">
      <div className="ph">
        <span><b>grid live</b> · GRID&apos;s best strategies trading live coins on paper, exactly as tested</span>
        <span className="tiny muted">{ago(d.at)} ago</span>
      </div>
      {!books.length ? (
        <div className="pb muted small">No strategies yet. The books fill after each GRID run (every 3 hours) with the ones that held up on the newest calls.</div>
      ) : (
        <div className="scroll">
          <table className="tbl rec-tbl">
            <thead>
              <tr><th>strategy</th><th>live trips</th><th>won</th><th>avg</th><th>PF*</th><th>open</th><th>GRID test</th></tr>
            </thead>
            <tbody>
              {books.map((b) => (
                <tr key={b.key}>
                  <td style={{ whiteSpace: "normal", maxWidth: 420 }}>
                    {b.live.passed ? <span className="tag" style={{ color: "var(--rat)", marginRight: 6 }}>PASSED</span> : null}
                    <b>{b.label}</b>
                    <div className="tiny mute2">{b.exitLabel} · live since {ago(b.since)} ago{b.watching ? ` · watching ${b.watching}` : ""}</div>
                  </td>
                  <td>{b.live.n}/30</td>
                  <td>{b.live.n ? `${b.live.winRate}%` : "–"}</td>
                  <td style={{ color: col(b.live.avgPct) }}>{b.live.n ? `${sgn(b.live.avgPct)}%` : "–"}</td>
                  <td>{b.live.n ? pf(b.live.pfLessBest) : "–"}</td>
                  <td>{b.open.length ? b.open.map((o) => <div key={o.mint} className="tiny" style={{ color: col(o.pnlPct) }}>{o.symbol} {sgn(o.pnlPct)}%</div>) : "–"}</td>
                  <td className="tiny">{b.grid.testN} trips, <span style={{ color: col(b.grid.testAvg) }}>{sgn(b.grid.testAvg)}%</span>{b.grid.pass ? " · passed" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.recent?.length ? (
        <div className="pb tiny">
          <span className="muted">latest: </span>
          {d.recent.slice(0, 8).map((t) => (
            <span key={`${t.k}${t.mint}${t.closedAt}`} style={{ marginRight: 10, color: col(t.pnlPct) }}>{t.symbol} {sgn(t.pnlPct)}% ({t.why})</span>
          ))}
        </div>
      ) : null}
      <div className="pb tiny mute2">*profit factor without the best trade, last 30 trips. Passing = the desk&apos;s exam: 30 trips, 40%+ won, +10% on a 1 SOL desk at 0.05 SOL a trade, PF 1.2+. A pass goes to Telegram, and the desk trades it next.</div>
    </section>
  );
}
