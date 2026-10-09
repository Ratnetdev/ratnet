"use client";
// v0.1.59: REPLAY. Every King call in the archive traded again under every entry rule and exit setting. The best exit
// per entry rule is picked on the older 70% of calls (train) and judged on the newest 30% (test), which it never saw.
import { usePoll } from "./usePoll";
import { ago } from "./fmt";
import { col, sgn } from "./TripDetail";

type S = { n: number; wins: number; winRate: number; avgPct: number; pnl: number; pfLessBest: number };
type R = { entry: string; label: string; signals: number; exit: string; train: S; test: S };
type V = { at: number | null; usable?: number; covered?: number; trainN?: number; testN?: number; from?: number | null; rows?: R[] };

const pf = (x: number) => (x >= 99 ? "no losses" : x.toFixed(2));

export default function ReplayBoard() {
  const d = usePoll<V>("/api/desk/replay", 120_000).data;
  if (!d || !d.at || !d.rows) return null;
  const thin = (d.covered ?? 0) < 60;
  return (
    <section className="panel mt" id="replay">
      <div className="ph">
        <span><b>replay</b> · {d.covered} King calls with their price path, traded again under every rule (0.1 SOL, the desk&apos;s costs)</span>
        <span className="tiny muted">run {ago(d.at)} ago</span>
      </div>
      {thin ? <div className="pb tiny muted">Still thin: the archive started on 9 Oct. Treat these as early signs until a few hundred calls are in.</div> : null}
      <div className="scroll">
        <table className="tbl rec-tbl">
          <thead>
            <tr><th>entry rule · best exit (picked on train)</th><th>train trips</th><th>train avg</th><th>test trips</th><th>test win</th><th>test avg</th><th>test PF*</th></tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.entry}>
                <td><b>{r.label}</b><div className="tiny mute2">{r.exit}</div></td>
                <td>{r.train.n}</td>
                <td style={{ color: col(r.train.avgPct) }}>{r.train.n ? `${sgn(r.train.avgPct)}%` : "–"}</td>
                <td>{r.test.n}</td>
                <td>{r.test.n ? `${Math.round(r.test.winRate)}%` : "–"}</td>
                <td style={{ color: col(r.test.avgPct) }}>{r.test.n ? `${sgn(r.test.avgPct)}%` : "–"}</td>
                <td>{r.test.n ? pf(r.test.pfLessBest) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pb tiny mute2">*profit factor without the best trade. Test = the newest 30% of calls, which the exit settings were not picked on. A rule that only looks good on train is overfit.</div>
    </section>
  );
}
