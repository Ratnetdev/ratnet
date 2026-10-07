"use client";
// Admin: OVERSEER's ideas (approve, reject, park), its exploring trail and what it found.
import { useState } from "react";
import { usePoll } from "../usePoll";
import { safeHref, ago } from "../fmt";

type Idea = { id: number; at: number; title: string; problem: string; proposal: string; impact: string; risk: string; effort: string; kind: string; sources: string[]; status: string; note?: string };
type V = { trail: { at: number; text: string; url: string | null }[]; finds: { src: string; title: string; url: string; at: number }[]; ideas: Idea[]; thinkAt: number | null; telegram: boolean; llm: boolean };

export default function Overseer() {
  const { data: v, reload } = usePoll<V>("/api/admin/overseer", 10000);
  const [msg, setMsg] = useState("");
  const [tab, setTab] = useState("new");
  const post = async (body: any) => {
    const r = await fetch("/api/admin/overseer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "failed");
    return j;
  };
  const ideas = (v?.ideas || []).filter((i) => tab === "all" || i.status === tab);
  return (
    <div className="grid g2" style={{ gap: 16, alignItems: "start" }}>
      <div className="panel">
        <div className="ph">
          <span><b>OVERSEER&apos;s ideas</b> · {v?.thinkAt ? `last thought ${ago(v.thinkAt)} ago` : "not yet"}</span>
          <span className="strat-tabs">{["new", "yes", "later", "no", "all"].map((k) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{k}</button>)}</span>
        </div>
        <div className="pb">
          <div className="fb-row" style={{ marginTop: 0, marginBottom: 10 }}>
            <button className="btn" onClick={async () => { setMsg("thinking… (up to a minute)"); try { const j = await post({ action: "think" }); setMsg(`${j.think ?? 0} ideas`); reload(); } catch (e: any) { setMsg(e.message); } }}>Ideas now</button>
            <span className="tiny muted">{msg} {v && !v.telegram ? "· Telegram off: set TELEGRAM_IDEAS_CHAT_ID" : ""}{v && !v.llm ? " · needs ANTHROPIC_API_KEY" : ""}</span>
          </div>
          {ideas.map((i) => (
            <div key={i.id} className="ov-idea">
              <h5>#{i.id} {i.title}<span className="ov-st">{i.kind}</span><span className="ov-st">{i.effort}</span><span className="ov-st" style={{ color: i.status === "yes" ? "var(--rat)" : i.status === "no" ? "var(--dust)" : "var(--watch)" }}>{i.status}</span></h5>
              <p><b>Data:</b> {i.problem}</p>
              <p><b>Change:</b> {i.proposal}</p>
              <p><b>Impact:</b> {i.impact} · <b>Risk:</b> {i.risk}</p>
              {i.sources.map((s) => <p key={s}><a href={safeHref(s)} target="_blank" rel="noreferrer">{s.slice(0, 70)}</a></p>)}
              {i.note ? <p><b>Your note:</b> {i.note}</p> : null}
              <div className="fb-row">
                {(["yes", "later", "no"] as const).map((s) => <button key={s} className={`fb-t ${i.status === s ? "on" : ""}`} onClick={async () => { const note = s === "no" ? prompt("Why not? (helps it learn)") || undefined : undefined; await post({ action: "decide", id: i.id, status: s, note }).catch(() => null); reload(); }}>{s}</button>)}
                <span className="tiny mute2">{ago(i.at)} ago</span>
              </div>
            </div>
          ))}
          {!ideas.length && <div className="muted small">Nothing here.</div>}
        </div>
      </div>
      <div className="grid" style={{ gap: 16 }}>
        <div className="panel">
          <div className="ph"><span><b>exploring</b> · live trail</span></div>
          <div className="pb ov-trail">
            {(v?.trail || []).map((t, k) => <div key={k}><span className="tiny mute2">{ago(t.at)}</span><span>{t.url ? <a href={safeHref(t.url)} target="_blank" rel="noreferrer">{t.text}</a> : t.text}</span></div>)}
          </div>
        </div>
        <div className="panel">
          <div className="ph"><span><b>found</b> · newest first, never read twice</span></div>
          <div className="pb ov-trail">
            {(v?.finds || []).map((f) => <div key={f.url}><span className="tiny mute2">{f.src}</span><a href={safeHref(f.url)} target="_blank" rel="noreferrer">{f.title}</a></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
