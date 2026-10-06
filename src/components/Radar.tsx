"use client";
import { CoinLink, ScoreBar, VerdictTag } from "./Calls";
import { ago, num } from "./fmt";

export type RadarRow = {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  createdAt: number;
  pNow: number;
  peak: number;
  mcapNow: number;
  devN: number;
  devB: number;
  socials: number;
  call: { score: number; verdict: string; nano: { score: number; verdict: string } | null } | null;
};

export function CurveBar({ p }: { p: number }) {
  const cls = p >= 85 ? "bond" : p >= 40 ? "watch" : "";
  return (
    <span className="row" style={{ gap: 8 }}>
      <span className={`bar ${cls}`} style={{ display: "inline-block", width: 90 }}>
        <i style={{ width: `${Math.max(2, p)}%` }} />
      </span>
      <span style={{ width: 40 }}>{p}%</span>
    </span>
  );
}

export function DevTag({ n, b }: { n: number; b: number }) {
  if (!n) return <span className="tiny green">fresh dev</span>;
  const bad = n >= 5 && b === 0;
  return (
    <span className="tiny" style={{ color: bad ? "var(--dust)" : b > 0 ? "var(--bond)" : "var(--dim)" }}>
      {n} prior · {b} bonded
    </span>
  );
}

export default function RadarTable({ rows, full = false }: { rows: RadarRow[]; full?: boolean }) {
  if (!rows.length)
    return <div className="pb muted small">Nothing on the radar yet. Launches land here once their curve starts filling.</div>;
  return (
    <div className="scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>Coin</th>
            <th>Curve</th>
            {full && <th>Peak</th>}
            {full && <th>Mcap</th>}
            <th>King</th>
            {full && <th>Dev</th>}
            <th>Age</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.mint}>
              <td>
                <CoinLink mint={r.mint} symbol={r.symbol} />
                {full && <span className="muted small"> {(r.name || "").slice(0, 18)}</span>}
              </td>
              <td><CurveBar p={r.pNow} /></td>
              {full && <td className="muted">{r.peak}%</td>}
              {full && <td className="muted">{num(Math.round(r.mcapNow))} ◎</td>}
              <td>
                {r.call ? (
                  <span className="row" style={{ gap: 6 }}>
                    <ScoreBar s={r.call.score} v={r.call.verdict} w={36} />
                    <VerdictTag v={r.call.verdict} />
                    {full && r.call.nano && <span className="tiny muted">nano {r.call.nano.score}</span>}
                  </span>
                ) : (
                  <span className="tiny mute2">calling at 5m</span>
                )}
              </td>
              {full && <td><DevTag n={r.devN} b={r.devB} /></td>}
              <td className="muted">{ago(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
