"use client";
// Admin: King v1's calibration, MIND's lesson book (switch lessons on or off, teach it), and the KOL callers' records.
import { useState } from "react";
import { usePoll } from "../usePoll";

type Lesson = { id: string; text: string; src: string; at: number; uses: number; wins: number; losses: number; off?: boolean; score: number };
type Cal = { at: number; ready: boolean; n: number; pos: number; base: number; bond: number | null; watch: number | null; prec: number | null; recall: number | null; table: { lo: number; n: number; b: number }[] } | null;
type Caller = { h: string; tier: string; calls: number; callAvg: number | null; call2x: number; f?: number | null };

export function KingV1({ cal, honest }: { cal: Cal; honest: any }) {
  return (
    <div className="panel">
      <div className="ph"><span><b>King v1</b> · nano leads, lines set by the data</span><span className="tiny" style={{ color: cal?.ready ? "var(--rat)" : "var(--watch)" }}>{cal?.ready ? "live" : "warming up"}</span></div>
      <div className="pb small">
        {cal ? (
          <>
            <div>last 7 days: {cal.n.toLocaleString("en-US")} graded lessons, {cal.pos} bonds, base rate {cal.base}%</div>
            <div>BOND line <b className="green">{cal.bond ?? "–"}</b> · WATCH line <b style={{ color: "var(--watch)" }}>{cal.watch ?? "–"}</b> · at the BOND line {cal.prec ?? "–"}% bond, {cal.recall ?? "–"}% of all bonds caught</div>
            <table className="tbl mt">
              <thead><tr><th>nano score</th><th>lessons</th><th>bonded</th><th>rate</th></tr></thead>
              <tbody>
                {cal.table.filter((r) => r.n).reverse().map((r) => (
                  <tr key={r.lo} style={cal.bond != null && r.lo >= cal.bond ? { background: "rgba(140,255,90,.05)" } : undefined}>
                    <td>{r.lo}-{r.lo + 4}</td><td className="muted">{r.n}</td><td className="muted">{r.b}</td><td>{r.n ? `${Math.round((r.b / r.n) * 1000) / 10}%` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : <div className="muted">No graded lessons yet.</div>}
        <div className="sc-h mt">Honest scoreboard (graded at 2h)</div>
        <div>{honest ? `${honest.hit} of ${honest.n} BOND calls right (${honest.prec ?? "–"}%), ${honest.recall ?? "–"}% of ${honest.bonds} bonds caught` : "–"}</div>
        {(honest?.byVersion || []).map((x: any) => <div key={x.v} className="row between"><span>{x.v}</span><span className="muted">{x.hit}/{x.n} · {x.prec ?? "–"}%</span></div>)}
      </div>
    </div>
  );
}

export function Callers({ callers }: { callers: Caller[] }) {
  return (
    <div className="panel">
      <div className="ph"><span><b>KOL and trader calls</b> · every CA they post, graded 6 hours later</span></div>
      <div className="scroll" style={{ maxHeight: 380 }}>
        <table className="tbl">
          <thead><tr><th>Caller</th><th>Calls</th><th>Avg 6h</th><th>2x+</th></tr></thead>
          <tbody>
            {callers.map((c) => <tr key={c.h}><td><a href={`https://x.com/${c.h}`} target="_blank" rel="noreferrer">@{c.h}</a> <span className="tiny muted">{c.tier}</span></td><td className="muted">{c.calls}</td><td style={{ color: (c.callAvg ?? 0) > 0 ? "var(--rat)" : "var(--dust)" }}>{c.callAvg != null ? `${c.callAvg > 0 ? "+" : ""}${c.callAvg}%` : "–"}</td><td className="muted">{c.call2x}</td></tr>)}
            {!callers.length && <tr><td colSpan={4} className="muted">No graded calls yet. A call is graded 6 hours after a KOL, trader or 10k+ account posts a CA.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LessonBook({ on, model }: { on: boolean; model: string }) {
  const { data, reload } = usePoll<{ lessons: Lesson[] }>("/api/admin/mind", 30000);
  const [text, setText] = useState("");
  const [src, setSrc] = useState("");
  const [msg, setMsg] = useState("");
  const post = async (body: Record<string, unknown>) => {
    const r = await fetch("/api/admin/mind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "failed");
    return j;
  };
  const list = data?.lessons || [];
  return (
    <div className="panel">
      <div className="ph"><span><b>MIND&apos;s lesson book</b> · {list.filter((l) => !l.off).length} active</span><span className="tiny muted">{on ? model : "no model: add ANTHROPIC_API_KEY"}</span></div>
      <div className="pb">
        <div className="sc-h">Teach MIND</div>
        <p className="tiny muted" style={{ marginTop: 0 }}>Paste a thread, a YouTube transcript, notes from a trader or your own rules. MIND keeps up to 8 reusable lessons. They start with no record and are kept or dropped by results.</p>
        <textarea className="input" style={{ minHeight: 110, fontSize: 12 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. a coin that rides a tweet from a 1M+ account in the first 2 minutes..." />
        <div className="fb-row">
          <input className="input" value={src} onChange={(e) => setSrc(e.target.value)} placeholder="source (e.g. @orangie, a video title)" />
          <button className="btn" onClick={async () => {
            setMsg("reading…");
            try {
              const j = await post({ action: "teach", text, src: src || "admin" });
              setMsg(`${j.added.length} lesson${j.added.length === 1 ? "" : "s"} added`);
              setText("");
              reload();
            } catch (e: any) { setMsg(e.message); }
          }}>Teach</button>
          <span className="tiny muted">{msg}</span>
        </div>
        <div className="sc-h mt">Lessons <span className="muted">· record = times it pointed the right way vs the wrong way in post-mortems</span></div>
        <div className="scroll" style={{ maxHeight: 520 }}>
          {list.map((l) => (
            <div key={l.id} className={`les-row ${l.off ? "off" : ""}`}>
              <b style={{ color: l.wins + l.losses < 3 ? "var(--mute)" : l.score >= 60 ? "var(--rat)" : l.score < 40 ? "var(--dust)" : "var(--watch)" }}>{l.wins}-{l.losses}</b>
              <span>{l.text}</span>
              <span className="tiny muted src">{l.src} · used {l.uses}</span>
              <button onClick={async () => { await post({ action: "lesson", id: l.id, off: !l.off }).catch(() => null); reload(); }}>{l.off ? "on" : "off"}</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
