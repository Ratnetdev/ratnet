"use client";
// HOUND on the desk: who among the tracked wallets is buying, live, with names.
import Link from "next/link";
import { usePoll } from "./usePoll";
import Info from "./Info";
import { ago } from "./fmt";
import { fullUrl, useAdmin } from "./useAdmin";

type Buy = { id: string; w: string; name: string; cls: string; conf: string; mint: string; symbol: string; sol: number; at: number; sig: string; side: string };
type H = { n: number; avg: number | null; x2: number };
type View = { live: { at: number; text: string } | null; hook: { n: number; at: number } | null; breakoutsQueued: number; counts: { fomo: number; kol: number; kolConfirmed: number; smart: number; admin: number }; classes: { cls: string; label: string; h1: H; h6: H; h24: H }[]; feed: Buy[]; sources: Record<string, boolean> };

export const CLS_COL: Record<string, string> = { "fomo-homerun": "var(--bond)", "fomo-steady": "var(--watch)", kol: "#ff8fd8", smart: "var(--rat)", admin: "var(--dim)" };
const pc = (n: number | null) => (n == null ? "–" : `${n > 0 ? "+" : ""}${n}%`);

export default function HoundBoard() {
  const admin = useAdmin();
  const v = usePoll<View>(fullUrl("/api/hound", admin), 4000).data;
  return (
    <section className="panel mt hound">
      <div className="ph">
        <span><Info k="hound"><b>HOUND</b></Info> · tracked wallets buying right now</span>
        <span className="tiny muted">{v ? `${v.counts.fomo} FOMO traders · ${v.counts.kol} KOLs (${v.counts.kolConfirmed} confirmed) · ${v.counts.smart} smart wallets${v.hook ? ` · ${v.hook.n} watched live` : " · live feed off"}` : ""}</span>
      </div>
      {v?.live ? <div className="hd-live"><i className="lc-dot run" /> {v.live.text} <span className="muted tiny">{ago(v.live.at)} ago</span></div> : null}
      <div className="hound-grid">
        <div className="scroll" style={{ maxHeight: 360 }}>
          <table className="tbl">
            <thead><tr><th>When</th><th>Who</th><th>Coin</th><th>SOL</th></tr></thead>
            <tbody>
              {(v?.feed || []).filter((b) => b.side === "buy").slice(0, 25).map((b) => (
                <tr key={b.id}>
                  <td className="muted">{ago(b.at)}</td>
                  <td><span style={{ color: CLS_COL[b.cls] }}>{b.name}</span>{b.conf !== "confirmed" ? <span className="tiny mute2"> unconfirmed</span> : null}</td>
                  <td><Link href={`/c/${b.mint}`}>{b.symbol ? `$${b.symbol}` : `${b.mint.slice(0, 4)}…`}</Link></td>
                  <td>{b.sol ? b.sol.toFixed(2) : "–"}</td>
                </tr>
              ))}
              {!v?.feed?.length && <tr><td colSpan={4} className="muted">{v?.hook ? "No buys yet." : "Buys appear here once the wallet book is filled and the Helius webhook is on."}</td></tr>}
            </tbody>
          </table>
        </div>
        <div>
          <div className="sc-h">Copying each class <span className="muted">· bought a minute after them, checked later</span></div>
          <table className="tbl">
            <thead><tr><th>Class</th><th>1h</th><th>6h</th><th>24h</th><th>2x+</th></tr></thead>
            <tbody>
              {(v?.classes || []).map((c) => (
                <tr key={c.cls}>
                  <td style={{ color: CLS_COL[c.cls] }}>{c.label}</td>
                  {[c.h1, c.h6, c.h24].map((h, i) => <td key={i} style={{ color: (h.avg ?? 0) > 0 ? "var(--rat)" : (h.avg ?? 0) < 0 ? "var(--dust)" : "var(--dim)" }}>{pc(h.avg)}{h.n ? <span className="tiny mute2"> {h.n}</span> : null}</td>)}
                  <td className="muted">{c.h24.x2}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="tiny muted mt">FOMO traders are only tracked when their own trades show a positive expected value: home-run hitters (rare but huge wins) or steady hands (frequent smaller wins). KOL wallets count as confirmed only with objective proof. Smart wallets are found on chain: they bought big before past breakouts.</div>
        </div>
      </div>
    </section>
  );
}
