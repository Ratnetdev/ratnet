"use client";
import { useState } from "react";
import { usePoll } from "./usePoll";
import Info from "./Info";
import { ago } from "./fmt";
import { AGENT_COLOR } from "./DenScene";
import TripDetail, { Trip, col, ruleName, sgn } from "./TripDetail";
import Scorecard, { FeedbackBox, type Card } from "./Scorecard";
import { LensDossier, type Dossier } from "./LensCam";
import { MindCard, type Judgement } from "./MindBoard";
import CoinBuyers from "./CoinBuyers";
import { fullUrl, useAdmin } from "./useAdmin";

type Ev = { agent: string; at: number; text: string; tone: string };
type Vet = { at: number; passed: boolean; checks: { rule: string; ok: boolean; v?: string }[] } | null;
type CallCard = { symbol?: string; score: number; verdict: string; nano: { score: number; verdict: string } | null; parts?: Record<string, number> | null; nc?: [string, number][] | null; why: { plus: string[]; minus: string[] } | null; progress: number; at: number } | null;
type Fb = { id: string; at: number; verdict: string; tags: string[]; note: string; kind: string };
type Data = { trips: Trip[]; live: boolean; log: Ev[]; vet: Vet; lens: Dossier | null; mind?: Judgement | null; card: CallCard; feedback?: Fb[]; full?: boolean };

const TONE: Record<string, string> = { ok: "var(--rat)", bad: "var(--dust)", info: "var(--dim)", win: "var(--bond)", loss: "var(--dust)" };

/** The desk on one coin: its trades in full, the VET verdict, and every line the agents wrote about it. */
export default function CoinDesk({ mint }: { mint: string }) {
  const admin = useAdmin();
  const d = usePoll<Data>(fullUrl(`/api/desk/coin?mint=${mint}`, admin), 5000).data;
  const [all, setAll] = useState(false);
  if (!d) return null;
  const trips = d.trips || [];
  const log = d.log || [];
  const fail = d.vet?.checks.find((c) => !c.ok);
  const shown = all ? log : log.slice(0, 14);
  return (
    <>
    {d.mind ? (
      <section className="panel mt mind">
        <div className="ph"><span><Info k="mind"><b>MIND</b></Info> · what the trader&apos;s mind made of it</span></div>
        <div className="pb"><MindCard j={d.mind} /></div>
      </section>
    ) : null}
    <CoinBuyers mint={mint} />
    <LensDossier mint={mint} dossier={d.lens} />
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
                <span className="muted"> · {ago(d.vet.at)} ago{fail ? ` · ${ruleName(fail.rule)} failed${fail.v ? ` (${fail.v})` : ""}` : ""}</span>
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
          {d.card ? <Scorecard card={{ plus: d.card.why?.plus || [], minus: d.card.why?.minus || [], parts: d.card.parts, nc: d.card.nc, lens: d.lens?.done ? { score: d.lens.score, flags: d.lens.flags, good: d.lens.good } : null } satisfies Card} king={{ score: d.card.score, verdict: d.card.verdict }} nano={d.card.nano} /> : null}
          <FeedbackBox mint={mint} symbol={d.card?.symbol || d.lens?.symbol || ""} kind={d.vet ? "skip" : "call"} refAt={d.card?.at ?? null} />
        </div>
      )}

      {d.feedback?.length ? (
        <div className="pb small">
          <div className="sc-h">Your feedback on this coin</div>
          {d.feedback.map((f) => (
            <div key={f.id} className="cd-ev">
              <span className="ap-t">{ago(f.at)}</span>
              <b style={{ color: f.verdict === "good" ? "var(--rat)" : "var(--dust)" }}>{f.verdict}</b>
              <span>{f.kind}{f.tags.length ? ` · ${f.tags.join(", ")}` : ""}{f.note ? ` · ${f.note}` : ""}</span>
            </div>
          ))}
        </div>
      ) : null}

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
    </>
  );
}
