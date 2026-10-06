"use client";
import Link from "next/link";
import { usePoll } from "./usePoll";
import DenScene, { AGENT_COLOR } from "./DenScene";
import Info from "./Info";
import CountUp from "./CountUp";
import { ago, short, solscanAcc, solscanTx } from "./fmt";

type Ev = { agent: string; at: number; mint?: string; symbol?: string; text: string; tone: string };
type Sample = [number, number, number];
type Pos = { mint: string; symbol: string; openedAt: number; entryPx: number; costSol: number; tokens: number; tokens0: number; lastPx: number; peakPx: number; tp1Done: boolean; king: number; nano: number | null; live: boolean; series: Sample[]; how?: string; pn?: number; trail?: number; usd?: number; ins?: number | null; dev?: number | null; nWatch?: number };
type Learn = {
  trailK: number;
  reviews: number;
  early: number;
  late: number;
  good: number;
  arms: { arm: number; n: number; fills: number; mean: number | null }[];
  stalkOn: boolean;
  stalkArm: number;
  earlyOn: boolean;
  earlyStat: { n: number; hit: number; mainN: number; mainHit: number };
  shadows: number;
  reviewing: number;
  rules: { stalkMin: number; stalkEdge: number; earlyMin: number; shadowMins: number; coachHours: number };
  xConnected: boolean;
};
type Stalk = { mint: string; symbol: string; at: number; depth: number; hi: number; lo: number; armed: boolean };
type Trade = { id: string; mint: string; symbol: string; side: string; at: number; sol: number; reason: string; pnlSol?: number; pnlPct?: number; live: boolean; sig?: string };
type Desk = {
  mode: string;
  live: boolean;
  wallet: string | null;
  walletSol?: number | null;
  walletReady: boolean;
  cfg: Record<string, any>;
  state: { start: number; equity: number; realized: number; closed: number; wins: number; dayStart: number; maxDD: number; promotedAt: number | null; liveStart: number | null; demotions: number };
  exam: { checks: { label: string; need: string; now: string; ok: boolean }[]; passed: boolean };
  positions: Pos[];
  trades: Trade[];
  events: Ev[];
  equity: { t: number; eq: number; live: boolean }[];
  agents: Record<string, Ev>;
  vet: { symbol: string; at: number; checks: { rule: string; ok: boolean; v: string }[] } | null;
  stalks?: Stalk[];
  learn?: Learn;
};
const usdK = (n?: number) => (!n ? "–" : n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `$${Math.round(n / 1000)}K`);

const ROLES: [string, string][] = [
  ["HISTORIAN", "replays past launches, trains the models"],
  ["SCOUT", "digs every launch, early read at 1m"],
  ["KING", "calls it at minute 5"],
  ["TAPE", "reads every trade on the curve"],
  ["GRAPH", "dev funding, smart wallets"],
  ["VET", "checks dev, bundles, curve"],
  ["FLOW", "reads buy/sell pressure"],
  ["BUZZ", "X mentions, paid dex"],
  ["SIZE", "decides how much"],
  ["EXEC", "buys and sells"],
  ["RISK", "initials, ladder, trail"],
  ["COACH", "reviews every exit, entry"],
  ["LEDGER", "keeps the books"],
];
const TONE: Record<string, string> = { ok: "var(--rat)", bad: "var(--dust)", info: "var(--dim)", win: "var(--bond)", loss: "var(--dust)" };
const pct = (a: number, b: number) => (b ? ((a - b) / b) * 100 : 0);
const sign = (n: number, d = 1) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;

function Spark({ s, entry, w = 90, h = 24 }: { s: Sample[]; entry: number; w?: number; h?: number }) {
  if (s.length < 2) return <span className="tiny mute2">…</span>;
  const ys = s.map((x) => x[1]);
  const lo = Math.min(...ys, entry);
  const hi = Math.max(...ys, entry);
  const sy = (v: number) => h - ((v - lo) / Math.max(1e-12, hi - lo)) * (h - 2) - 1;
  const d = s.map((x, i) => `${i ? "L" : "M"}${((i / (s.length - 1)) * w).toFixed(1)},${sy(x[1]).toFixed(1)}`).join(" ");
  const up = ys[ys.length - 1] >= entry;
  return (
    <svg width={w} height={h} aria-hidden>
      <line x1="0" x2={w} y1={sy(entry)} y2={sy(entry)} stroke="var(--mute)" strokeDasharray="2 3" />
      <path d={d} fill="none" stroke={up ? "var(--rat)" : "var(--dust)"} strokeWidth="1.5" />
    </svg>
  );
}

function EquityChart({ pts, start }: { pts: Desk["equity"]; start: number }) {
  const W = 600;
  const H = 150;
  if (pts.length < 2) return <div className="muted small" style={{ height: H, display: "grid", placeItems: "center" }}>The balance line draws itself as the desk trades.</div>;
  const ys = pts.map((p) => p.eq);
  const lo = Math.min(...ys, start) * 0.995;
  const hi = Math.max(...ys, start) * 1.005;
  const sx = (i: number) => (i / (pts.length - 1)) * W;
  const sy = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${sx(i).toFixed(1)},${sy(p.eq).toFixed(1)}`).join(" ");
  const up = ys[ys.length - 1] >= start;
  const col = up ? "var(--rat)" : "var(--dust)";
  return (
    <svg viewBox={`0 0 ${W} ${H + 4}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="desk balance">
      <defs>
        <linearGradient id="eqfill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={up ? "#8cff5a" : "#ff5c5c"} stopOpacity="0.25" />
          <stop offset="1" stopColor={up ? "#8cff5a" : "#ff5c5c"} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" x2={W} y1={sy(start)} y2={sy(start)} stroke="var(--mute)" strokeDasharray="4 4" />
      <path d={`${line} L${W},${H} L0,${H} Z`} fill="url(#eqfill)" />
      <path d={line} fill="none" stroke={col} strokeWidth="2" style={{ filter: `drop-shadow(0 0 4px ${up ? "rgba(140,255,90,.5)" : "rgba(255,92,92,.5)"})` }} />
      {pts.map((p, i) => (i > 0 && p.live !== pts[i - 1].live ? <line key={i} x1={sx(i)} x2={sx(i)} y1="0" y2={H} stroke="var(--bond)" strokeDasharray="2 2" /> : null))}
    </svg>
  );
}

export default function DeskBoard() {
  const { data: d, error } = usePoll<Desk>("/api/desk", 2500);
  const now = Date.now();
  const st = d?.state;
  const eq = st?.equity ?? 0;
  const base = d?.live ? st?.liveStart ?? st?.start ?? 0 : st?.start ?? 0;
  const total = pct(eq, base);
  const today = st ? pct(eq, st.dayStart) : 0;
  const winRate = st?.closed ? (st.wins / st.closed) * 100 : null;
  const passed = d?.exam.checks.filter((c) => c.ok).length ?? 0;

  return (
    <>
      <section className="desk-top">
        <div>
          <div className="row" style={{ gap: 10 }}>
            <span className={`tag ${d?.live ? "v-BOND" : "v-WATCH"}`}>{d ? (d.mode === "off" ? "OFF" : d.live ? "LIVE" : "PAPER") : "…"}</span>
            <span className="tiny muted"><Info k="desk">{d?.live ? "real wallet, real fills" : "real prices, simulated fills"}</Info></span>
            {d?.wallet && <a className="tiny" href={solscanAcc(d.wallet)} target="_blank" rel="noreferrer">desk wallet {short(d.wallet)} · {d.walletSol != null ? `${d.walletSol.toFixed(4)} SOL` : "…"} →</a>}
          </div>
          <div className="desk-bal">
            <span className="big rat" style={{ fontSize: 64 }}><CountUp value={eq} decimals={3} /></span>
            <span className="muted"> SOL</span>
          </div>
          <div className="row wrapx small" style={{ gap: 16 }}>
            <span style={{ color: total >= 0 ? "var(--rat)" : "var(--dust)" }}>{sign(total)}% since start</span>
            <span style={{ color: today >= 0 ? "var(--rat)" : "var(--dust)" }}>{sign(today)}% today</span>
            <span className="muted">{st?.closed ?? 0} closed · {winRate != null ? `${winRate.toFixed(0)}% won` : "no closes yet"}</span>
            <span className="muted">{d?.positions.length ?? 0} open</span>
          </div>
        </div>
        <div className="panel exam">
          <div className="ph">
            <span><b>{d?.live ? "live" : "live exam"}</b> · <Info k="exam">{d?.live ? "promoted by the desk itself" : `${passed}/${d?.exam.checks.length ?? 5} passed`}</Info></span>
          </div>
          <div className="pb small">
            {d?.live ? (
              <div className="muted">Went live {st?.promotedAt ? ago(st.promotedAt) + " ago" : ""} with {st?.liveStart?.toFixed(3)} SOL. Drops back to paper at -40%.</div>
            ) : (
              (d?.exam.checks || []).map((c) => (
                <div key={c.label} className="row between" style={{ padding: "3px 0" }}>
                  <span><span style={{ color: c.ok ? "var(--rat)" : "var(--mute)" }}>{c.ok ? "■" : "□"}</span> {c.label}</span>
                  <span className="tiny"><span style={{ color: c.ok ? "var(--rat)" : "var(--text)" }}>{c.now}</span> <span className="mute2">/ {c.need}</span></span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="agents mt">
        {ROLES.map(([a, role]) => {
          const e = d?.agents?.[a];
          const hot = e && now - e.at < 6000;
          return (
            <div key={a} className={`agent ${hot ? "hot" : ""}`} style={{ ["--ac" as any]: AGENT_COLOR[a] }}>
              <div className="row between">
                <b style={{ color: AGENT_COLOR[a] }}>{a}</b>
                <span className="tiny mute2">{e ? ago(e.at) : "idle"}</span>
              </div>
              <div className="tiny muted">{role}</div>
              <div className="agent-last" style={{ color: e ? TONE[e.tone] : "var(--mute)" }}>
                {e?.mint ? <Link href={`/c/${e.mint}`} style={{ color: "inherit" }}>{e.text}</Link> : e?.text || "waiting for the first call"}
              </div>
              <i className="agent-bar" />
            </div>
          );
        })}
      </section>

      <section className="panel mt" style={{ overflow: "hidden" }}>
        <div className="ph">
          <span><b>the den</b> · <Info k="den">agents at work</Info></span>
          <span className="row" style={{ gap: 6 }}><span className={`dot ${error ? "off" : ""}`} /> {d?.mode === "off" ? "desk off" : "trading"}</span>
        </div>
        <DenScene agents={d?.agents || {}} events={d?.events || []} />
      </section>

      <section className="grid g-main mt">
        <div className="panel">
          <div className="ph"><span><b>balance</b> · {d?.live ? "live wallet" : "paper desk"}</span><span className="tiny muted">start {base.toFixed(3)} SOL</span></div>
          <div className="pb"><EquityChart pts={d?.equity || []} start={base} /></div>
        </div>
        <div className="panel">
          <div className="ph"><span><b>desk.config.ts</b> · <Info k="thresholds">every number the desk believes</Info></span></div>
          <pre className="code">
            {d
              ? [
                  ["enter_on", d.cfg.needNano ? "King + nano BOND" : "King or nano BOND (early read once earned)"],
                  ["curve_window", `${d.cfg.minCurve}% .. ${d.cfg.maxCurve}%`],
                  ["reject_dev", `${d.cfg.serialDev}+ launches 0 bonds, sold, or 5+ cluster launches 0 bonds`],
                  ["max_bundle", `${d.cfg.maxBundle}% of SOL in`],
                  ["copycats", "pass"],
                  ["min_buy_flow", `${Math.round(d.cfg.minFlow * 100)}% buys`],
                  ["never_chase", `> +${d.cfg.maxChase}% over the call: stalk a pullback`],
                  ["size", `${d.cfg.sizePct}% (${d.cfg.minSol}..${d.cfg.maxSol} SOL)`],
                  ["stop_loss", `${d.cfg.sl}% (before initials)`],
                  ["initials", `+${d.cfg.initialsAt}%: sell ${Math.round(d.cfg.initialsFrac * 100)}%`],
                  ["moonbag", `${Math.round(d.cfg.moonbag * 100)}% only the trail sells`],
                  ["ladder", `at each milestone if P(next) < ${Math.round(d.cfg.ladderBelow * 100)}%`],
                  ["trail", `${(d.cfg.trail || []).join("/")}% at <3x/3-10x/10-30x/30x+ × ${d.learn?.trailK?.toFixed(2) ?? "1.00"}`],
                  ["insider_exit", `dev ${d.cfg.devExit}% or insiders ${d.cfg.insiderExit}% sold`],
                  ["sellers_exit", "curve -20% in 40s (before initials)"],
                  ["on_migration", `keep runner bag if P(next) ≥ ${Math.round(d.cfg.gradKeepP * 100)}%`],
                  ["time_stop", `${d.cfg.timeStop}m before initials`],
                  ["daily_stop", `-${d.cfg.dailyLoss}%`],
                ].map(([k, v]) => (
                  <div key={String(k)} className="row between">
                    <span><span className="mute2">const </span><span style={{ color: "var(--watch)" }}>{k}</span></span>
                    <span className="green">{String(v)}</span>
                  </div>
                ))
              : "loading…"}
            {d?.vet && (
              <>
                <div className="mute2" style={{ marginTop: 10 }}>// last check: ${d.vet.symbol}, {ago(d.vet.at)} ago</div>
                {d.vet.checks.map((c) => (
                  <div key={c.rule} className="row between">
                    <span style={{ color: c.ok ? "var(--rat)" : "var(--dust)" }}>{c.ok ? "✓" : "✗"} {c.rule}</span>
                    <span className="muted">{c.v}</span>
                  </div>
                ))}
              </>
            )}
          </pre>
        </div>
      </section>

      <section className="grid g2 mt">
        <div className="panel">
          <div className="ph"><span><b>open positions</b></span><span className="tiny muted">re-checked every 2s</span></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Coin</th><th>Chart</th><th>P&amp;L</th><th>Mcap</th><th><Info k="pnext">P(next)</Info></th><th><Info k="trail">Trail</Info></th><th><Info k="insiders">Insiders</Info></th><th>Age</th></tr></thead>
              <tbody>
                {(d?.positions || []).map((p) => {
                  const g = pct(p.lastPx, p.entryPx);
                  return (
                    <tr key={p.mint}>
                      <td><Link href={`/c/${p.mint}`}>${p.symbol}</Link> <span className="tiny muted">{p.costSol.toFixed(2)}◎ · {p.how || "direct"}{p.tp1Done ? ` · initials, ${Math.round((p.tokens / Math.max(1e-9, p.tokens0)) * 100)}% left` : ""}</span></td>
                      <td><Spark s={p.series} entry={p.entryPx} /></td>
                      <td style={{ color: g >= 0 ? "var(--rat)" : "var(--dust)" }}>{sign(g)}%</td>
                      <td className="muted">{usdK(p.usd)}</td>
                      <td>{p.pn != null ? `${Math.round(p.pn * 100)}%` : "–"}</td>
                      <td className="muted">{p.tp1Done && p.trail ? `${p.trail}%` : "after initials"}</td>
                      <td style={{ color: (p.ins ?? 1) < 0.8 || (p.dev ?? 1) < 0.8 ? "var(--dust)" : "var(--dim)" }}>{p.nWatch ? `${p.ins != null ? Math.round(p.ins * 100) + "%" : "–"}${p.dev != null ? ` · dev ${Math.round(p.dev * 100)}%` : ""}` : "–"}</td>
                      <td className="muted">{ago(p.openedAt)}</td>
                    </tr>
                  );
                })}
                {!d?.positions.length && <tr><td colSpan={8} className="muted">No open positions. The desk waits for a King BOND call that passes every check.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <div className="ph"><span><b>trades</b></span><span className="tiny muted">{d?.live ? "every fill on Solscan" : "paper fills at the real curve price"}</span></div>
          <div className="scroll" style={{ maxHeight: 360 }}>
            <table className="tbl">
              <thead><tr><th>When</th><th>Side</th><th>Coin</th><th>SOL</th><th>Result</th><th>Why</th></tr></thead>
              <tbody>
                {(d?.trades || []).slice(0, 40).map((t) => (
                  <tr key={t.id}>
                    <td className="muted">{t.sig ? <a href={solscanTx(t.sig)} target="_blank" rel="noreferrer">{ago(t.at)}</a> : ago(t.at)}</td>
                    <td style={{ color: t.side === "buy" ? "var(--watch)" : "var(--bond)" }}>{t.side}</td>
                    <td><Link href={`/c/${t.mint}`}>${t.symbol}</Link></td>
                    <td>{t.sol.toFixed(3)}</td>
                    <td style={{ color: (t.pnlSol ?? 0) >= 0 ? "var(--rat)" : "var(--dust)" }}>{t.pnlSol != null ? `${sign(t.pnlSol, 3)} (${sign(t.pnlPct ?? 0)}%)` : ""}</td>
                    <td className="tiny muted" style={{ whiteSpace: "normal" }}>{t.reason}</td>
                  </tr>
                ))}
                {!d?.trades.length && <tr><td colSpan={6} className="muted">No trades yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <section className="grid g2 mt">
        <div className="panel">
          <div className="ph"><span><b>what the desk learned</b> · <Info k="learn">from its own trades</Info></span><span className="tiny muted">{d?.learn ? `${d.learn.shadows} in shadow · ${d.learn.reviewing} exits under review` : ""}</span></div>
          <pre className="code">
            {d?.learn ? (
              <>
                <div className="row between"><span><span className="mute2">let </span><span style={{ color: "var(--watch)" }}>trail_scale</span></span><span className="green">{d.learn.trailK.toFixed(2)}x</span></div>
                <div className="row between"><span><span className="mute2">let </span><span style={{ color: "var(--watch)" }}>exit_reviews</span></span><span className="green">{d.learn.reviews} · {d.learn.early} too early · {d.learn.late} too late · {d.learn.good} right</span></div>
                <div className="row between"><span><span className="mute2">let </span><span style={{ color: "var(--watch)" }}>pullback_entries</span></span><span style={{ color: d.learn.stalkOn ? "var(--rat)" : "var(--mute)" }}>{d.learn.stalkOn ? `on, -${d.learn.stalkArm}%` : `locked (need ${d.learn.rules.stalkMin} shadows, +${Math.round(d.learn.rules.stalkEdge * 100)}% edge)`}</span></div>
                <div className="row between"><span><span className="mute2">let </span><span style={{ color: "var(--watch)" }}>early_entries</span></span><span style={{ color: d.learn.earlyOn ? "var(--rat)" : "var(--mute)" }}>{d.learn.earlyOn ? "on" : `locked: ${d.learn.earlyStat.n}/${d.learn.rules.earlyMin} reads, ${d.learn.earlyStat.n ? Math.round((d.learn.earlyStat.hit / d.learn.earlyStat.n) * 100) : 0}% vs King ${d.learn.earlyStat.mainN ? Math.round((d.learn.earlyStat.mainHit / d.learn.earlyStat.mainN) * 100) : 0}%`}</span></div>
                <div className="row between"><span><span className="mute2">let </span><span style={{ color: "var(--watch)" }}>x_mentions</span></span><span className="muted">{d.learn.xConnected ? "connected" : "not connected"}</span></div>
              </>
            ) : "loading…"}
          </pre>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th><Info k="arms">Entry</Info></th><th>Signals</th><th>Filled</th><th>Mean after {d?.learn?.rules.shadowMins ?? 30}m</th></tr></thead>
              <tbody>
                {(d?.learn?.arms || []).map((a) => (
                  <tr key={a.arm}>
                    <td>{a.arm ? `wait for -${a.arm}%` : "buy now"}{d?.learn?.stalkOn && d.learn.stalkArm === a.arm ? <span className="green tiny"> · in use</span> : null}</td>
                    <td className="muted">{a.n}</td>
                    <td className="muted">{a.n ? `${Math.round((a.fills / a.n) * 100)}%` : "–"}</td>
                    <td style={{ color: (a.mean ?? 0) >= 0 ? "var(--rat)" : "var(--dust)" }}>{a.mean != null ? `${sign(a.mean)}%` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <div className="ph"><span><b>stalking</b> · waiting for a pullback</span><span className="tiny muted">{d?.stalks?.length ?? 0}</span></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Coin</th><th>Wants</th><th>Dip so far</th><th>Since</th></tr></thead>
              <tbody>
                {(d?.stalks || []).map((k) => (
                  <tr key={k.mint}>
                    <td><Link href={`/c/${k.mint}`}>${k.symbol}</Link></td>
                    <td>-{k.depth}% then a bounce</td>
                    <td style={{ color: k.armed ? "var(--rat)" : "var(--dim)" }}>{k.hi ? `${Math.round((1 - k.lo / k.hi) * 100)}%${k.armed ? " · armed" : ""}` : "–"}</td>
                    <td className="muted">{ago(k.at)}</td>
                  </tr>
                ))}
                {!d?.stalks?.length && <tr><td colSpan={4} className="muted">{d?.learn?.stalkOn ? "Nothing to stalk right now." : "Pullback entries unlock once the shadow record proves they beat buying straight away."}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <p className="tiny muted mt">Not financial advice. The desk is an experiment run in public; it can and will lose trades.</p>
    </>
  );
}
