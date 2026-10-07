"use client";
import { usePoll } from "./usePoll";
import Info from "./Info";
import { ago } from "./fmt";

type H = {
  phase: string;
  from?: number;
  until?: number;
  clock?: number;
  done?: number;
  scanned?: number;
  bonded?: number;
  deep?: number;
  lessons?: number;
  runnerLessons?: number;
  queue?: number;
  days?: { day: string; scanned: number; bonded: number; rate: number | null }[];
  backtest?: { base: number | null; v0: number | null; v0n: number; nano: number | null; nanoN: number };
  season?: { sol24: number | null; sol7d: number | null; lrate: number | null; launches24: number; bonded24: number; gradRate24: number | null } | null;
  drift?: { shifts: number; boost: number; shiftAt: number | null; lossFast: number | null; loss: number };
  log: { at: number; text: string }[];
  bondsFound?: number;
  bondsBackTo?: number | null;
  bondsDone?: boolean;
  lastError?: string | null;
  errors?: number;
};
const day = (t?: number) => (t ? new Date(t).toISOString().slice(0, 10) : "…");
const sg = (n: number | null | undefined, d = 1) => (n == null ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(d)}%`);

/** The HISTORIAN and the season: how much of the past the models learned, and what kind of market it is now. */
export default function History() {
  const { data: h } = usePoll<H>("/api/history", 15000);
  const bt = h?.backtest;
  const se = h?.season;
  const dr = h?.drift;
  return (
    <section className="grid g2">
      <div className="panel">
        <div className="ph">
          <span><b>historian</b> · <Info k="historian">today first, then back in time</Info></span>
          <span className="tiny muted">{h ? h.phase : "…"}</span>
        </div>
        <div className="pb">
          <div className="row between small"><span className="muted">replayed</span><span>{day(h?.until)} ← {day(h?.clock)} <span className="mute2">(goal {day(h?.from)})</span></span></div>
          <div className="mt" style={{ height: 8, background: "var(--line)", position: "relative" }}>
            <i style={{ position: "absolute", inset: 0, width: `${h?.done ?? 0}%`, background: "var(--rat)", boxShadow: "0 0 8px var(--rat)" }} />
          </div>
          <div className="mkt mt" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
            <div><span className="k"><Info k="hscanned">Launches scanned</Info></span><b>{(h?.scanned ?? 0).toLocaleString()}</b></div>
            <div><span className="k"><Info k="hbonded">Bonded found</Info></span><b>{(h?.bonded ?? 0).toLocaleString()}</b></div>
            <div><span className="k"><Info k="hlessons">Lessons</Info></span><b>{(h?.lessons ?? 0).toLocaleString()}</b></div>
            <div><span className="k"><Info k="hrunner">Runner lessons</Info></span><b>{(h?.runnerLessons ?? 0).toLocaleString()}</b></div>
            <div><span className="k"><Info k="prequential">Base</Info></span><b>{bt?.base != null ? `${bt.base}%` : "–"}</b></div>
            <div><span className="k"><Info k="prequential">v0 BOND hit</Info></span><b>{bt?.v0 != null ? `${bt.v0}%` : "–"}</b></div>
            <div><span className="k"><Info k="prequential">nano BOND hit</Info></span><b style={{ color: "var(--rat)" }}>{bt?.nano != null ? `${bt.nano}%` : "–"}</b></div>
            <div><span className="k"><Info k="hqueue">Queue</Info></span><b>{h?.queue ?? 0}</b></div>
          </div>
          <div className="tiny muted mt">
            bonds first: {(h?.bondsFound ?? 0).toLocaleString()} graduations found back to {day(h?.bondsBackTo ?? undefined)}{h?.bondsDone ? " (done)" : ""}
            {h?.lastError ? <span> · last error: {h.lastError}</span> : null}
          </div>
          {!!h?.log?.length && <div className="tiny muted mt">{h.log.slice(0, 3).map((l) => <div key={l.at + l.text}>{ago(l.at)} · {l.text}</div>)}</div>}
        </div>
      </div>
      <div className="panel">
        <div className="ph">
          <span><b>season</b> · <Info k="season">the market right now</Info></span>
          <span className="tiny muted">{dr?.boost ? <span className="green">shift: learning 2x</span> : `${dr?.shifts ?? 0} shifts seen`}</span>
        </div>
        <div className="mkt" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          <div><span className="k"><Info k="sol24">SOL 24h</Info></span><b style={{ color: (se?.sol24 ?? 0) >= 0 ? "var(--rat)" : "var(--dust)" }}>{sg(se?.sol24)}</b></div>
          <div><span className="k"><Info k="sol7d">SOL 7d</Info></span><b style={{ color: (se?.sol7d ?? 0) >= 0 ? "var(--rat)" : "var(--dust)" }}>{sg(se?.sol7d)}</b></div>
          <div><span className="k"><Info k="lrate">Launches / hour</Info></span><b>{se?.lrate ? se.lrate.toLocaleString() : "–"}</b></div>
          <div><span className="k"><Info k="br24">Bond rate 24h</Info></span><b>{se?.gradRate24 != null ? `${se.gradRate24}%` : "–"}</b></div>
        </div>
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Day</th><th><Info k="hscanned">Scanned</Info></th><th><Info k="hbonded">Bonded</Info></th><th><Info k="br24">Bond rate</Info></th></tr></thead>
            <tbody>
              {(h?.days || []).map((d) => (
                <tr key={d.day}><td>{d.day}</td><td className="muted">{d.scanned.toLocaleString()}</td><td className="muted">{d.bonded}</td><td>{d.rate != null ? `${d.rate}%` : "–"}</td></tr>
              ))}
              {!h?.days?.length && <tr><td colSpan={4} className="muted">Days appear as the historian walks back.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
