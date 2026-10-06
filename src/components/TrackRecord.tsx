"use client";
import Link from "next/link";
import { useState } from "react";
import { usePoll } from "./usePoll";
import Info from "./Info";
import { ago, usd } from "./fmt";
import TripDetail, { Trip, col, dur, moveOf, sgn } from "./TripDetail";

type Rec = {
  live: boolean;
  summary: { trips: number; open: number; closed: number; wins: number; winRate: number | null; realizedSol: number; openSol: number; start: number; equity: number; returnPct: number | null; best: { symbol: string; mint: string; pnlPct: number } | null; worst: { symbol: string; mint: string; pnlPct: number } | null; avgHoldMs: number | null; since: number | null };
  trips: Trip[];
};

function Row({ t, full }: { t: Trip; full: boolean }) {
  const [open, setOpen] = useState(false);
  const move = moveOf(t);
  const end = t.open ? t.nowMc : t.exitMc;
  const lastReason = t.exits.length ? t.exits[t.exits.length - 1].reason.split(/[:(]/)[0].trim() : t.open ? "holding" : "–";
  return (
    <>
      <tr className={`trip click ${open ? "on" : ""}`} onClick={() => setOpen(!open)}>
        <td>
          <span className="trip-caret">{open ? "▾" : "▸"}</span>
          <Link href={`/c/${t.mint}`} onClick={(e) => e.stopPropagation()}>${t.symbol}</Link>
          {t.open ? <span className="trip-tag open">open</span> : null}
          {t.how === "wire" ? <span className="trip-tag">tweet</span> : t.how === "early" ? <span className="trip-tag">1m</span> : null}
          {t.live ? <span className="trip-tag live">live</span> : null}
        </td>
        {full && <td className="muted">{ago(t.openedAt)} ago{t.ctx ? <div className="tiny mute2">coin {dur(t.ctx.ageMs)} old</div> : null}</td>}
        <td>{usd(t.entryMc)}{full && t.ctx?.curve != null ? <div className="tiny mute2">curve {t.ctx.curve}%</div> : null}</td>
        <td>{usd(end)}{full ? <div className="tiny mute2">{t.open ? "now" : "exit"}</div> : null}</td>
        <td style={{ color: col(move ?? 0) }}>{move != null ? `${sgn(move)}%` : "–"}</td>
        <td style={{ color: col(t.pnlSol) }}>{sgn(t.pnlSol, 3)} ◎{full ? <div className="tiny" style={{ color: col(t.pnlPct) }}>{sgn(t.pnlPct)}%</div> : null}</td>
        {full && <td className="muted">{dur(t.holdMs)}</td>}
        {full && <td className="muted trip-exit">{lastReason}</td>}
      </tr>
      {open && (
        <tr className="trip-detail">
          <td colSpan={full ? 8 : 5}>
            <TripDetail t={t} />
          </td>
        </tr>
      )}
    </>
  );
}

/** The desk's public track record. `compact` for the homepage, full table on /desk. Click any trade for every detail. */
export default function TrackRecord({ compact = false }: { compact?: boolean }) {
  const d = usePoll<Rec>("/api/desk/record", compact ? 10000 : 5000).data;
  const [tab, setTab] = useState<"all" | "open" | "closed">("all");
  const s = d?.summary;
  const trips = (d?.trips || []).filter((t) => (tab === "all" ? true : tab === "open" ? t.open : !t.open));
  const shown = compact ? trips.slice(0, 6) : trips;
  return (
    <section className="panel mt record" id="record">
      <div className="ph">
        <span><Info k="record"><b>track record</b></Info> · {d?.live ? "live wallet" : "paper desk"}{s?.since ? `, since ${ago(s.since)} ago` : ""}</span>
        {compact ? <Link href="/desk#record">every trade →</Link> : (
          <span className="rec-tabs">
            {(["all", "open", "closed"] as const).map((k) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{k}{k === "open" && s ? ` ${s.open}` : k === "closed" && s ? ` ${s.closed}` : ""}</button>
            ))}
          </span>
        )}
      </div>
      <div className="rec-stats">
        <div><span className="k">Return</span><b style={{ color: col(s?.returnPct ?? 0) }}>{s?.returnPct != null ? `${sgn(s.returnPct)}%` : "–"}</b><em>{s ? `${s.start.toFixed(3)} → ${s.equity.toFixed(3)} ◎` : ""}</em></div>
        <div><span className="k">Trades closed</span><b>{s?.closed ?? 0}</b><em>{s ? `${s.open} open now` : ""}</em></div>
        <div><span className="k">Win rate</span><b>{s?.winRate != null ? `${s.winRate}%` : "–"}</b><em>{s ? `${s.wins} of ${s.closed} in profit` : ""}</em></div>
        <div><span className="k">Realized</span><b style={{ color: col(s?.realizedSol ?? 0) }}>{s ? `${sgn(s.realizedSol, 3)} ◎` : "–"}</b><em>{s && s.open ? `${sgn(s.openSol, 3)} ◎ open` : "closed trades"}</em></div>
        {!compact && <div><span className="k">Best / worst</span><b>{s?.best ? <span style={{ color: col(s.best.pnlPct) }}>{sgn(s.best.pnlPct, 0)}%</span> : "–"} <span className="muted">/</span> {s?.worst ? <span style={{ color: col(s.worst.pnlPct) }}>{sgn(s.worst.pnlPct, 0)}%</span> : "–"}</b><em>{s?.best ? `$${s.best.symbol} · $${s.worst?.symbol}` : ""}</em></div>}
        {!compact && <div><span className="k">Avg hold</span><b>{s?.avgHoldMs ? dur(s.avgHoldMs) : "–"}</b><em>closed trades</em></div>}
      </div>
      <div className="scroll" style={compact ? undefined : { maxHeight: 900 }}>
        <table className="tbl rec-tbl">
          <thead>
            <tr>
              <th>Coin</th>
              {!compact && <th>Opened</th>}
              <th><Info k="entrymc">Entry MC</Info></th>
              <th><Info k="exitmc">Exit / now MC</Info></th>
              <th><Info k="move">Change</Info></th>
              <th><Info k="result">P&amp;L</Info></th>
              {!compact && <th>Held</th>}
              {!compact && <th><Info k="why">Exit</Info></th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => <Row key={`${t.mint}${t.openedAt}`} t={t} full={!compact} />)}
            {!shown.length && <tr><td colSpan={8} className="muted">{d ? "No trades yet. The desk buys on paper the moment a King BOND call passes every check." : "loading…"}</td></tr>}
          </tbody>
        </table>
      </div>
      {!compact && <div className="pb tiny muted">Click a trade for the full picture: coin age and market cap at the buy, the call behind it, every VET check, what the rats saw, the price chart and every fill. Paper fills use the real price at that moment, with fees and slippage. Live fills link to Solscan.</div>}
    </section>
  );
}
