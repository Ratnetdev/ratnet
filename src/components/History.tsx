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
  backtest?: { base: number | null; v0: number | null; v0n: number; nano: number | null; nanoN: number };
  log: { at: number; text: string }[];
};
const day = (t?: number) => (t ? new Date(t).toISOString().slice(0, 10) : "…");

/** The HISTORIAN: how much of pump.fun's past the models have already learned from. */
export default function History() {
  const { data: h } = usePoll<H>("/api/history", 15000);
  const bt = h?.backtest;
  return (
    <div className="panel">
      <div className="ph">
        <span><b>historian</b> · <Info k="historian">the past, replayed</Info></span>
        <span className="tiny muted">{h ? h.phase : "…"}</span>
      </div>
      <div className="pb">
        <div className="row between small"><span className="muted">window</span><span>{day(h?.from)} → {day(h?.until)}</span></div>
        <div className="bar mt" style={{ height: 8, background: "var(--line)", position: "relative" }}>
          <i style={{ position: "absolute", inset: 0, width: `${h?.done ?? 0}%`, background: "var(--rat)", boxShadow: "0 0 8px var(--rat)" }} />
        </div>
        <div className="row between tiny muted" style={{ marginTop: 4 }}><span>replay clock {h?.clock ? new Date(h.clock).toISOString().slice(0, 16).replace("T", " ") : "…"}</span><span>{h?.done ?? 0}%</span></div>
        <div className="mkt mt">
          <div><span className="k">Launches scanned</span><b>{(h?.scanned ?? 0).toLocaleString()}</b></div>
          <div><span className="k">Bonded found</span><b>{(h?.bonded ?? 0).toLocaleString()}</b></div>
          <div><span className="k">Replayed in full</span><b>{(h?.deep ?? 0).toLocaleString()}</b></div>
          <div><span className="k">Runner lessons</span><b>{(h?.runnerLessons ?? 0).toLocaleString()}</b></div>
          <div><span className="k"><Info k="prequential">Backtest base</Info></span><b>{bt?.base != null ? `${bt.base}%` : "–"}</b></div>
          <div><span className="k">v0 BOND hit</span><b>{bt?.v0 != null ? `${bt.v0}%` : "–"}</b></div>
          <div><span className="k">nano BOND hit</span><b style={{ color: "var(--rat)" }}>{bt?.nano != null ? `${bt.nano}%` : "–"}</b></div>
          <div><span className="k">Queue</span><b>{h?.queue ?? 0}</b></div>
        </div>
        {!!h?.log?.length && <div className="tiny muted mt">{h.log.slice(0, 4).map((l) => <div key={l.at + l.text}>{ago(l.at)} · {l.text}</div>)}</div>}
      </div>
    </div>
  );
}
