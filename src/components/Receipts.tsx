"use client";
import Link from "next/link";
import { useState } from "react";
import { usePoll } from "./usePoll";
import Info from "./Info";
import { ago, short, solscanTx } from "./fmt";

type Seal = { hour: string; n: number; sha: string; memo: string; sig: string | null; at: number; wallet: string | null };
type Hour = { hour: string; lines: string[]; seal: Seal | null; chainMemo: string | null };

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function Verify({ s }: { s: Seal }) {
  const [st, setSt] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[] | null>(null);
  async function run() {
    setBusy(true);
    try {
      const h: Hour = await (await fetch(`/api/receipts?hour=${s.hour}&chain=1`)).json();
      const mine = await sha256(h.lines.join("\n"));
      const onChain = h.chainMemo ? /sha256=([0-9a-f]{64})/.exec(h.chainMemo)?.[1] : null;
      setLines(h.lines);
      if (!onChain) setSt({ ok: false, text: `hashed ${h.lines.length} calls: ${mine.slice(0, 12)}…, memo not readable right now (check it on Solscan)` });
      else setSt({ ok: mine === onChain, text: mine === onChain ? `match: your hash of ${h.lines.length} calls equals the memo on-chain` : `MISMATCH: ${mine.slice(0, 12)}… vs on-chain ${onChain.slice(0, 12)}…` });
    } catch {
      setSt({ ok: false, text: "could not load this hour" });
    }
    setBusy(false);
  }
  return (
    <>
      <button className="btn dim rc-btn" onClick={run} disabled={busy}>{busy ? "hashing…" : "verify"}</button>
      {st && (
        <div className="rc-res" style={{ color: st.ok ? "var(--rat)" : "var(--dust)" }}>
          {st.text}
          {lines && (
            <details>
              <summary>the {lines.length} calls (mint, King, score, nano, score, time)</summary>
              <pre>{lines.map((l) => {
                const [m] = l.split(",");
                return l.replace(m, short(m, 6, 6));
              }).join("\n")}</pre>
            </details>
          )}
        </div>
      )}
    </>
  );
}

export default function Receipts() {
  const d = usePoll<{ seals: Seal[] }>("/api/receipts", 30000).data;
  const seals = d?.seals || [];
  const total = seals.reduce((a, s) => a + s.n, 0);
  return (
    <>
      <section className="panel">
        <div className="ph"><span><Info k="receipts"><b>sealed hours</b></Info>{seals.length ? ` · ${total} calls in the last ${seals.length} hours` : ""}</span>{seals[0]?.wallet ? <a href={`https://solscan.io/account/${seals[0].wallet}`} target="_blank" rel="noreferrer">sealing wallet →</a> : null}</div>
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Hour (UTC)</th><th>Calls</th><th>SHA-256</th><th>On-chain</th><th /></tr></thead>
            <tbody>
              {seals.map((s) => (
                <tr key={s.hour}>
                  <td>{s.hour.replace("T", " ")}:00<div className="tiny mute2">sealed {ago(s.at)} ago</div></td>
                  <td>{s.n}</td>
                  <td className="muted"><code className="rc-sha">{s.sha.slice(0, 16)}…</code></td>
                  <td>{s.sig ? <a href={solscanTx(s.sig)} target="_blank" rel="noreferrer">{short(s.sig, 6, 6)}</a> : <span className="muted">no calls</span>}</td>
                  <td>{s.sig ? <Verify s={s} /> : null}</td>
                </tr>
              ))}
              {!seals.length && <tr><td colSpan={5} className="muted">{d ? "The first hour is sealed a few minutes after it ends." : "loading…"}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel mt">
        <div className="ph"><span><b>check it yourself</b></span></div>
        <div className="pb small rc-how">
          <p>1. Open an hour with <code>/api/receipts?hour=2026-10-06T19</code>. You get the list of calls, one per line: <code>mint,King verdict,score,nano verdict,score,call time</code>.</p>
          <p>2. Join the lines with a newline and hash them: <code>sha256</code>. No trailing newline.</p>
          <p>3. Open the transaction on Solscan. The memo says <code>RATNET calls &lt;hour&gt; n=&lt;calls&gt; sha256=&lt;hash&gt;</code>. Same hash, same calls.</p>
          <p className="muted">The memo is written minutes after the hour ends, long before a coin graduates or dies, so the King can't rewrite a call once it knows the outcome. Each call on its coin page links to its receipt. <Link href="/king">Every call →</Link></p>
        </div>
      </section>
    </>
  );
}
