"use client";
// v0.1.71: GRID LIVE. GRID's best strategies trading on live coins (paper), each exactly as GRID tested it.
import Link from "next/link";
import { usePoll } from "./usePoll";
import { ago } from "./fmt";
import { col, dur, sgn } from "./TripDetail";
import CoinImg from "./CoinImg";

type L = { n: number; wins: number; winRate: number; avgPct: number; pnl: number; pfLessBest: number; passed: boolean };
type Fills = { buyN: number; buyGap: number; sellN: number; sellGap: number; noRoute: number; blocked: boolean };
type Book = { key: string; label: string; exitLabel: string; since: number; total?: number; any?: boolean; parent?: string; fills?: Fills | null; grid: { testN: number; testAvg: number; pass: boolean; explore?: boolean }; open: { mint: string; symbol: string; openedAt?: number; pnlPct: number }[]; watching: number; live: L };
type Trip = { k: string; mint: string; symbol: string; openedAt?: number; closedAt: number; pnlPct: number; why: string };
export type GridLiveView = { at: number | null; books?: Book[]; recent?: Trip[]; trips?: number; follow?: { key: string; label: string; exitLabel: string } | null; hot?: string | null };

const pf = (x: number) => (x >= 99 ? "no losses" : x.toFixed(2));

/** v0.1.77: GRID LIVE's trades, open or closed, as rows (inside the records panel). */
function Trades({ d, show }: { d: GridLiveView; show: "all" | "open" | "closed" }) {
  const label = new Map((d.books || []).map((b) => [b.key, b.label]));
  const open = show === "closed" ? [] : (d.books || []).flatMap((b) => b.open.map((o) => ({ ...o, k: b.key })));
  const closed = show === "open" ? [] : d.recent || [];
  const none = !open.length && !closed.length;
  return (
    <div className="scroll">
      <table className="tbl rec-tbl sticky1">
        <thead>
          <tr><th>Coin · strategy</th><th>Opened</th><th>Held</th><th>P&amp;L</th><th>Exit</th></tr>
        </thead>
        <tbody>
          {open.map((o) => (
            <tr key={`o${o.k}${o.mint}`}>
              <td><Link href={`/c/${o.mint}`} className="coin-a"><CoinImg mint={o.mint} sym={o.symbol} size={16} />${o.symbol}</Link><span className="trip-tag open">open</span><div className="tiny mute2" style={{ whiteSpace: "normal", maxWidth: 320 }}>{label.get(o.k) || o.k}</div></td>
              <td className="muted">{o.openedAt ? `${ago(o.openedAt)} ago` : "–"}</td>
              <td className="muted">{o.openedAt ? dur(Date.now() - o.openedAt) : "–"}</td>
              <td style={{ color: col(o.pnlPct) }}>{sgn(o.pnlPct)}%</td>
              <td className="muted">–</td>
            </tr>
          ))}
          {closed.map((t) => (
            <tr key={`c${t.k}${t.mint}${t.closedAt}`}>
              <td><Link href={`/c/${t.mint}`} className="coin-a"><CoinImg mint={t.mint} sym={t.symbol} size={16} />${t.symbol}</Link><div className="tiny mute2" style={{ whiteSpace: "normal", maxWidth: 320 }}>{label.get(t.k) || t.k}</div></td>
              <td className="muted">{t.openedAt ? `${ago(t.openedAt)} ago` : "–"}</td>
              <td className="muted">{t.openedAt ? dur(t.closedAt - t.openedAt) : "–"}</td>
              <td style={{ color: col(t.pnlPct) }}>{sgn(t.pnlPct)}%</td>
              <td className="muted trip-exit">{t.why}</td>
            </tr>
          ))}
          {none && <tr><td colSpan={5} className="muted">{show === "open" ? "No GRID LIVE trades open right now." : show === "closed" ? "No GRID LIVE trades closed yet." : "No GRID LIVE trades yet."}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default function GridLiveBoard({ embedded = false, show = "all" }: { embedded?: boolean; show?: "all" | "open" | "closed" } = {}) {
  const d = usePoll<GridLiveView>("/api/desk/gridlive", 30_000).data;
  if (!d) return embedded ? <div className="pb muted small">loading…</div> : null;
  if (!d.at) return embedded ? <div className="pb muted small">GRID LIVE starts after the first GRID run (about 8 minutes after the worker starts).</div> : null;
  const books = d.books || [];
  const Wrap = embedded ? "div" : "section";
  return (
    <Wrap className={embedded ? "gl-embed" : "panel mt"} id="gridlive">
      {embedded ? null : (
        <div className="ph">
          <span><b>grid live</b> · GRID&apos;s best strategies trading live coins on paper, exactly as tested</span>
          <span className="tiny muted">{ago(d.at)} ago</span>
        </div>
      )}
      <div className="pb small" style={{ paddingBottom: 0 }}>
        {d.follow ? (
          <span style={{ color: "var(--rat)" }}><b>The desk follows</b> {d.follow.label} · {d.follow.exitLabel}</span>
        ) : (
          <span className="muted">The desk follows the first strategy that passes the exam here (its entries go straight to the desk).</span>
        )}
      </div>
      {!books.length ? (
        <div className="pb muted small">No strategies yet. The books fill after each GRID run (every hour) with the ones that held up on the newest calls; a strategy stays until its live record decides it.</div>
      ) : (
        <div className="scroll">
          <table className="tbl rec-tbl">
            <thead>
              <tr><th>strategy</th><th>live trips</th><th>won</th><th>avg</th><th>PF*</th><th>open</th><th>GRID test</th></tr>
            </thead>
            <tbody>
              {books.map((b) => (
                <tr key={b.key}>
                  <td style={{ whiteSpace: "normal", maxWidth: 420 }}>
                    {b.live.passed ? <span className="tag" style={{ color: "var(--rat)", marginRight: 6 }}>PASSED</span> : null}
                    {!b.live.passed && d.hot === b.key ? <span className="tag" style={{ color: "var(--gold, #ffb547)", marginRight: 6 }}>HOT</span> : null}
                    {b.any ? <span className="tag" style={{ color: "var(--rat)", marginRight: 6 }}>EVERY LAUNCH</span> : b.parent ? <span className="tag" style={{ marginRight: 6 }}>VARIANT</span> : null}
                    {!b.live.passed && b.grid.explore && !b.parent && d.hot !== b.key ? <span className="tag" style={{ color: "var(--watch)", marginRight: 6 }}>EXPLORING</span> : null}
                    <b>{b.label}</b>
                    <div className="tiny mute2">{b.exitLabel} · live since {ago(b.since)} ago{b.watching ? ` · watching ${b.watching}` : ""}</div>
                    {b.fills && (b.fills.buyN || b.fills.sellN) ? (
                      <div className="tiny" style={{ color: b.fills.blocked ? "var(--dust)" : "var(--dim)" }}>
                        real fills (Jupiter vs paper): buy {sgn(b.fills.buyGap)}% ({b.fills.buyN}), sell {sgn(b.fills.sellGap)}% ({b.fills.sellN}){b.fills.noRoute ? `, ${b.fills.noRoute} without a route` : ""}{b.fills.blocked ? " · too far off, not followed" : ""}
                      </div>
                    ) : null}
                  </td>
                  <td>{b.total ?? b.live.n}/{b.grid.explore ? 45 : 30}</td>
                  <td>{b.live.n ? `${b.live.winRate}%` : "–"}</td>
                  <td style={{ color: col(b.live.avgPct) }}>{b.live.n ? `${sgn(b.live.avgPct)}%` : "–"}</td>
                  <td>{b.live.n ? pf(b.live.pfLessBest) : "–"}</td>
                  <td>{b.open.length ? b.open.map((o) => <div key={o.mint} className="tiny" style={{ color: col(o.pnlPct) }}>{o.symbol} {sgn(o.pnlPct)}%</div>) : "–"}</td>
                  <td className="tiny">{b.grid.testN} trips, <span style={{ color: col(b.grid.testAvg) }}>{sgn(b.grid.testAvg)}%</span>{b.grid.pass ? " · passed" : b.grid.explore ? " · exploring" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {embedded ? <Trades d={d} show={show} /> : null}
      {!embedded && d.recent?.length ? (
        <div className="pb tiny">
          <span className="muted">latest: </span>
          {d.recent.slice(0, 8).map((t) => (
            <span key={`${t.k}${t.mint}${t.closedAt}`} style={{ marginRight: 10, color: col(t.pnlPct) }}>{t.symbol} {sgn(t.pnlPct)}% ({t.why})</span>
          ))}
        </div>
      ) : null}
      <div className="pb tiny mute2">*profit factor without the best trade, last 30 trips. Passing = the desk&apos;s exam: 30 trips, 40%+ won, +10% on a 1 SOL desk at 0.05 SOL a trade, PF 1.2+ (exploring strategies also need 45 trips, positive overall). A pass goes to Telegram, and the desk trades it next, unless its real fills (Jupiter quotes taken at every paper fill of the strategies that matter) run 10%+ worse than paper over a round trip. The hot strategy gets its family: the same rule on every launch, and its exit with one setting changed.{embedded ? ` Closed shows the latest ${d.recent?.length ?? 0} of ${d.trips ?? 0} trades. Updated ${ago(d.at)} ago.` : ""}</div>
    </Wrap>
  );
}
