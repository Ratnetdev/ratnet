"use client";
import Link from "next/link";
import { useState } from "react";
import { usePoll } from "./usePoll";
import Info from "./Info";
import { ago, solscanTx } from "./fmt";

type Exit = { at: number; sol: number; reason: string; pnlPct: number | null; sig?: string; px?: number };
type Trip = { mint: string; symbol: string; openedAt: number; closedAt: number | null; open: boolean; live: boolean; costSol: number; backSol: number; valueSol: number; pnlSol: number; pnlPct: number; why: string; exits: Exit[]; buySig?: string; holdMs: number; king?: number; nano?: number | null; how?: string; entryPx?: number; peakPct?: number | null; exitPct?: number | null; series?: [number, number][] };

/** Price across the whole trade: entry line, every sell, the peak. */
function TripChart({ t }: { t: Trip }) {
  const s = t.series || [];
  if (s.length < 2 || !t.entryPx) return <div className="trip-nochart">Chart starts recording from this version on.</div>;
  const W = 640, H = 150, P = 8;
  const t0 = s[0][0], t1 = Math.max(s[s.length - 1][0], ...t.exits.map((x) => x.at));
  const pxs = [...s.map((x) => x[1]), t.entryPx, ...t.exits.map((x) => x.px || t.entryPx!)];
  const lo = Math.min(...pxs), hi = Math.max(...pxs);
  const X = (tt: number) => P + ((tt - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
  const Y = (v: number) => H - P - ((v - lo) / Math.max(1e-18, hi - lo)) * (H - 2 * P);
  const line = s.map(([tt, v], i) => `${i ? "L" : "M"}${X(tt).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const up = (s[s.length - 1][1] || 0) >= t.entryPx;
  const pk = s.reduce((b, x) => (x[1] > b[1] ? x : b), s[0]);
  return (
    <svg className="trip-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <line x1={P} x2={W - P} y1={Y(t.entryPx)} y2={Y(t.entryPx)} stroke="rgba(255,255,255,.25)" strokeDasharray="4 4" />
      <path d={line} fill="none" stroke={up ? "#8cff5a" : "#ff5c5c"} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      <circle cx={X(pk[0])} cy={Y(pk[1])} r="3" fill="#ffb547" />
      {t.exits.filter((x) => x.px).map((x, i) => (
        <rect key={i} x={X(x.at) - 3} y={Y(x.px!) - 3} width="6" height="6" fill="#e8e8e8" />
      ))}
    </svg>
  );
}
type Rec = {
  live: boolean;
  summary: { trips: number; open: number; closed: number; wins: number; winRate: number | null; realizedSol: number; openSol: number; start: number; equity: number; returnPct: number | null; best: { symbol: string; mint: string; pnlPct: number } | null; worst: { symbol: string; mint: string; pnlPct: number } | null; avgHoldMs: number | null; since: number | null };
  trips: Trip[];
};

const sgn = (n: number, d = 1) => `${n > 0 ? "+" : ""}${n.toFixed(d)}`;
const col = (n: number) => (n > 0 ? "var(--rat)" : n < 0 ? "var(--dust)" : "var(--dim)");
function dur(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`;
}

function Row({ t, full }: { t: Trip; full: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className={`trip ${full ? "click" : ""}`} onClick={() => full && setOpen(!open)}>
        <td>
          <Link href={`/c/${t.mint}`} onClick={(e) => e.stopPropagation()}>${t.symbol}</Link>
          {t.open ? <span className="trip-tag open">open</span> : null}
          {t.live ? <span className="trip-tag live">live</span> : <span className="trip-tag">paper</span>}
        </td>
        <td className="muted">{ago(t.openedAt)} ago</td>
        <td>{t.costSol.toFixed(3)} ◎</td>
        {full && <td className="muted trip-exit">{t.exits.length ? t.exits.map((x) => x.reason.split(":")[0]).slice(-2).join(" · ") : t.open ? "holding" : "–"}</td>}
        <td style={{ color: col(t.pnlSol) }}>{sgn(t.pnlSol, 3)} ◎</td>
        <td style={{ color: col(t.pnlPct) }}>{sgn(t.pnlPct)}%</td>
        <td className="muted">{dur(t.holdMs)}</td>
      </tr>
      {full && open && (
        <tr className="trip-detail">
          <td colSpan={7}>
            <div className="trip-top">
              <div><span>The call</span><b>{t.how === "early" ? `early read ${t.king ?? "–"}` : `King ${t.king ?? "–"}`}{t.nano != null ? ` · nano ${t.nano}` : ""}</b></div>
              <div><span>Entry</span><b>{t.how === "stalk" ? "bought the pullback" : t.how === "early" ? "minute 1" : "on the call"}</b></div>
              <div><span>Peak while held</span><b style={{ color: col(t.peakPct ?? 0) }}>{t.peakPct != null ? `${sgn(t.peakPct)}%` : "–"}</b></div>
              <div><span>{t.open ? "Now" : "Exit"}</span><b style={{ color: col(t.pnlPct) }}>{sgn(t.pnlPct)}%</b></div>
              <div><span>Left on the table</span><b className="muted">{t.peakPct != null && !t.open ? `${Math.max(0, t.peakPct - t.pnlPct).toFixed(1)}%` : "–"}</b></div>
            </div>
            <TripChart t={t} />
            <div className="trip-legend"><i className="lg-entry" /> entry <i className="lg-sell" /> sell <i className="lg-peak" /> peak</div>
            <div className="trip-lines">
              <div><span className="d">{new Date(t.openedAt).toISOString().slice(5, 16).replace("T", " ")}</span> <b className="buy">BUY</b> {t.costSol.toFixed(3)} ◎ · {t.why}{t.buySig ? <> · <a href={solscanTx(t.buySig)} target="_blank" rel="noreferrer">tx</a></> : null}</div>
              {t.exits.map((x, i) => (
                <div key={i}><span className="d">{new Date(x.at).toISOString().slice(5, 16).replace("T", " ")}</span> <b className="sell">SELL</b> {x.sol.toFixed(3)} ◎{x.pnlPct != null ? <span style={{ color: col(x.pnlPct) }}> ({sgn(x.pnlPct)}%)</span> : null} · {x.reason}{x.sig ? <> · <a href={solscanTx(x.sig)} target="_blank" rel="noreferrer">tx</a></> : null}</div>
              ))}
              {t.open && <div><span className="d">now</span> <b>HOLDING</b> worth {t.valueSol.toFixed(3)} ◎ at the live price</div>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** The desk's public track record. `compact` for the homepage, full table with every fill on /desk. */
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
      <div className="scroll" style={compact ? undefined : { maxHeight: 640 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Coin</th><th>Opened</th><th><Info k="sol">Size</Info></th>{!compact && <th><Info k="why">Exits</Info></th>}<th><Info k="result">P&amp;L</Info></th><th>%</th><th>Held</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => <Row key={`${t.mint}${t.openedAt}`} t={t} full={!compact} />)}
            {!shown.length && <tr><td colSpan={7} className="muted">{d ? "No trades yet. The desk buys on paper the moment a King BOND call passes every check." : "loading…"}</td></tr>}
          </tbody>
        </table>
      </div>
      {!compact && <div className="pb tiny muted">Click a trade for every fill and the reason behind it. Paper fills use the real price at that moment, with fees and slippage. Live fills link to Solscan.</div>}
    </section>
  );
}
