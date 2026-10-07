"use client";
import Link from "next/link";
import { usePoll } from "./usePoll";
import Info from "./Info";
import { TradeIcons } from "./venues";
import { VerdictTag } from "./Calls";
import { usdK } from "./Grads";
import { ago } from "./fmt";
import CoinImg from "./CoinImg";

type View = { mint: string; symbol: string; pk: number; pkAt?: number; now?: number; cUsd?: number | null; x: number | null; verdict?: string | null; bondedAt: number | null; createdAt: number };
type Model = { n: number; ready: boolean; ladder: { from: number; to: number; n: number; up: number; rate: number | null }[]; following: { curve: number; bonded: number }; log: { at: number; text: string }[] };

/** Coins after the call and after bond: how far they ran from where the King would have bought. */
export default function Runners({ limit = 15 }: { limit?: number }) {
  const { data } = usePoll<{ top: View[]; model: Model }>("/api/runners", 15000);
  const top = (data?.top || []).slice(0, limit);
  return (
    <div className="panel">
      <div className="ph">
        <span><b>runners</b> · <Info k="runners">peak after the call, 7 days</Info></span>
        <span className="tiny muted">{data ? `following ${data.model.following.curve + data.model.following.bonded}` : "…"}</span>
      </div>
      <div className="scroll">
        <table className="tbl">
          <thead><tr><th>Coin</th><th><Info k="king">King</Info></th><th><Info k="atcall">At call</Info></th><th><Info k="peak">Peak</Info></th><th><Info k="fromcall">x</Info></th><th><Info k="now">Now</Info></th><th><Info k="rbonded">Bonded</Info></th></tr></thead>
          <tbody>
            {top.map((v) => (
              <tr key={v.mint}>
                <td><Link href={`/c/${v.mint}`} className="coin-a"><CoinImg mint={v.mint} sym={v.symbol} size={16} />${v.symbol}</Link><TradeIcons ca={v.mint} /></td>
                <td>{v.verdict ? <VerdictTag v={v.verdict} /> : <span className="tiny mute2">–</span>}</td>
                <td className="muted">{usdK(v.cUsd)}</td>
                <td>{usdK(v.pk)}</td>
                <td style={{ color: (v.x ?? 0) >= 10 ? "var(--bond)" : (v.x ?? 0) >= 2 ? "var(--rat)" : "var(--dim)" }}>{v.x ? `${v.x}x` : "–"}</td>
                <td className="muted">{usdK(v.now)}</td>
                <td className="muted">{v.bondedAt ? ago(v.bondedAt) : "on curve"}</td>
              </tr>
            ))}
            {!top.length && <tr><td colSpan={7} className="muted">The rats start following coins at the King's call. Runs show up here as they climb.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The milestone ladder the runner model learns from. */
export function Ladder() {
  const { data } = usePoll<{ top: View[]; model: Model }>("/api/runners", 30000);
  const m = data?.model;
  return (
    <div className="panel">
      <div className="ph"><span><b>runner model</b> · <Info k="pnext">P(next milestone)</Info></span><span className="tiny muted">{m ? `${m.n} lessons${m.ready ? "" : ", base rates until 150"}` : "…"}</span></div>
      <div className="scroll">
        <table className="tbl">
          <thead><tr><th><Info k="rfrom">From</Info></th><th><Info k="rto">To</Info></th><th><Info k="reached">Reached</Info></th><th><Info k="seen">Seen</Info></th></tr></thead>
          <tbody>
            {(m?.ladder || []).map((l) => (
              <tr key={l.from}>
                <td>{usdK(l.from)}</td>
                <td>{usdK(l.to)}</td>
                <td style={{ color: "var(--rat)" }}>{l.rate != null ? `${l.rate}%` : "–"}</td>
                <td className="muted">{l.up}/{l.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!!m?.log?.length && (
        <div className="pb tiny muted">{m.log.slice(0, 4).map((l) => <div key={l.at + l.text}>{ago(l.at)} · {l.text}</div>)}</div>
      )}
    </div>
  );
}
