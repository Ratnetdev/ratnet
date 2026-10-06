"use client";
import { useState } from "react";
import { usePoll } from "./usePoll";
import Info from "./Info";
import { ago } from "./fmt";
import { AGENT_COLOR } from "./DenScene";
import TripDetail, { Trip, col, ruleName, sgn } from "./TripDetail";

type Ev = { agent: string; at: number; text: string; tone: string };
type Vet = { at: number; passed: boolean; checks: { rule: string; ok: boolean; v: string }[] } | null;
type Data = { trips: Trip[]; live: boolean; log: Ev[]; vet: Vet };

const TONE: Record<string, string> = { ok: "var(--rat)", bad: "var(--dust)", info: "var(--dim)", win: "var(--bond)", loss: "var(--dust)" };

/** The desk on one coin: its trades in full, the VET verdict, and every line the agents wrote about it. */
export default function CoinDesk({ mint }: { mint: string }) {
  const d = usePoll<Data>(`/api/desk/coin?mint=${mint}`, 5000).data;
  const [all, setAll] = useState(false);
  if (!d) return null;
  const trips = d.trips || [];
  const log = d.log || [];
  const fail = d.vet?.checks.find((c) => !c.ok);
  const shown = all ? log : log.slice(0, 14);
  return (
    <section className="panel mt coin-desk">
      <div className="ph">
        <span><Info k="coindesk"><b>the desk on this coin</b></Info>{trips.length ? ` · ${trips.length} trade${trips.length > 1 ? "s" : ""}` : ""}</span>
        {trips[0] ? <span style={{ color: col(trips[0].pnlSol) }}>{trips[0].open ? "open" : "closed"} {sgn(trips[0].pnlPct)}%</span> : null}
      </div>

      {trips.map((t) => (
        <div key={t.openedAt} className="cd-trip">
          <TripDetail t={t} coinLink={false} />
        </div>
      ))}

      {!trips.length && (
        <div className="pb small">
          {d.vet ? (
            <div className="cd-vet">
              <div className="cd-vet-h">
                <span style={{ color: d.vet.passed ? "var(--rat)" : "var(--dim)" }}>{d.vet.passed ? "VET passed" : "VET skipped it"}</span>
                <span className="muted"> · {ago(d.vet.at)} ago{fail ? ` · ${ruleName(fail.rule)} failed (${fail.v})` : ""}</span>
              </div>
              <div className="td-checks">
                {d.vet.checks.map((x) => (
                  <div key={x.rule} className={x.ok ? "ok" : "no"}><i>{x.ok ? "✓" : "✗"}</i><span>{ruleName(x.rule)}</span><em>{x.v}</em></div>
                ))}
              </div>
            </div>
          ) : (
            <span className="muted">The desk has not traded this coin. It only buys King BOND calls that pass every VET check.</span>
          )}
        </div>
      )}

      {log.length > 0 && (
        <div className="cd-log">
          <div className="cd-log-h">Agent log <span className="muted">· every line the agents wrote about this coin</span></div>
          {shown.map((e, i) => (
            <div key={i} className="cd-ev">
              <span className="ap-t">{ago(e.at)}</span>
              <b style={{ color: AGENT_COLOR[e.agent] || "var(--text)" }}>{e.agent}</b>
              <span style={{ color: TONE[e.tone] || "var(--dim)" }}>{e.text}</span>
            </div>
          ))}
          {log.length > 14 && <button className="cd-more" onClick={() => setAll(!all)}>{all ? "show less" : `show all ${log.length}`}</button>}
        </div>
      )}
    </section>
  );
}
