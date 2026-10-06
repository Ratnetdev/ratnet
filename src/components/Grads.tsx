"use client";
import { CoinLink, VerdictTag } from "./Calls";
import { ago } from "./fmt";

export type Grad = {
  mint: string;
  symbol: string;
  name: string;
  createdAt: number;
  bondedAt: number;
  secs: number;
  devN: number;
  v0: { score: number; verdict: string; counted: boolean } | null;
  nano: { score: number; verdict: string } | null;
  lead?: number | null;
};

export function fmtSecs(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export default function GradList({ grads, full = false }: { grads: Grad[]; full?: boolean }) {
  if (!grads.length)
    return (
      <div className="pb muted small">
        No graduations yet. Roughly 1 in 100 launches bonds, so the first ones land within the first hour or two of digging.
      </div>
    );
  return (
    <div className="scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>Coin</th>
            <th>Bonded in</th>
            <th>King said</th>
            {full && <th>Nano said</th>}
            {full && <th>Dev</th>}
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {grads.map((g) => (
            <tr key={g.mint + g.bondedAt}>
              <td><CoinLink mint={g.mint} symbol={g.symbol} /> {full && <span className="muted small">{(g.name || "").slice(0, 18)}</span>}</td>
              <td style={{ color: "var(--bond)" }}>{fmtSecs(g.secs)}</td>
              <td>
                {g.v0 ? (
                  <span className="row" style={{ gap: 6 }}>
                    <VerdictTag v={g.v0.verdict} />
                    <span className="tiny muted">{g.v0.score}</span>
                    {g.v0.verdict === "BOND" && g.v0.counted && <span className="green tiny">{g.lead ? `called ${fmtSecs(g.lead)} early` : "called it"}</span>}
                  </span>
                ) : (
                  <span className="tiny mute2">bonded before 5m</span>
                )}
              </td>
              {full && <td>{g.nano ? <span><VerdictTag v={g.nano.verdict} /> <span className="tiny muted">{g.nano.score}</span></span> : <span className="tiny mute2">–</span>}</td>}
              {full && <td className="tiny muted">{g.devN ? `${g.devN} prior` : "fresh"}</td>}
              <td className="muted">{ago(g.bondedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
