"use client";
// Admin Strategy tab: the agents' whole knowledge base on one page. Never shown to the public.
import Link from "next/link";
import { usePoll } from "../usePoll";
import { ago } from "../fmt";
import { Callers, KingV1, LessonBook } from "./MindAdmin";

type Prior = { key: string; on: boolean; what: string; n: number; need: number; skippedAvg?: number | null; boughtAvg?: number | null; saved?: number };
type S = {
  cfg: Record<string, any>;
  exam: Record<string, number>;
  rules: Record<string, number>;
  priors: Prior[];
  picker: { n: number; right: number; weights: { key: string; label: string; w: number; prior: number }[] };
  profiles: Record<string, { n: number; medPk: number; medTtp: number; initials: number | null; timeStop: number | null }>;
  learned: { trailBy: Record<string, number>; trailK: number; reviews: number; early: number; late: number; good: number; stalkOn: boolean; stalkArm: number; earlyOn: boolean; earlyStat: { n: number; hit: number; mainN: number; mainHit: number }; arms: { arm: number; n: number; fills: number; mean: number | null }[]; shadows: number; reviewing: number };
  king: { version: string; verdicts: { bond: number; watch: number }; rules: { key: string; label: string; max: number }[]; cal: any; honest: any };
  mind: { on: boolean; model: string; record: { verdict: string; n: number; h: { k: string; n: number; avg: number | null; up: number | null; x2: number }[] }[]; unlock: { ok: boolean; n: number; mean: number; up: number } };
  nano: { n: number; pos: number; loss: number; min: number; weights: { key: string; label: string; w: number }[] };
  film: { pending: number; rules: { rule: string; m30: any; h2: { n: number; right: number; wrong: number; avg: number | null }; d1: any; verdict: string }[]; against: { reason: string; n: number; wrong: number; rate: number }[]; forR: { reason: string; n: number; held: number; rate: number }[] } | null;
  pm: { sleeve: string; trades: number; wins: number; winRate: number | null; avg: number | null; w: number; paused: number | null }[] | null;
  coach: { pending: number; horizons: { k: string; n: number; avg: number | null; up2: number; dn50: number }[]; reasons: { why: string; n: number }[] } | null;
  wire: { callers: any[]; accounts: { h: string; cat: string; tier: string; tweets: number; matches: number; picks: number; runs: number; pnl: number; w: number }[] } | null;
  lens: { priority: Record<string, number>; perHour: number };
  feedback: { good: number; bad: number; tags: { verdict: string; tag: string; n: number }[]; recent: { id: string; mint: string; symbol: string; kind: string; at: number; verdict: string; tags: string[]; note: string }[] };
};

const CFG: [string, string, (c: any) => string][] = [
  ["mode", "off, paper, auto or live", (c) => c.mode],
  ["needNano", "entry needs nano to agree", (c) => String(!!c.needNano)],
  ["minCurve / maxCurve", "curve window for a buy", (c) => `${c.minCurve}% .. ${c.maxCurve}%`],
  ["serialDev", "launches with 0 bonds that mark a serial dev", (c) => String(c.serialDev)],
  ["maxDevBuy", "biggest dev buy allowed", (c) => `${c.maxDevBuy} SOL`],
  ["maxBundle", "biggest bundle share of SOL in", (c) => `${c.maxBundle}%`],
  ["minFlow", "minimum buy share in FLOW", (c) => `${Math.round((c.minFlow ?? 0) * 100)}%`],
  ["maxChase", "never buy more than this over the call", (c) => `+${c.maxChase}%`],
  ["sizePct", "size per trade", (c) => `${c.sizePct}% (${c.minSol}..${c.maxSol} SOL)`],
  ["maxImpact", "max price impact on the curve", (c) => `${c.maxImpact ?? 6}%`],
  ["sl", "stop loss before initials", (c) => `${c.sl}%`],
  ["initials", "take initials", (c) => `+${c.initialsAt}%: sell ${Math.round((c.initialsFrac ?? 0) * 100)}%`],
  ["moonbag", "share only the trail sells", (c) => `${Math.round((c.moonbag ?? 0) * 100)}%`],
  ["trail", "trailing stop at <3x / 3-10x / 10-30x / 30x+", (c) => (c.trail || []).join(" / ") + "%"],
  ["ladderBelow", "ladder out when P(next milestone) is below", (c) => `${Math.round((c.ladderBelow ?? 0) * 100)}%`],
  ["devExit / insiderExit", "dev or insiders sold this much", (c) => `${c.devExit}% / ${c.insiderExit}%`],
  ["gradKeepP", "keep a runner bag at migration if P(next) is at least", (c) => `${Math.round((c.gradKeepP ?? 0) * 100)}%`],
  ["timeStop", "time stop before initials", (c) => `${c.timeStop}m`],
  ["maxOpen", "King and early slots", (c) => String(c.maxOpen)],
  ["dailyLoss", "daily loss limit (ghost desk takes over)", (c) => `-${c.dailyLoss}%`],
  ["mindMode / mindMin / mindMaxOpen", "MIND: auto (trades once its record earns it), on, off · conviction needed · slots", (c) => `${c.mindMode ?? "auto"} / ${c.mindMin ?? 75} / ${c.mindMaxOpen ?? 2}`],
  ["mindMinPoolSol", "MIND on migrated coins: SOL in the pool needed", (c) => `${c.mindMinPoolSol ?? 20} SOL`],
  ["wireMinW / wireMaxOpen / wireMaxCurve", "tweet coins: trust line, slots, curve cap", (c) => `${c.wireMinW ?? 0.2} / ${c.wireMaxOpen ?? 2} / ${c.wireMaxCurve ?? 85}%`],
];

const pc = (n: number | null | undefined) => (n == null ? "–" : `${n > 0 ? "+" : ""}${n}%`);
const c = (n: number | null | undefined) => ((n ?? 0) > 0 ? "var(--rat)" : (n ?? 0) < 0 ? "var(--dust)" : "var(--dim)");

export default function Strategy() {
  const { data: s, error } = usePoll<S>("/api/admin/strategy", 15000);
  if (error) return <div className="panel"><div className="pb err">{error}</div></div>;
  if (!s) return <p className="muted">Loading the playbook…</p>;
  const wMax = Math.max(0.01, ...s.nano.weights.map((w) => Math.abs(w.w)));
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid g2">
        <LessonBook on={s.mind.on} model={s.mind.model} />
        <div className="grid" style={{ alignContent: "start", gap: 16 }}>
          <div className="panel">
            <div className="ph"><span><b>MIND&apos;s record</b> · {s.mind.unlock.ok ? "SEND calls trade" : "on record only"}</span></div>
            <div className="scroll">
              <table className="tbl">
                <thead><tr><th>Call</th><th>n</th><th>15m</th><th>1h</th><th>6h</th><th>24h</th><th>2x+ at 24h</th></tr></thead>
                <tbody>{s.mind.record.map((r) => <tr key={r.verdict}><td>{r.verdict}</td><td className="muted">{r.n}</td>{r.h.map((h) => <td key={h.k} style={{ color: c(h.avg) }}>{pc(h.avg)}</td>)}<td className="muted">{r.h[3]?.x2 ?? 0}</td></tr>)}</tbody>
              </table>
            </div>
            <div className="pb tiny muted">Unlock: 20+ SEND calls graded at 6h, average +15% or better, 40%+ of them up. Now {s.mind.unlock.n} graded, {pc(s.mind.unlock.mean)} avg, {s.mind.unlock.up}% up. Force it in the desk JSON: &quot;mindMode&quot;: &quot;on&quot; (or &quot;off&quot;).</div>
          </div>
          <KingV1 cal={s.king.cal} honest={s.king.honest} />
        </div>
      </div>

      <div className="grid g2">
        <Callers callers={s.wire?.callers || []} />
        <div className="panel">
          <div className="ph"><span><b>WIRE picker</b> · which copy of a post to buy, learned</span><span className="tiny muted">right on {s.picker.right} of {s.picker.n} posts</span></div>
          <div className="pb">
            {s.picker.weights.map((w) => (
              <div key={w.key} className="sc-bar">
                <span>{w.label}</span>
                <i><b style={{ width: `${Math.min(100, Math.abs(w.w) * 50)}%`, background: w.w < 0 ? "var(--dust)" : "var(--rat)" }} /></i>
                <em style={{ color: c(w.w) }}>{w.w > 0 ? "+" : ""}{w.w}{w.w !== w.prior ? <span className="mute2"> ({w.prior})</span> : null}</em>
              </div>
            ))}
            <div className="tiny muted mt">Starts from your hint (volume, spread holders, first out) in brackets. Two hours after each post it checks which copy went furthest and moves the weights toward it. Vamps: for 30 minutes after a pick, a copy that pulls 25%+ more SOL, faster, on a post with 4+ coins and 40+ SOL is picked too (max 2), in its own sleeve.</div>
            <div className="sc-h mt">Exit profile per strategy <span className="muted">· from its own closed trades (real and ghost)</span></div>
            <table className="tbl">
              <thead><tr><th>Sleeve</th><th>Trades</th><th>Typical peak</th><th>Peak after</th><th>Initials</th><th>Time stop</th><th>Trail</th></tr></thead>
              <tbody>{Object.entries(s.profiles).map(([k, p]) => <tr key={k}><td>{k}</td><td className="muted">{p.n}</td><td>{p.medPk}x</td><td className="muted">{p.medTtp}m</td><td className="green">{p.initials != null ? `+${p.initials}%` : "default"}</td><td className="green">{p.timeStop != null ? `${p.timeStop}m` : "default"}</td><td>{(s.learned.trailBy[k] ?? s.learned.trailK).toFixed(2)}x</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="ph"><span><b>priors</b> · starting hints from you, kept or dropped by COACH</span></div>
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Prior</th><th>Status</th><th>What it does</th><th>Reviewed</th><th>Skipped coins, 30m</th><th>Bought coins, 30m</th></tr></thead>
            <tbody>
              {s.priors.map((p) => (
                <tr key={p.key}>
                  <td>{p.key}</td>
                  <td style={{ color: p.on ? "var(--rat)" : "var(--mute)" }}>{p.on ? "on" : p.key === "dev_exit" ? "off" : "overruled"}</td>
                  <td className="small" style={{ whiteSpace: "normal" }}>{p.what}</td>
                  <td className="muted">{p.n}/{p.need}{p.saved != null ? ` · ${p.saved} favour selling` : ""}</td>
                  <td style={{ color: c(p.skippedAvg) }}>{pc(p.skippedAvg)}</td>
                  <td style={{ color: c(p.boughtAvg) }}>{pc(p.boughtAvg)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pb tiny muted">A prior is overruled when the coins it skipped beat the coins bought by {Math.round((s.rules.floorEdge ?? 0.05) * 100)}%+ over enough cases. It comes back on by itself when that flips.</div>
      </div>

      <div className="grid g2">
        <div className="panel">
          <div className="ph"><span><b>desk rules</b> · edit them in the desk JSON on the settings tab</span></div>
          <div className="scroll">
            <table className="tbl" style={{ tableLayout: "fixed" }}>
              <colgroup><col style={{ width: "32%" }} /><col style={{ width: "44%" }} /><col style={{ width: "24%" }} /></colgroup>
              <tbody>{CFG.map(([k, what, f]) => <tr key={k}><td style={{ whiteSpace: "normal", wordBreak: "break-word" }}>{k}</td><td className="small muted" style={{ whiteSpace: "normal" }}>{what}</td><td className="green" style={{ whiteSpace: "normal" }}>{f(s.cfg)}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <div className="ph"><span><b>what the desk learned</b></span></div>
          <div className="pb small">
            <div>trail scale <b className="green">{s.learned.trailK.toFixed(2)}x</b> · {s.learned.reviews} exits reviewed: {s.learned.early} too early, {s.learned.late} too late, {s.learned.good} right</div>
            <div>pullback entries <b style={{ color: s.learned.stalkOn ? "var(--rat)" : "var(--mute)" }}>{s.learned.stalkOn ? `on at -${s.learned.stalkArm}%` : "locked"}</b> (need {s.rules.stalkMin} shadows, +{Math.round(s.rules.stalkEdge * 100)}% edge)</div>
            <div>minute-1 entries <b style={{ color: s.learned.earlyOn ? "var(--rat)" : "var(--mute)" }}>{s.learned.earlyOn ? "on" : "locked"}</b> · {s.learned.earlyStat.n}/{s.rules.earlyMin} reads, {s.learned.earlyStat.n ? Math.round((s.learned.earlyStat.hit / s.learned.earlyStat.n) * 100) : 0}% vs King {s.learned.earlyStat.mainN ? Math.round((s.learned.earlyStat.mainHit / s.learned.earlyStat.mainN) * 100) : 0}%</div>
            <div>{s.learned.shadows} signals in shadow · {s.learned.reviewing} exits under review</div>
            <table className="tbl mt">
              <thead><tr><th>Entry arm</th><th>Signals</th><th>Filled</th><th>Mean 30m</th></tr></thead>
              <tbody>{s.learned.arms.map((a) => <tr key={a.arm}><td>{a.arm ? `wait for -${a.arm}%` : "buy now"}</td><td className="muted">{a.n}</td><td className="muted">{a.n ? `${Math.round((a.fills / a.n) * 100)}%` : "–"}</td><td style={{ color: c(a.mean) }}>{pc(a.mean)}</td></tr>)}</tbody>
            </table>
            <div className="tiny muted mt">Exam to go live: {s.exam.trades} trades, {s.exam.winRate}% win rate, +{s.exam.pnlPct}% P&amp;L, max drawdown {s.exam.maxDD}% over the last {s.exam.trades} trades, {s.exam.minWallet}+ SOL in the wallet.</div>
          </div>
        </div>
      </div>

      <div className="grid g2">
        <div className="panel">
          <div className="ph"><span><b>King {s.king.version}</b> · BOND at {s.king.verdicts.bond}+, WATCH at {s.king.verdicts.watch}+</span></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Rule</th><th>Points</th></tr></thead>
              <tbody>{s.king.rules.map((r) => <tr key={r.key}><td className="small" style={{ whiteSpace: "normal" }}>{r.label}</td><td style={{ color: r.max < 0 ? "var(--dust)" : "var(--rat)" }}>{r.max > 0 ? "+" : ""}{r.max}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <div className="ph"><span><b>nano weights</b> · {s.nano.n} samples, {s.nano.pos} bonds, loss {s.nano.loss.toFixed(3)}{s.nano.n < s.nano.min ? ` · counts from ${s.nano.min}` : ""}</span></div>
          <div className="pb">
            {s.nano.weights.slice(0, 22).map((w) => (
              <div key={w.key} className="sc-bar">
                <span>{w.label}</span>
                <i><b style={{ width: `${(Math.abs(w.w) / wMax) * 100}%`, background: w.w < 0 ? "var(--dust)" : "var(--rat)" }} /></i>
                <em style={{ color: c(w.w) }}>{w.w > 0 ? "+" : ""}{w.w}</em>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid g2">
        <div className="panel">
          <div className="ph"><span><b>FILM</b> · every skip rule, graded 2 hours later</span><span className="tiny muted">{s.film?.pending ?? 0} queued</span></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Rule</th><th>Reviewed</th><th>Right</th><th>Missed a run</th><th>Avg 2h</th><th>Verdict</th></tr></thead>
              <tbody>
                {(s.film?.rules || []).map((r) => (
                  <tr key={r.rule}>
                    <td>{r.rule.replace(/_/g, " ")}</td>
                    <td className="muted">{r.h2.n}</td>
                    <td className="muted">{r.h2.n ? `${Math.round((r.h2.right / r.h2.n) * 100)}%` : "–"}</td>
                    <td className="muted">{r.h2.n ? `${Math.round((r.h2.wrong / r.h2.n) * 100)}%` : "–"}</td>
                    <td style={{ color: (r.h2.avg ?? 0) > 0 ? "var(--dust)" : "var(--rat)" }}>{pc(r.h2.avg)}</td>
                    <td style={{ color: r.verdict === "costing" ? "var(--dust)" : r.verdict === "saving" ? "var(--rat)" : "var(--dim)" }}>{r.verdict}</td>
                  </tr>
                ))}
                {!s.film?.rules?.length && <tr><td colSpan={6} className="muted">No reviews yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="pb small">
            <div className="sc-h">King reasons against, and how often they were wrong</div>
            {(s.film?.against || []).slice(0, 10).map((a) => <div key={a.reason} className="row between"><span>{a.reason}</span><span className="muted">{a.wrong}/{a.n} bonded anyway</span></div>)}
          </div>
        </div>
        <div className="panel">
          <div className="ph"><span><b>PM sleeves</b> and <b>COACH</b></span></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Sleeve</th><th>Trades</th><th>Win</th><th>Avg</th><th>Size</th><th>Status</th></tr></thead>
              <tbody>{(s.pm || []).map((p) => <tr key={p.sleeve}><td>{p.sleeve}</td><td className="muted">{p.trades}</td><td className="muted">{p.winRate != null ? `${p.winRate}%` : "–"}</td><td style={{ color: c(p.avg) }}>{pc(p.avg)}</td><td>{p.w}x</td><td className="muted">{p.paused && p.paused > Date.now() ? "paused" : "on"}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="pb small">
            <div className="sc-h">After we sell: where coins went</div>
            {(s.coach?.horizons || []).map((h) => <div key={h.k} className="row between"><span>{h.k}</span><span className="muted">{h.n} checked · avg {pc(h.avg)} · {h.up2} doubled · {h.dn50} halved</span></div>)}
            <div className="sc-h mt">What moved them</div>
            {(s.coach?.reasons || []).slice(0, 8).map((r) => <div key={r.why} className="row between"><span>{r.why}</span><span className="muted">{r.n}</span></div>)}
          </div>
        </div>
      </div>

      <div className="grid g2">
        <div className="panel">
          <div className="ph"><span><b>your feedback</b> · {s.feedback.good} good · {s.feedback.bad} bad</span></div>
          <div className="pb small">
            <div className="sc-h">Tags that keep coming back</div>
            {s.feedback.tags.slice(0, 14).map((t) => <div key={t.verdict + t.tag} className="row between"><span style={{ color: t.verdict === "good" ? "var(--rat)" : "var(--dust)" }}>{t.verdict} · {t.tag}</span><span className="muted">{t.n}</span></div>)}
            {!s.feedback.tags.length && <div className="muted">Open any trade (desk track record or a coin page) while signed in to admin and leave feedback. It lands here.</div>}
            <div className="sc-h mt">Latest</div>
            {s.feedback.recent.slice(0, 15).map((f) => (
              <div key={f.id} className="cd-ev">
                <span className="ap-t">{ago(f.at)}</span>
                <Link href={`/c/${f.mint}`} style={{ color: f.verdict === "good" ? "var(--rat)" : "var(--dust)" }}>${f.symbol || f.mint.slice(0, 4)}</Link>
                <span>{f.kind}{f.tags.length ? ` · ${f.tags.join(", ")}` : ""}{f.note ? ` · ${f.note}` : ""}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="ph"><span><b>WIRE accounts</b> · trust earned from what their posts did</span><span className="tiny muted">LENS: {s.lens.perHour}/hour, order {Object.entries(s.lens.priority).sort((a, b) => b[1] - a[1]).map(([k]) => k).join(" > ")}</span></div>
          <div className="scroll" style={{ maxHeight: 420 }}>
            <table className="tbl">
              <thead><tr><th>Account</th><th>Trust</th><th>Posts</th><th>Picks</th><th>Runs</th><th>P&amp;L</th></tr></thead>
              <tbody>{(s.wire?.accounts || []).map((a) => <tr key={a.h}><td><a href={`https://x.com/${a.h}`} target="_blank" rel="noreferrer">@{a.h}</a> <span className="tiny muted">{a.tier}</span></td><td className="green">{a.w}</td><td className="muted">{a.tweets}</td><td className="muted">{a.picks}</td><td className="muted">{a.runs}</td><td style={{ color: c(a.pnl) }}>{a.pnl ? a.pnl.toFixed(3) : "–"}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
