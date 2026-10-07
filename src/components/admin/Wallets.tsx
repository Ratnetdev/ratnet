"use client";
// Admin: HOUND's wallet book. Add KOL wallets with proof, switch wallets off, see each wallet's copy record.
import { useState } from "react";
import { usePoll } from "../usePoll";
import { CLS_COL } from "../HoundBoard";

type Wl = { w: string; cls: string; name: string; handle?: string | null; conf: string; proof: string[]; src: string[]; stats?: any; sb?: any; off?: boolean; copy6h: { n: number; avg: number | null; x2: number } };
type V = { counts: Record<string, number>; wallets?: Wl[]; sources: Record<string, boolean>; hook: { n: number; at: number } | null; live: { text: string } | null };
const LABEL: Record<string, string> = { "fomo-homerun": "FOMO home-run", "fomo-steady": "FOMO steady", "fomo-top": "FOMO top", kol: "KOL", smart: "smart", admin: "admin" };

export default function Wallets() {
  const { data: v, reload } = usePoll<V>("/api/hound?full=1", 15000);
  const [f, setF] = useState({ w: "", name: "", handle: "", proof: "" });
  const [msg, setMsg] = useState("");
  const [cls, setCls] = useState("all");
  const post = async (body: any) => {
    const r = await fetch("/api/admin/wallets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "failed");
    return j;
  };
  const list = (v?.wallets || []).filter((x) => cls === "all" || x.cls.startsWith(cls));
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid g2">
        <div className="panel">
          <div className="ph"><span><b>add a wallet</b> · KOL or anyone worth watching</span></div>
          <div className="pb">
            <p className="tiny muted" style={{ marginTop: 0 }}>HOUND checks the proof itself: the on-chain SNS registry and whether their X account posted the address. Add a proof link (their post, profile, Solscan label) if you have one. Telegram works too: /wallet ADDRESS Name @handle link</p>
            <input className="input" placeholder="wallet address" value={f.w} onChange={(e) => setF({ ...f, w: e.target.value.trim() })} />
            <div className="grid g2" style={{ gap: 10 }}>
              <input className="input" placeholder="name shown on the site" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <input className="input" placeholder="X handle (no @)" value={f.handle} onChange={(e) => setF({ ...f, handle: e.target.value.trim() })} />
            </div>
            <input className="input" placeholder="proof link (optional)" value={f.proof} onChange={(e) => setF({ ...f, proof: e.target.value.trim() })} />
            <div className="fb-row">
              <button className="btn" onClick={async () => {
                setMsg("checking…");
                try {
                  const j = await post({ action: "add", ...f });
                  setMsg(`${j.wallet.name}: ${j.wallet.conf}. ${j.wallet.proof.join(" · ")}`);
                  setF({ w: "", name: "", handle: "", proof: "" });
                  reload();
                } catch (e: any) { setMsg(e.message); }
              }}>Add and check</button>
              <span className="tiny muted">{msg}</span>
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="ph"><span><b>sources</b></span></div>
          <div className="pb small">
            {Object.entries(v?.sources || {}).map(([k, on]) => <div key={k} className="row between"><span>{k}</span><span style={{ color: on ? "var(--rat)" : "var(--mute)" }}>{on ? "on" : "off (env var missing)"}</span></div>)}
            <div className="row between mt"><span>live webhook</span><span className="muted">{v?.hook ? `${v.hook.n} wallets` : "not set yet"}</span></div>
            <div className="tiny muted mt">{v?.live?.text || ""}</div>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="ph">
          <span><b>wallet book</b> · {v?.wallets?.length ?? 0}</span>
          <span className="strat-tabs">{["all", "fomo", "kol", "smart", "admin"].map((k) => <button key={k} className={cls === k ? "on" : ""} onClick={() => setCls(k)}>{k}</button>)}</span>
        </div>
        <div className="scroll" style={{ maxHeight: 640 }}>
          <table className="tbl">
            <thead><tr><th>Name</th><th>Class</th><th>Proof</th><th>Their record</th><th>Copying them, 6h</th><th></th></tr></thead>
            <tbody>
              {list.map((x) => (
                <tr key={x.w} style={x.off ? { opacity: 0.45 } : undefined}>
                  <td><a href={`https://solscan.io/account/${x.w}`} target="_blank" rel="noreferrer">{x.name}</a>{x.handle ? <a className="tiny muted" href={`https://x.com/${x.handle}`} target="_blank" rel="noreferrer"> @{x.handle}</a> : null}<div className="tiny mute2">{x.w.slice(0, 6)}…{x.w.slice(-4)}</div></td>
                  <td style={{ color: CLS_COL[x.cls] }}>{LABEL[x.cls] || x.cls}</td>
                  <td className="small" style={{ whiteSpace: "normal", maxWidth: 320 }}><b style={{ color: x.conf === "confirmed" ? "var(--rat)" : x.conf === "likely" ? "var(--watch)" : "var(--mute)" }}>{x.conf}</b><div className="tiny muted">{x.proof.slice(0, 3).join(" · ")}</div></td>
                  <td className="small muted" style={{ whiteSpace: "normal" }}>{x.stats ? `${Math.round(x.stats.wr * 100)}% win, avg +${Math.round(x.stats.avgWin * 100)}% / ${Math.round(x.stats.avgLoss * 100)}%, EV ${Math.round(x.stats.ev * 100)}%, ${x.stats.big} 10x+` : x.sb ? `${x.sb.n} breakouts, ${x.sb.sol} SOL in early, best ${x.sb.best}x` : "–"}</td>
                  <td style={{ color: (x.copy6h.avg ?? 0) > 0 ? "var(--rat)" : (x.copy6h.avg ?? 0) < 0 ? "var(--dust)" : "var(--dim)" }}>{x.copy6h.n ? `${x.copy6h.avg! > 0 ? "+" : ""}${x.copy6h.avg}% (${x.copy6h.n})` : "–"}</td>
                  <td><button className="fb-t" onClick={async () => { await post({ action: "set", w: x.w, off: !x.off }).catch(() => null); reload(); }}>{x.off ? "on" : "off"}</button></td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={6} className="muted">Empty. Add wallets above, set FOMO_API_KEY / MADEONSOL_API_KEY, and smart wallets appear as coins break out.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
