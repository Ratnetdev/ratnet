"use client";
import { ago } from "./fmt";

export type Call = {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  createdAt: number;
  at: number;
  score: number;
  verdict: "BOND" | "WATCH" | "DUST";
  counted: boolean;
  progress: number;
  version: string;
  outcome: "BONDED" | "ALIVE" | "DIED" | null;
};

export function Verdict({ v }: { v: string }) {
  return <span className={`tag v-${v}`}>{v}</span>;
}
export function Outcome({ o }: { o: string | null }) {
  if (!o) return <span className="tiny mute2">pending</span>;
  return <span className={`tag o-${o}`}>{o}</span>;
}
export function ScoreBar({ s, v }: { s: number; v: string }) {
  return (
    <span className={`bar ${v.toLowerCase()}`} style={{ display: "inline-block", width: 70 }}>
      <i style={{ width: `${s}%` }} />
    </span>
  );
}
export function hit(c: Call) {
  if (!c.outcome || !c.counted) return null;
  if (c.verdict === "BOND") return c.outcome === "BONDED";
  if (c.verdict === "DUST") return c.outcome !== "BONDED";
  return null;
}

export function CallList({ calls, compact = false }: { calls: Call[]; compact?: boolean }) {
  if (!calls.length) return <div className="pb muted small">The Rat King calls each launch 5 minutes after it is born. First calls land shortly.</div>;
  return (
    <div className="scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>Coin</th>
            <th>Score</th>
            <th>Call</th>
            {!compact && <th>Curve @ call</th>}
            <th>Outcome</th>
            {!compact && <th>Age</th>}
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => {
            const h = hit(c);
            return (
              <tr key={c.mint}>
                <td>
                  <a href={`https://pump.fun/coin/${c.mint}`} target="_blank" rel="noreferrer">
                    ${c.symbol || "?"}
                  </a>{" "}
                  {!compact && <span className="muted small">{(c.name || "").slice(0, 22)}</span>}
                </td>
                <td>
                  <span className="row" style={{ gap: 8 }}>
                    <span style={{ width: 22 }}>{c.score}</span>
                    <ScoreBar s={c.score} v={c.verdict} />
                  </span>
                </td>
                <td>
                  <Verdict v={c.verdict} />
                  {!c.counted && <span className="tiny mute2"> late</span>}
                </td>
                {!compact && <td className="muted">{c.progress}%</td>}
                <td>
                  <Outcome o={c.outcome} />
                  {h === true && <span className="green tiny"> ✓</span>}
                  {h === false && <span className="tiny" style={{ color: "var(--dust)" }}> ✗</span>}
                </td>
                {!compact && <td className="muted">{ago(c.createdAt)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
