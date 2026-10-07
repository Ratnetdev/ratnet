"use client";
import { CoinLink, ScoreBar, VerdictTag } from "./Calls";
import { ago, chg, usd, type Mkt } from "./fmt";
import Info from "./Info";

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
  mkt?: Mkt | null;
  mcUsd?: number | null;
};

export function CurveBar({ p }: { p: number }) {
  const cls = p >= 85 ? "bond" : p >= 40 ? "watch" : "";
  return (
    <span className="row" style={{ gap: 8 }}>
      <span className={`bar curvebar ${cls}`} style={{ display: "inline-block" }}>
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

export function FlowBar({ b, s }: { b: number; s: number }) {
  const t = b + s;
  const pb = t ? (b / t) * 100 : 50;
  return (
    <span className="row" style={{ gap: 6 }} title={`${b} buys, ${s} sells in the last hour`}>
      <span style={{ display: "inline-flex", width: 60, height: 6, background: "var(--dust)" }}>
        <i style={{ width: `${pb}%`, background: "var(--rat)", display: "block" }} />
      </span>
      <span className="tiny muted">{b}/{s}</span>
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
            <th><Info k="curve">Curve</Info></th>
            {full && <th><Info k="peakcurve">Peak</Info></th>}
            <th><Info k="mcap">Mcap</Info></th>
            {full && <th><Info k="v1">Vol 1h</Info></th>}
            {full && <th><Info k="bs">Buys / sells 1h</Info></th>}
            <th><Info k="king">King</Info></th>
            {full && <th><Info k="dev">Dev</Info></th>}
            {full && <th>Age</th>}
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
              <td>
                {usd(r.mcUsd)}
                {full && r.mkt?.c5 != null && <span className="tiny" style={{ color: r.mkt.c5 >= 0 ? "var(--rat)" : "var(--dust)" }}> {chg(r.mkt.c5)}</span>}
              </td>
              {full && <td className="muted">{r.mkt ? usd(r.mkt.v1) : "–"}</td>}
              {full && <td>{r.mkt ? <FlowBar b={r.mkt.b1} s={r.mkt.s1} /> : <span className="tiny mute2">–</span>}</td>}
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
              {full && <td className="muted">{ago(r.createdAt)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
