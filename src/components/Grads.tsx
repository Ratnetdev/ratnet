"use client";
import { CoinLink, VerdictTag } from "./Calls";
import { ago } from "./fmt";
import Info from "./Info";

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
  run?: { pk: number; now?: number; cUsd?: number | null; x: number | null } | null;
};

export function usdK(n?: number | null) {
  if (!n) return "–";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e5) return `$${Math.round(n / 1000)}K`;
  if (n >= 1e3) return `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${Math.round(n)}`;
}

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
            <th><Info k="bondedin">Bonded in</Info></th>
            <th><Info k="king">King said</Info></th>
            <th><Info k="peak">Peak</Info></th>
            <th><Info k="fromcall">From call</Info></th>
            {full && <th><Info k="nano">Nano said</Info></th>}
            {full && <th><Info k="dev">Dev</Info></th>}
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
              <td>{usdK(g.run?.pk)}{g.run?.now && g.run.pk ? <span className="tiny mute2"> · now {usdK(g.run.now)}</span> : null}</td>
              <td style={{ color: (g.run?.x ?? 0) >= 2 ? "var(--bond)" : "var(--dim)" }}>{g.run?.x ? `${g.run.x}x` : "–"}</td>
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
