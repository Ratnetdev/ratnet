"use client";
import { useRef } from "react";
// MOMO on the desk: the pump.fun coins pulling the most volume right now, and which have the traction the desk buys.
import Link from "next/link";
import { usePoll } from "./usePoll";
import Info from "./Info";
import { ago , usdK } from "./fmt";
import { TradeIcons } from "./venues";
import CoinImg from "./CoinImg";

type Hot = { mint: string; symbol: string; ageMin: number; mc: number; liq: number; v5: number; v1h: number; buyers5: number; sellers5: number; ch5: number; ch1h: number; pass?: boolean; why?: string };
const age = (m: number) => (m < 120 ? `${m}m` : `${Math.round(m / 60)}h`);

export default function MomoBoard() {
  const box = useRef<HTMLElement>(null); // below the fold: no polling while off-screen
  const v = usePoll<{ at: number | null; hot: Hot[] }>("/api/momo", 15000, { ref: box }).data;
  return (
    <section className="panel mt" ref={box}>
      <div className="ph"><span><Info k="momo"><b>MOMO</b></Info> · pump.fun coins pulling real volume right now</span><span className="tiny muted">{v?.at ? `scanned ${ago(v.at)} ago` : "first scan within a minute"}</span></div>
      <div className="scroll" style={{ maxHeight: 420 }}>
        <table className="tbl">
          <thead><tr><th>Coin</th><th>Age</th><th>MC</th><th>Vol 5m</th><th>Vol 1h</th><th>Buyers / sellers 5m</th><th>5m / 1h</th><th>MOMO</th></tr></thead>
          <tbody>
            {(v?.hot || []).map((h) => (
              <tr key={h.mint}>
                <td><Link href={`/c/${h.mint}`} className="coin-a"><CoinImg mint={h.mint} sym={h.symbol} size={16} />${h.symbol}</Link><TradeIcons ca={h.mint} /></td>
                <td className="muted">{age(h.ageMin)}</td>
                <td>{usdK(h.mc)}</td>
                <td>{usdK(h.v5)}</td>
                <td className="muted">{usdK(h.v1h)}</td>
                <td><span style={{ color: h.buyers5 >= h.sellers5 ? "var(--rat)" : "var(--dust)" }}>{h.buyers5}</span> / {h.sellers5}</td>
                <td><span style={{ color: h.ch5 >= 0 ? "var(--rat)" : "var(--dust)" }}>{h.ch5 > 0 ? "+" : ""}{Math.round(h.ch5)}%</span> / <span style={{ color: h.ch1h >= 0 ? "var(--rat)" : "var(--dust)" }}>{h.ch1h > 0 ? "+" : ""}{Math.round(h.ch1h)}%</span></td>
                <td className="small" style={{ color: h.pass ? "var(--rat)" : "var(--mute)", whiteSpace: "normal" }}>{h.pass ? "traction: to the desk" : h.why}</td>
              </tr>
            ))}
            {!v?.hot?.length && <tr><td colSpan={8} className="muted">Waiting for the first scan.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
