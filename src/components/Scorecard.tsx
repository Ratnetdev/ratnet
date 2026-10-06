"use client";
// Why the agents acted, in one place. Everyone sees the reasons in plain words and the LENS read. An admin also sees
// the numbers behind them (v0 points per rule, nano's strongest feature pulls) and can leave feedback.
import { useState } from "react";
import { useAdmin } from "./useAdmin";

export type Card = {
  plus: string[];
  minus: string[];
  parts?: Record<string, number> | null;
  nc?: [string, number][] | null;
  lens?: { score: number; flags: string[]; good: string[] } | null;
};

const PART: Record<string, [string, number]> = {
  curve: ["curve fill", 45],
  momentum: ["curve climb", 15],
  x: ["X linked", 8],
  website: ["website", 6],
  tg: ["Telegram", 4],
  desc: ["real description", 5],
  dev: ["dev buy size", 5],
  ticker: ["clean ticker", 4],
  name: ["clean name", 3],
  wire: ["tied to a tracked post", 8],
  pulse: ["rising narrative", 5],
  farm: ["farm penalty", -45],
};

export function lensCol(s: number) {
  return s >= 60 ? "var(--rat)" : s < 40 ? "var(--dust)" : "var(--watch)";
}

export default function Scorecard({ card, king, nano }: { card: Card | null | undefined; king?: { score: number; verdict: string } | null; nano?: { score: number; verdict: string } | null }) {
  const admin = useAdmin();
  if (!card) return null;
  const parts = card.parts ? Object.entries(card.parts) : [];
  const ncMax = Math.max(0.01, ...(card.nc || []).map((x) => Math.abs(x[1])));
  return (
    <section className="td-sec sc">
      <h4>Scorecard <span className="muted">why the agents liked it, and what counted against it</span></h4>
      <div className="sc-grid">
        <div>
          <div className="sc-h">Reasons {king ? <span className="muted">· King {king.verdict} {king.score}{nano ? ` · nano ${nano.verdict} ${nano.score}` : ""}</span> : null}</div>
          {card.plus.map((x) => <div key={x} className="sc-r plus"><i>+</i>{x}</div>)}
          {card.minus.map((x) => <div key={x} className="sc-r minus"><i>-</i>{x}</div>)}
          {!card.plus.length && !card.minus.length ? <div className="muted small">No reasons recorded.</div> : null}
        </div>
        <div>
          <div className="sc-h">LENS {card.lens ? <b style={{ color: lensCol(card.lens.score) }}>{card.lens.score}/100</b> : <span className="muted">· no look yet</span>}</div>
          {card.lens ? (
            <>
              {card.lens.good.map((x) => <div key={x} className="sc-r plus"><i>+</i>{x}</div>)}
              {card.lens.flags.map((x) => <div key={x} className="sc-r minus"><i>-</i>{x}</div>)}
            </>
          ) : (
            <div className="muted small">LENS opens the website, the X account, the search and the Telegram of the coins that matter. Its read lands here a minute or two after the buy.</div>
          )}
        </div>
      </div>
      {admin && (parts.length || card.nc?.length) ? (
        <div className="sc-grid sc-admin">
          {parts.length ? (
            <div>
              <div className="sc-h">King v0 points <span className="muted">admin</span></div>
              {parts.map(([k, v]) => {
                const [label, max] = PART[k] || [k, 10];
                return (
                  <div key={k} className="sc-bar">
                    <span>{label}</span>
                    <i><b style={{ width: `${Math.min(100, (Math.abs(v) / Math.abs(max || 1)) * 100)}%`, background: v < 0 ? "var(--dust)" : "var(--rat)" }} /></i>
                    <em style={{ color: v < 0 ? "var(--dust)" : undefined }}>{Math.round(v * 10) / 10}/{max}</em>
                  </div>
                );
              })}
            </div>
          ) : null}
          {card.nc?.length ? (
            <div>
              <div className="sc-h">nano pulls <span className="muted">admin · w×x on the logit</span></div>
              {card.nc.map(([k, v]) => (
                <div key={k} className="sc-bar">
                  <span>{k}</span>
                  <i><b style={{ width: `${(Math.abs(v) / ncMax) * 100}%`, background: v < 0 ? "var(--dust)" : "var(--rat)" }} /></i>
                  <em style={{ color: v < 0 ? "var(--dust)" : "var(--rat)" }}>{v > 0 ? "+" : ""}{v}</em>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const TAGS = ["no socials", "fake socials", "bought the top", "chased", "dumped coin", "bundled", "bot volume", "dev rug", "sold too early", "held too long", "good narrative", "good entry", "good exit", "should have bought"];

/** Admin only: tell the desk what it got right or wrong on this trade, call or skip. */
export function FeedbackBox({ mint, symbol, kind, refAt }: { mint: string; symbol: string; kind: "trade" | "call" | "skip"; refAt?: number | null }) {
  const admin = useAdmin();
  const [verdict, setVerdict] = useState<"good" | "bad" | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  if (!admin) return null;
  const send = async () => {
    if (!verdict) return setMsg("pick good or bad");
    setMsg("saving…");
    const r = await fetch("/api/admin/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mint, symbol, kind, ref: refAt ?? null, verdict, tags, note }) });
    setMsg(r.ok ? "saved" : "failed");
    if (r.ok) {
      setTags([]);
      setNote("");
      setVerdict(null);
    }
  };
  return (
    <section className="td-sec fb">
      <h4>Your feedback <span className="muted">admin only · shows up in the Strategy tab</span></h4>
      <div className="fb-row">
        <button className={`fb-v good ${verdict === "good" ? "on" : ""}`} onClick={() => setVerdict("good")}>good call</button>
        <button className={`fb-v bad ${verdict === "bad" ? "on" : ""}`} onClick={() => setVerdict("bad")}>bad call</button>
        {TAGS.map((t) => (
          <button key={t} className={`fb-t ${tags.includes(t) ? "on" : ""}`} onClick={() => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t])}>{t}</button>
        ))}
      </div>
      <div className="fb-row">
        <input className="input" placeholder="note: what should the agents have seen?" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        <button className="btn" onClick={send}>Save</button>
        <span className="tiny muted">{msg}</span>
      </div>
    </section>
  );
}
