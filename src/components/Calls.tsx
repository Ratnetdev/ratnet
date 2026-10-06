"use client";
import Link from "next/link";
import { ago } from "./fmt";
import { TradeIcons } from "./venues";
import Info from "./Info";

export type Verdict = "BOND" | "WATCH" | "DUST";
export type Call = {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  createdAt: number;
  at: number;
  score: number;
  verdict: Verdict;
  counted: boolean;
  progress: number;
  version: string;
  v0?: { score: number; verdict: Verdict } | null;
  nano?: { score: number; verdict: Verdict } | null;
  outcome: "BONDED" | "ALIVE" | "DIED" | null;
  why?: { plus: string[]; minus: string[] };
  farm?: string;
};

export function VerdictTag({ v }: { v: string }) {
  return <span className={`tag v-${v}`}>{v}</span>;
}
export function Outcome({ o }: { o: string | null }) {
  if (!o) return <span className="tiny mute2">pending</span>;
  return <span className={`tag o-${o}`}>{o}</span>;
}
export function ScoreBar({ s, v, w = 70 }: { s: number; v: string; w?: number }) {
  return (
    <span className={`bar ${v.toLowerCase()}`} style={{ display: "inline-block", width: w }}>
      <i style={{ width: `${Math.max(2, s)}%` }} />
    </span>
  );
}
export function hitOf(verdict: string, outcome: string | null, counted = true) {
  if (!outcome || !counted) return null;
  if (verdict === "BOND") return outcome === "BONDED";
  if (verdict === "DUST") return outcome !== "BONDED";
  return null;
}
export function Mark({ h }: { h: boolean | null }) {
  if (h === true) return <span className="green tiny"> ✓</span>;
  if (h === false) return <span className="tiny" style={{ color: "var(--dust)" }}> ✗</span>;
  return null;
}
/** The coin's page, plus small trade buttons (GMGN, Axiom, FOMO, pump.fun, DexScreener) with the referral codes. */
export function CoinLink({ mint, symbol, trade = true }: { mint: string; symbol: string; trade?: boolean }) {
  return (
    <>
      <Link href={`/c/${mint}`}>${symbol || "?"}</Link>
      {trade ? <TradeIcons ca={mint} /> : null}
    </>
  );
}

export function CallList({ calls, compact = false }: { calls: Call[]; compact?: boolean }) {
  if (!calls.length) return <div className="pb muted small">The Rat King calls each launch 5 minutes after it is born. First calls land shortly.</div>;
  return (
    <div className="scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>Coin</th>
            <th><Info k="kingv1">King</Info></th>
            {!compact && <th><Info k="nano">Nano</Info></th>}
            {!compact && <th><Info k="curvecall">Curve @ call</Info></th>}
            <th><Info k="outcome">Outcome</Info></th>
            {!compact && <th>Age</th>}
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.mint}>
              <td>
                <CoinLink mint={c.mint} symbol={c.symbol} /> {!compact && <span className="muted small">{(c.name || "").slice(0, 20)}</span>}
                {c.farm ? <div className="call-why minus">farm: {c.farm}</div> : c.why?.plus[0] ? <div className="call-why">{c.why.plus[0]}</div> : null}
              </td>
              <td>
                <span className="row" style={{ gap: 8 }}>
                  <span style={{ width: 22 }} title={c.v0 ? `King ${c.version}: nano leads. v0 rules said ${c.v0.verdict} ${c.v0.score}` : `King ${c.version}`}>{c.score}</span>
                  <ScoreBar s={c.score} v={c.verdict} w={compact ? 44 : 60} />
                  <VerdictTag v={c.verdict} />
                  <Mark h={hitOf(c.verdict, c.outcome, c.counted)} />
                </span>
              </td>
              {!compact && (
                <td>
                  {c.nano ? (
                    <span className="row" style={{ gap: 6 }}>
                      <span style={{ width: 22 }}>{c.nano.score}</span>
                      <VerdictTag v={c.nano.verdict} />
                      <Mark h={hitOf(c.nano.verdict, c.outcome, c.counted)} />
                    </span>
                  ) : (
                    <span className="tiny mute2">learning</span>
                  )}
                </td>
              )}
              {!compact && <td className="muted">{c.progress}%</td>}
              <td>
                <Outcome o={c.outcome} />
                {!c.counted && <span className="tiny mute2"> late</span>}
              </td>
              {!compact && <td className="muted">{ago(c.createdAt)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
