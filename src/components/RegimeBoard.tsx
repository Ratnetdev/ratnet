"use client";
// v0.1.63: REGIME. The market state and the strategies' live ARENA hit rates switch the desk's King, minute-1 and MOMO
// strategies on, to half size, or off. Signals it blocks go to the ghost desk, so what the switch saved is measured.
import { usePoll } from "./usePoll";
import { ago } from "./fmt";
import { col, sgn } from "./TripDetail";

type Level = "on" | "half" | "off";
type R = {
  at: number | null;
  mode?: "on" | "shadow" | "off";
  market?: { launchesNow: number | null; launchesBase: number | null; gradNow: number | null; gradBase: number | null; migrationsHour: number | null; sol6: number | null; sol24: number | null; state: "hot" | "normal" | "cold" | "dead" };
  hits?: Record<string, { n: number; winRate: number; avgPct: number }>;
  gates?: Record<string, { level: Level; why: string; since: number }>;
  proving?: boolean;
  promo?: { picks: Record<string, string | null>; why: Record<string, string>; rules?: { minN: number; minWin: number; minAvg: number; minPf: number } };
  history?: { at: number; sleeve: string; from: Level; to: Level; why: string }[];
  saved?: { n: number; wins: number; pnl: number };
};
const NAME: Record<string, string> = { king: "King calls", early: "Minute-1 entries", momo: "MOMO", wire: "WIRE (X posts)" };
const STATE_COL: Record<string, string> = { hot: "var(--rat)", normal: "var(--watch)", cold: "var(--bond)", dead: "var(--dust)" };
const LEVEL_COL: Record<Level, string> = { on: "var(--rat)", half: "var(--bond)", off: "var(--dust)" };
const pctS = (x: number | null | undefined) => (x == null ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);

export default function RegimeBoard() {
  const d = usePoll<R>("/api/desk/regime", 30_000).data;
  if (!d) return null;
  const m = d.market;
  const shadow = d.mode === "shadow";
  return (
    <section className="panel mt" id="regime">
      <div className="ph">
        <span>
          <b>regime</b> · only proven strategies trade, the market sets their size
          {m ? (
            <>
              {" "}· market <span className="tag" style={{ color: STATE_COL[m.state] }}>{m.state.toUpperCase()}</span>
            </>
          ) : null}
        </span>
        <span className="tiny muted">{d.mode === "off" ? "switched off" : shadow ? "shadow · shown, not applied" : d.at ? `read ${ago(d.at)} ago` : "first reading ~2 min after the worker starts"}</span>
      </div>
      {m ? (
        <div className="pb row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className="pill">graduations {m.gradNow == null ? "–" : `${m.gradNow.toFixed(2)}%`} vs {m.gradBase == null ? "–" : `${m.gradBase.toFixed(2)}%`} today</span>
          <span className="pill">launches {m.launchesNow ?? "–"}/h vs {m.launchesBase ?? "–"}/h</span>
          {m.migrationsHour != null ? <span className="pill">migrations {m.migrationsHour} last hour</span> : null}
          <span className="pill">SOL <span style={{ color: col(m.sol6 ?? 0) }}>{pctS(m.sol6)}</span> 6h · <span style={{ color: col(m.sol24 ?? 0) }}>{pctS(m.sol24)}</span> 24h</span>
        </div>
      ) : null}
      {d.gates ? (
        <div className="scroll">
          <table className="tbl rec-tbl">
            <thead>
              <tr><th>strategy</th><th>now</th><th>arena, last coins</th><th>win rate</th><th>avg</th></tr>
            </thead>
            <tbody>
              {Object.entries(d.gates).map(([s, g]) => {
                const h = d.hits?.[s];
                const pick = d.promo?.picks?.[s];
                const benched = d.proving !== false && d.promo && !pick;
                const lvl: Level = benched ? "off" : g.level;
                return (
                  <tr key={s}>
                    <td>
                      <b>{NAME[s] || s}</b>
                      {d.promo ? <div className="tiny" style={{ whiteSpace: "normal", maxWidth: 420, color: pick ? "var(--rat)" : "var(--dim)" }}>{d.promo.why?.[s]}</div> : null}
                      <div className="tiny mute2" style={{ whiteSpace: "normal", maxWidth: 420 }}>{g.why}</div>
                    </td>
                    <td>
                      <span className="tag" style={{ color: LEVEL_COL[lvl] }}>{benched ? "BENCHED" : lvl === "half" ? "HALF SIZE" : lvl.toUpperCase()}</span>
                      <div className="tiny mute2">for {ago(g.since)}</div>
                    </td>
                    <td>{h?.n ?? 0}</td>
                    <td>{h?.n ? `${h.winRate}%` : "–"}</td>
                    <td style={{ color: col(h?.avgPct ?? 0) }}>{h?.n ? `${sgn(h.avgPct)}%` : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="pb muted small">No reading yet. REGIME reads the market every 5 minutes in the worker.</div>
      )}
      <div className="pb tiny">
        {d.saved?.n ? (
          <div style={{ marginBottom: 6 }}>
            <span className="muted">signals it blocked, traded by the ghost desk: </span>
            {d.saved.n} closed, {d.saved.wins} won, <span style={{ color: col(d.saved.pnl) }}>{sgn(d.saved.pnl, 3)} ◎</span>
            <span className="muted"> · {d.saved.pnl <= 0 ? `the switch saved ${Math.abs(d.saved.pnl).toFixed(3)} ◎` : `the switch cost ${d.saved.pnl.toFixed(3)} ◎`}</span>
          </div>
        ) : (
          <div className="muted" style={{ marginBottom: 6 }}>No blocked signal has closed yet. Each one goes to the ghost desk, so the switch gets its own record.</div>
        )}
        {d.history?.length ? (
          <>
            <div className="muted" style={{ marginBottom: 4 }}>latest switches</div>
            {d.history.slice(0, 6).map((h) => (
              <div key={`${h.at}${h.sleeve}`} className="row" style={{ gap: 10, justifyContent: "space-between" }}>
                <span>
                  {NAME[h.sleeve] || h.sleeve} <span style={{ color: LEVEL_COL[h.from] }}>{h.from}</span> → <span style={{ color: LEVEL_COL[h.to] }}>{h.to}</span>
                </span>
                <span className="muted">{ago(h.at)} ago</span>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </section>
  );
}
