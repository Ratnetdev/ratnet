"use client";
// v0.1.71: GRID. Thousands of strategies (call filters x entry timing x exits) tried on every archived call with a price
// path. Ranked on the older 70% of calls, judged on the newest 30%, which the ranking never saw.
import { useState } from "react";
import { usePoll } from "./usePoll";
import { ago } from "./fmt";
import { col, sgn } from "./TripDetail";

type S = { n: number; wins: number; winRate: number; avgPct: number; pnl: number; pfLessBest: number };
type Row = { key?: string; filter: string; filterLabel: string; mode: string; modeLabel: string; exitLabel: string; train: S; test: S; pass: boolean; senders?: number; seen?: { runs: number; ranked: number; passed: number } };
type Lift = { id: string; label: string; calls: number; senders: number; rate: number; lift: number };
type Senders = { calls: number; senders: number; rate: number; fast: number; verdicts: Record<string, number>; medCurve: number | null; medMinsToBond: number | null; lifts: Lift[] };
type V = {
  at: number | null;
  error?: string;
  coins?: number;
  trainN?: number;
  testN?: number;
  from?: number | null;
  split?: number | null;
  tried?: number;
  rankable?: number;
  passed?: number;
  sol?: number;
  rows?: Row[];
  base?: Row[];
  bestTrain?: Row | null;
  senders?: Senders;
  pooled?: number;
  rules?: { pass: { minN: number; minWin: number; minAvg: number; minPf: number } };
};

const pf = (x: number) => (x >= 99 ? "no losses" : x.toFixed(2));
const day = (t?: number | null) => (t ? new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–");

function Rows({ rows, showPass }: { rows: Row[]; showPass: boolean }) {
  return (
    <div className="scroll">
      <table className="tbl rec-tbl">
        <thead>
          <tr><th>strategy</th><th>train trips</th><th>train avg</th><th>test trips</th><th>test won</th><th>test avg</th><th>test PF*</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.filter}:${r.mode}`}>
              <td style={{ whiteSpace: "normal", maxWidth: 440 }}>
                {showPass && r.pass ? <span className="tag" style={{ color: "var(--rat)", marginRight: 6 }}>PASSES</span> : null}
                <b>{r.filterLabel}</b>, buy {r.modeLabel}
                <div className="tiny mute2">
                  {r.exitLabel}
                  {r.senders ? ` · caught ${r.senders} migrated coin${r.senders > 1 ? "s" : ""}` : ""}
                  {r.seen && r.seen.runs > 1 ? ` · top list in ${r.seen.ranked} of the last ${r.seen.runs} runs${r.seen.passed ? `, passed ${r.seen.passed}` : ""}` : ""}
                </div>
              </td>
              <td>{r.train.n}</td>
              <td style={{ color: col(r.train.avgPct) }}>{`${sgn(r.train.avgPct)}%`}</td>
              <td>{r.test.n}</td>
              <td>{r.test.n ? `${Math.round(r.test.winRate)}%` : "–"}</td>
              <td style={{ color: col(r.test.avgPct) }}>{r.test.n ? `${sgn(r.test.avgPct)}%` : "–"}</td>
              <td>{r.test.n ? pf(r.test.pfLessBest) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SendersStudy({ s }: { s: Senders }) {
  const v = s.verdicts || {};
  return (
    <div className="pb small" style={{ borderTop: "1px solid var(--line)" }}>
      <div style={{ marginBottom: 6 }}>
        <b>the senders</b> · {s.senders} of {s.calls.toLocaleString()} calls migrated ({s.rate}%), {s.fast} within an hour of launch.
        {" "}The King called them {v.BOND ?? 0} BOND, {v.WATCH ?? 0} WATCH, {v.DUST ?? 0} DUST.
        {s.medCurve != null ? ` Median curve at the call ${Math.round(s.medCurve)}%` : ""}
        {s.medMinsToBond != null ? `, ${s.medMinsToBond} min from call to migration.` : "."}
      </div>
      {s.lifts.length ? (
        <div className="scroll">
          <table className="tbl rec-tbl">
            <thead>
              <tr><th>what senders had at the call</th><th>calls with it</th><th>of them migrated</th><th>vs average</th></tr>
            </thead>
            <tbody>
              {s.lifts.map((l) => (
                <tr key={l.id}>
                  <td>{l.label}</td>
                  <td>{l.calls.toLocaleString()}</td>
                  <td>{l.rate}%</td>
                  <td style={{ color: l.lift >= 1.5 ? "var(--rat)" : l.lift < 1 ? "var(--dust)" : undefined }}>{l.lift}x</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export default function GridBoard() {
  const d = usePoll<V>("/api/desk/grid", 120_000).data;
  const [all, setAll] = useState(false);
  if (!d) return null;
  if (!d.at || !d.rows) {
    return (
      <section className="panel mt" id="grid">
        <div className="ph"><span><b>grid</b> · the big strategy search</span></div>
        <div className="pb muted small">{d.error ? `Last run failed: ${d.error}` : "First run about 8 minutes after the worker starts, then every 3 hours."}</div>
      </section>
    );
  }
  const p = d.rules?.pass;
  const passed = d.passed ?? 0;
  const rows = all ? d.rows : d.rows.slice(0, 8);
  return (
    <section className="panel mt" id="grid">
      <div className="ph">
        <span>
          <b>grid</b> · {d.tried?.toLocaleString()} strategies on {d.coins?.toLocaleString()} calls ({d.sol} SOL a trade, the desk&apos;s costs)
        </span>
        <span className="tiny muted">run {ago(d.at)} ago</span>
      </div>
      <div className="pb small">
        {passed ? (
          <span style={{ color: "var(--rat)" }}>
            <b>{passed} candidate{passed > 1 ? "s" : ""}</b> held up on the newest calls. Next step: ARENA, to prove {passed > 1 ? "them" : "it"} on live coins.
          </span>
        ) : (
          <span>
            <b>No strategy passes yet.</b> {d.rankable ? `${d.rankable.toLocaleString()} looked good on the older calls, none held up on the newest ones.` : "None looked good even on the older calls."}
          </span>
        )}
        <div className="tiny mute2" style={{ marginTop: 4 }}>
          Ranked on {d.trainN?.toLocaleString()} calls from {day(d.from)} to {day(d.split)}, judged on the {d.testN?.toLocaleString()} after.
          {` ${d.pooled ?? 0} of them have pool prices after their migration (holding through the migration is tested on those).`}
          {p ? ` Passing = ${p.minN}+ test trips, ${p.minWin}%+ won, avg +${p.minAvg}%+, PF ${p.minPf}+ without the best trade.` : ""}
        </div>
      </div>
      {d.rows.length ? (
        <>
          <div className="pb tiny muted" style={{ paddingBottom: 0 }}>best on the older calls (positive in both halves), and how they did on the newest</div>
          <Rows rows={rows} showPass />
          {d.rows.length > 8 ? (
            <div className="pb tiny">
              <button className="btn dim" style={{ padding: "3px 10px" }} onClick={() => setAll(!all)}>{all ? "show fewer" : `show all ${d.rows.length}`}</button>
            </div>
          ) : null}
        </>
      ) : null}
      {d.senders && d.senders.senders ? <SendersStudy s={d.senders} /> : null}
      {d.base?.length ? (
        <>
          <div className="pb tiny muted" style={{ paddingBottom: 0 }}>baseline: every call, by entry timing, its best exit</div>
          <Rows rows={d.base} showPass={false} />
        </>
      ) : null}
      <div className="pb tiny mute2">*profit factor without the best trade. Test = the newest 30% of calls. With thousands of strategies tried, the best one on the older calls always looks good by luck; only the test column counts.</div>
    </section>
  );
}
