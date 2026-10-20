"use client";
import { useEffect, useState } from "react";
import { usePoll } from "./usePoll";
import { useLive } from "./Live";
import { burnFlow, useWallet, WalletButton } from "./Wallet";
import { ago, num, short } from "./fmt";
import Info from "./Info";
import CoinImg from "./CoinImg";

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
  dev?: { n: number; b: number } | null;
  nano?: { score: number; verdict: string } | null;
  read?: string;
  live?: {
    at: number;
    who: { buys: number; buyers: number; buyersCapped: boolean; sol: number; fomo: number; earners: number; proven: number; bots: number; front: number } | null;
    good: string[];
    bad: string[];
    info: string[];
  } | null;
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
            <a href={`/c/${r.ca}`} className="coin-a"><CoinImg mint={r.ca} sym={r.symbol} size={16} />${r.symbol || "?"}</a>{" "}
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
        {r.dev ? ` · dev ${r.dev.n} prior, ${r.dev.b} bonded` : ""}
        {r.nano ? ` · nano ${r.nano.verdict} ${r.nano.score}` : ""}
      </div>
      <div className="grid g2 mt" style={{ gap: 10 }}>
        <div className="small">{r.plus.map((x) => <div key={x} className="green">+ {x}</div>)}</div>
        <div className="small">{r.minus.map((x) => <div key={x} style={{ color: "var(--dust)" }}>− {x}</div>)}</div>
      </div>
      {r.live && (
        <div className="mt">
          <div className="tiny muted">WHO IS BUYING · read live from the rats&apos; firehose</div>
          {r.live.who ? (
            <div className="row wrapx mt" style={{ gap: 14 }}>
              {([["FOMO traders", r.live.who.fomo], ["earners", r.live.who.earners], ["proven wallets", r.live.who.proven], ["callout front-runners", r.live.who.front], ["bots", r.live.who.bots]] as [string, number][]).map(([l, n]) => (
                <div key={l}><div style={{ fontSize: 18, color: l === "bots" ? (n ? "var(--dust)" : "var(--dim)") : n ? "var(--bond)" : "var(--dim)" }}>{n}</div><div className="tiny muted">{l}</div></div>
              ))}
              <div><div style={{ fontSize: 18 }}>{r.live.who.buyersCapped ? "300+" : r.live.who.buyers}</div><div className="tiny muted">buyers · {r.live.who.sol} ◎</div></div>
            </div>
          ) : (
            <div className="small muted mt">No buys seen by the rats (an older coin, or not traded since the worker started).</div>
          )}
          <div className="small mt">
            {r.live.good.map((x) => <div key={x} className="green">+ {x}</div>)}
            {r.live.bad.map((x) => <div key={x} style={{ color: "var(--dust)" }}>− {x}</div>)}
            {r.live.info.map((x) => <div key={x} className="muted">· {x}</div>)}
          </div>
        </div>
      )}
      {r.read && <div className="mt" style={{ fontSize: 15 }}>🐀 <b>{r.read}</b></div>}
      <div className="tiny muted mt">{r.note}</div>
    </div>
  );
}

type Msg = { who: "you" | "king"; text: string };
/** v0.1.133 ASK THE RAT KING: questions about the coin just checked, answered from that check only. */
export function AskKing({ ca }: { ca: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => setMsgs([]), [ca]);
  const send = async (text?: string) => {
    const question = (text ?? q).trim();
    if (!question || busy) return;
    setErr("");
    setBusy(true);
    const next: Msg[] = [...msgs, { who: "you", text: question }];
    setMsgs(next);
    setQ("");
    try {
      const r = await fetch("/api/check/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ca, q: question, hist: msgs }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setMsgs([...next, { who: "king", text: j.answer }]);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel">
      <div className="ph"><span><b>ask the rat king</b> · about this coin, from this check only</span></div>
      <div className="pb">
        {msgs.map((m, i) => (
          <div key={i} className="small" style={{ margin: "6px 0", color: m.who === "king" ? "var(--bond)" : undefined }}>
            <span className="tiny muted">{m.who === "king" ? "RAT KING" : "YOU"}</span>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
          </div>
        ))}
        {!msgs.length && (
          <div className="row wrapx" style={{ gap: 8 }}>
            {["Is this a rug?", "Who is really buying?", "What should I watch for?"].map((x) => (
              <button key={x} className="btn ghost small" disabled={busy} onClick={() => send(x)}>{x}</button>
            ))}
          </div>
        )}
        <div className="row mt" style={{ gap: 8 }}>
          <input className="input" placeholder="ask anything about this coin" value={q} maxLength={400} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
          <button className="btn" disabled={busy || !q.trim()} onClick={() => send()}>{busy ? "…" : "Ask"}</button>
        </div>
        {err && <div className="err">{err}</div>}
        <div className="tiny muted mt">Not financial advice. The King only knows what the check measured.</div>
      </div>
    </div>
  );
}

export default function SniffBoard() {
  const { address, signAndSend } = useWallet();
  // v0.1.47: the app-wide /api/live snapshot (it polled its own copy next to it)
  const live = useLive().data as Live | null;
  const { data: recent, reload } = usePoll<{ sniffs: Report[] }>("/api/sniff", 10000);
  const [ca, setCa] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [step, setStep] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const isLive = !!live?.live.mint;
  const liveKnown = !!live; // v0.1.100 (audit): until /api/live answers, the free path is not offered (after launch it is refused)
  const [autoGo, setAutoGo] = useState(false);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const ca = sp.get("ca");
    if (ca) setCa(ca);
    if (ca && sp.get("go") === "1") setAutoGo(true); // v0.1.134: from the extension's "Ask the Rat King"
  }, []);

  const go = async () => {
    setErr("");
    setReport(null);
    setBusy(true);
    try {
      const target = ca.trim();
      if (!isLive) {
        setStep("the king is sniffing and the rats are reading who bought…");
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

  useEffect(() => {
    if (!autoGo || !liveKnown || isLive || busy || ca.trim().length < 32) return;
    setAutoGo(false);
    go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGo, liveKnown, isLive, ca]);

  return (
    <section className="grid g-main">
      <div className="grid" style={{ alignContent: "start" }}>
        <div className="panel glow">
          <div className="ph">
            <span><Info k="t_sniff"><b>sniff order</b></Info> · {isLive ? "burn 10K $RAT" : "free preview until launch"}</span>
            {isLive && <WalletButton />}
          </div>
          <div className="pb">
            <label className="l">Contract address</label>
            <input className="input" placeholder="paste any pump.fun CA" value={ca} onChange={(e) => setCa(e.target.value)} spellCheck={false} />
            <div className="row mt" style={{ gap: 12 }}>
              <button className="btn" disabled={busy || !liveKnown || ca.trim().length < 32 || (isLive && !address)} onClick={go}>
                {busy ? "Sniffing…" : isLive ? "Burn & sniff" : "Sniff"}
              </button>
              <span className="muted small">{step}</span>
            </div>
            {err && <div className="err">{err}</div>}
          </div>
        </div>
        {report && <ReportCard r={report} />}
        {report && <AskKing ca={report.ca} />}
      </div>

      <div className="panel">
        <div className="ph"><span><Info k="t_rsniffs"><b>recent sniffs</b></Info> · public</span></div>
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Coin</th><th><Info k="score">Score</Info></th><th><Info k="by">By</Info></th><th>When</th></tr></thead>
            <tbody>
              {(recent?.sniffs || []).map((s) => (
                <tr key={s.id}>
                  <td><a href={`/c/${s.ca}`} className="coin-a"><CoinImg mint={s.ca} sym={s.symbol} size={16} />${s.symbol || short(s.ca)}</a></td>
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
