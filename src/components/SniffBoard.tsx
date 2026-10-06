"use client";
import { useState } from "react";
import { usePoll } from "./usePoll";
import { burnFlow, useWallet, WalletButton } from "./Wallet";
import { ago, num, short } from "./fmt";

type Report = {
  id: string;
  ca: string;
  symbol: string;
  name: string;
  score: number | null;
  verdict: string;
  progress: number | null;
  mcapSol: number | null;
  complete: boolean;
  plus: string[];
  minus: string[];
  note: string;
  wallet: string;
  free: boolean;
  at: number;
  version: string;
};
type Live = { live: { mint: string } };

const color = (v: string) => (v === "BOND" || v === "BONDED" ? "var(--bond)" : v === "WATCH" ? "var(--watch)" : v === "DUST" ? "var(--dust)" : "var(--dim)");

export function ReportCard({ r }: { r: Report }) {
  return (
    <div className="report">
      <div className="row between wrapx" style={{ alignItems: "flex-end" }}>
        <div>
          <div className="tiny muted">RAT KING {r.version} · SNIFF REPORT</div>
          <div style={{ fontSize: 18, marginTop: 4 }}>
            <a href={`https://pump.fun/coin/${r.ca}`} target="_blank" rel="noreferrer">${r.symbol || "?"}</a>{" "}
            <span className="muted small">{r.name}</span>
          </div>
          <div className="tiny mute2">{r.ca}</div>
        </div>
        <div className="right">
          <div className="score" style={{ color: color(r.verdict) }}>{r.score ?? "–"}</div>
          <span className={`tag v-${r.verdict}`}>{r.verdict}</span>
        </div>
      </div>
      <div className="small mt">
        curve {r.progress ?? "–"}% · mcap {r.mcapSol != null ? `${num(Math.round(r.mcapSol))} ◎` : "–"}
      </div>
      <div className="grid g2 mt" style={{ gap: 10 }}>
        <div className="small">{r.plus.map((x) => <div key={x} className="green">+ {x}</div>)}</div>
        <div className="small">{r.minus.map((x) => <div key={x} style={{ color: "var(--dust)" }}>− {x}</div>)}</div>
      </div>
      <div className="tiny muted mt">{r.note}</div>
    </div>
  );
}

export default function SniffBoard() {
  const { address, signAndSend } = useWallet();
  const { data: live } = usePoll<Live>("/api/live", 20000);
  const { data: recent, reload } = usePoll<{ sniffs: Report[] }>("/api/sniff", 10000);
  const [ca, setCa] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [step, setStep] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const isLive = !!live?.live.mint;

  const go = async () => {
    setErr("");
    setReport(null);
    setBusy(true);
    try {
      const target = ca.trim();
      if (!isLive) {
        setStep("the king is sniffing…");
        const r = await fetch("/api/sniff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ca: target, wallet: address }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setReport(j.report);
      } else {
        const j = await burnFlow({ wallet: address, kind: "sniff", ca: target, signAndSend, verifyUrl: "/api/sniff", verifyBody: { ca: target }, onStep: setStep });
        setReport(j.report);
      }
      setStep("");
      reload();
    } catch (e: any) {
      setErr(e.message);
      setStep("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid g-main">
      <div className="grid" style={{ alignContent: "start" }}>
        <div className="panel glow">
          <div className="ph">
            <span><b>sniff order</b> · {isLive ? "burn 10K $RAT" : "free preview until launch"}</span>
            {isLive && <WalletButton />}
          </div>
          <div className="pb">
            <label className="l">Contract address</label>
            <input className="input" placeholder="paste any pump.fun CA" value={ca} onChange={(e) => setCa(e.target.value)} spellCheck={false} />
            <div className="row mt" style={{ gap: 12 }}>
              <button className="btn" disabled={busy || ca.trim().length < 32 || (isLive && !address)} onClick={go}>
                {busy ? "Sniffing…" : isLive ? "Burn & sniff" : "Sniff"}
              </button>
              <span className="muted small">{step}</span>
            </div>
            {err && <div className="err">{err}</div>}
          </div>
        </div>
        {report && <ReportCard r={report} />}
      </div>

      <div className="panel">
        <div className="ph"><span><b>recent sniffs</b> · public</span></div>
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Coin</th><th>Score</th><th>By</th><th>When</th></tr></thead>
            <tbody>
              {(recent?.sniffs || []).map((s) => (
                <tr key={s.id}>
                  <td><a href={`https://pump.fun/coin/${s.ca}`} target="_blank" rel="noreferrer">${s.symbol || short(s.ca)}</a></td>
                  <td><span style={{ color: color(s.verdict) }}>{s.score ?? "–"}</span> <span className={`tag v-${s.verdict}`}>{s.verdict}</span></td>
                  <td className="muted">{s.wallet ? short(s.wallet) : s.free ? "preview" : "–"}</td>
                  <td className="muted">{ago(s.at)}</td>
                </tr>
              ))}
              {!recent?.sniffs.length && <tr><td colSpan={4} className="muted">No sniffs yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
