"use client";
// v0.1.58: ARENA. Six paper strategies on the same live signals as the desk, each in its own book, each with its own
// exam score. Only the entry rules differ; fills, fees and exits are the desk's.
import { useState } from "react";
import { usePoll } from "./usePoll";
import { ago } from "./fmt";
import { col, dur, sgn } from "./TripDetail";

type V = { id: string; label: string; path?: string; why: string; open: { mint: string; symbol: string; openedAt: number; pnlPct: number }[]; n: number; wins: number; winRate: number; pnl: number; avgPct: number; checks: { label: string; ok: boolean; now: string }[]; passed: boolean };
type Trip = { v: string; mint: string; symbol: string; openedAt: number; closedAt: number; pnlPct: number; pnl: number; reason: string };
type A = { at: number; variants: V[]; recent: Trip[] };

export default function ArenaBoard() {
  const d = usePoll<A>("/api/desk/arena", 15_000).data;
  const rg = usePoll<{ promo?: { picks: Record<string, string | null> } }>("/api/desk/regime", 30_000).data;
  const picked = new Set(Object.values(rg?.promo?.picks || {}).filter(Boolean) as string[]);
  const [open, setOpen] = useState<string | null>(null);
  if (!d) return null;
  const label = Object.fromEntries(d.variants.map((v) => [v.id, v.label]));
  return (
    <section className="panel mt" id="arena">
      <div className="ph">
        <span><b>arena</b> · {d.variants.length} paper variants on the same signals, 0.1 SOL a trade, the desk&apos;s fees · the desk follows a variant only once its record proves it</span>
        <span className="tiny muted">not counted · compared</span>
      </div>
      <div className="scroll">
        <table className="tbl rec-tbl">
          <thead>
            <tr><th>strategy</th><th>open</th><th>trips</th><th>win rate</th><th>avg</th><th>P&amp;L</th><th>exam</th></tr>
          </thead>
          <tbody>
            {d.variants.map((v, i) => {
              const passed = v.checks.filter((c) => c.ok).length;
              const head = v.path && v.path !== d.variants[i - 1]?.path;
              return [
                head ? (
                  <tr key={`h${v.path}`}>
                    <td colSpan={7} className="tiny muted" style={{ paddingTop: 12 }}>{({ king: "KING CALLS", early: "MINUTE-1", momo: "MOMO", wire: "WIRE" } as Record<string, string>)[v.path!] || v.path}</td>
                  </tr>
                ) : null,
                <tr key={v.id} className="click" onClick={() => setOpen(open === v.id ? null : v.id)}>
                  <td>
                    <b>{v.label}</b>
                    {picked.has(v.id) ? <span className="tag" style={{ color: "var(--rat)", marginLeft: 8 }}>DESK FOLLOWS</span> : null}
                    <div className="tiny mute2">{open === v.id ? v.why : v.checks.map((c) => `${c.label} ${c.now}`).slice(0, 1).join("")}</div>
                    {open === v.id ? <div className="tiny mute2">{v.checks.map((c) => `${c.ok ? "✓" : "·"} ${c.label} ${c.now}`).join("  ")}</div> : null}
                  </td>
                  <td>{v.open.length}</td>
                  <td>{v.n}</td>
                  <td>{v.n ? `${Math.round(v.winRate)}%` : "–"}</td>
                  <td style={{ color: col(v.avgPct) }}>{v.n ? `${sgn(v.avgPct)}%` : "–"}</td>
                  <td style={{ color: col(v.pnl) }}>{v.n ? `${sgn(v.pnl, 3)} ◎` : "–"}</td>
                  <td className={v.passed ? "green" : "muted"}>{v.passed ? "PASSED" : `${passed}/${v.checks.length || 5}`}</td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
      {d.recent.length ? (
        <div className="pb tiny">
          <div className="muted" style={{ marginBottom: 6 }}>latest arena trips</div>
          {d.recent.slice(0, 8).map((t) => (
            <div key={`${t.v}${t.mint}${t.closedAt}`} className="row" style={{ gap: 10, justifyContent: "space-between" }}>
              <span>{label[t.v] || t.v} · ${t.symbol}</span>
              <span className="muted">{dur(t.closedAt - t.openedAt)} · {ago(t.closedAt)} ago</span>
              <span style={{ color: col(t.pnlPct) }}>{sgn(t.pnlPct)}%</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="pb muted small">No arena trips yet. The books fill as signals come in; each needs 30 closed trips for its exam.</div>
      )}
    </section>
  );
}
