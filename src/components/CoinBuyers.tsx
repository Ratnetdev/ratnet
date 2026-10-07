"use client";
// The tracked wallets that bought this coin (HOUND), with names and their copy records.
import { usePoll } from "./usePoll";
import Info from "./Info";
import { ago } from "./fmt";
import { fullUrl, useAdmin } from "./useAdmin";
import { CLS_COL } from "./HoundBoard";

type B = { w: string; name: string; cls: string; conf: string; sol: number; at: number; copy6h: { n: number; avg: number | null } };
const LABEL: Record<string, string> = { "fomo-homerun": "FOMO home-run", "fomo-steady": "FOMO steady", "fomo-top": "FOMO top trader", kol: "KOL", smart: "smart wallet", admin: "added by admin" };

export default function CoinBuyers({ mint }: { mint: string }) {
  const admin = useAdmin();
  const d = usePoll<{ buyers: B[] }>(fullUrl(`/api/hound?mint=${mint}`, admin), 8000).data;
  if (!d?.buyers?.length) return null;
  return (
    <section className="panel mt">
      <div className="ph"><span><Info k="hound"><b>tracked wallets in this coin</b></Info></span><span className="tiny muted">{d.buyers.length}</span></div>
      <div className="scroll">
        <table className="tbl">
          <thead><tr><th>Who</th><th>Class</th><th>Bought</th><th>When</th><th>Copying them, 6h</th></tr></thead>
          <tbody>
            {d.buyers.map((b) => (
              <tr key={(b.w || b.name) + b.at}>
                <td>{b.w && admin ? <a href={`https://solscan.io/account/${b.w}`} target="_blank" rel="noreferrer">{b.name}</a> : b.name}{b.conf !== "confirmed" ? <span className="tiny mute2"> unconfirmed</span> : null}</td>
                <td style={{ color: CLS_COL[b.cls] }}>{LABEL[b.cls] || b.cls}</td>
                <td>{b.sol ? `${b.sol.toFixed(2)} SOL` : "–"}</td>
                <td className="muted">{ago(b.at)} ago</td>
                <td className="muted">{b.copy6h.n ? `${b.copy6h.avg! > 0 ? "+" : ""}${b.copy6h.avg}% over ${b.copy6h.n}` : "no record yet"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
