"use client";
// v0.1.55: results per build, from the archive. Every trip is tagged with the build that opened it, so a push that
// helped or hurt shows here instead of being guessed from the overall record.
import { usePoll } from "./usePoll";
import { ago } from "./fmt";
import { col, sgn } from "./TripDetail";

type Row = { book: string; build: string; n: number; wins: number; pnl: number; staked: number; avg_pct: number | null; last: string };
type Board = { at: number | null; rows: Row[]; sizes: { launches: number; ticks: number; trades: number; trips: number } | null };
const BOOK: Record<string, string> = { paper: "paper", live: "live", ghost: "ghost" };

export default function BuildBoard() {
  const d = usePoll<Board>("/api/desk/builds", 60_000).data;
  if (!d || !d.at) return null; // nothing until the archive is connected
  const rows = d.rows || [];
  return (
    <section className="panel mt">
      <div className="ph">
        <span><b>results by build</b> · last 30 days, by the build that opened each trade</span>
        <span className="tiny muted">archive {d.sizes ? `${d.sizes.launches.toLocaleString("en-US")} launches · ${d.sizes.trips.toLocaleString("en-US")} trips` : ""} · {ago(d.at)} ago</span>
      </div>
      {rows.length ? (
        <div className="scroll">
          <table className="tbl rec-tbl">
            <thead>
              <tr><th>build</th><th>book</th><th>trips</th><th>win rate</th><th>avg</th><th>P&amp;L</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.book}${r.build}`}>
                  <td>{r.build}</td>
                  <td className="muted">{BOOK[r.book] || r.book}</td>
                  <td>{r.n}</td>
                  <td>{r.n ? `${Math.round((r.wins / r.n) * 100)}%` : "–"}</td>
                  <td style={{ color: col(r.avg_pct ?? 0) }}>{r.avg_pct != null ? `${sgn(r.avg_pct)}%` : "–"}</td>
                  <td style={{ color: col(r.pnl) }}>{sgn(r.pnl, 3)} ◎</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="pb muted small">No closed trips in the archive yet. Every trip from now on is tagged with its build.</div>
      )}
    </section>
  );
}
