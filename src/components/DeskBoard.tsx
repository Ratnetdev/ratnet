"use client";
import Link from "next/link";
import { usePoll } from "./usePoll";
import DenScene, { AGENT_COLOR } from "./DenScene";
import Info from "./Info";
import CountUp from "./CountUp";
import { safeHref, ago, short, solscanAcc, solscanTx, usdK } from "./fmt";
import DeskNow, { type DeskNowData } from "./DeskNow";
import TrackRecord from "./TrackRecord";
import BuildBoard from "./BuildBoard";
import AgentPanel from "./AgentPanel";
import { useState } from "react";
import LensCam from "./LensCam";
import MindBoard from "./MindBoard";
import MomoBoard from "./MomoBoard";
import CatchBoard from "./CatchBoard";
import FlashBoard from "./FlashBoard";
import AlivePanel from "./AlivePanel";
import HoundBoard from "./HoundBoard";
import { TradeIcons } from "./venues";
import { fullUrl, useAdmin } from "./useAdmin";
import CoinImg from "./CoinImg";
import LiveMc from "./LiveMc";

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
  rules: { stalkMin: number; stalkEdge: number; earlyMin: number; shadowMins: number; coachHours: number; devMin: number; devSaved: number; floorMax: number; floorMin: number; floorEdge: number };
  xConnected: boolean;
  devExitOn?: boolean;
  floorOn?: boolean;
  floor?: { n: number; sum: number };
  devStat?: { n: number; saved: number; cost: number };
};
type Stalk = { mint: string; symbol: string; at: number; depth: number; hi: number; lo: number; armed: boolean };
type Trade = { id: string; mint: string; symbol: string; side: string; at: number; sol: number; reason: string; pnlSol?: number; pnlPct?: number; live: boolean; sig?: string };
type Coach = { pending: number; horizons: { k: string; n: number; avg: number | null; up2: number; dn50: number }[]; reasons: { why: string; n: number }[] };
type FH = { n: number; right: number; wrong: number; avg: number | null };
type Film = {
  pending: number;
  rules: { rule: string; m30: FH; h2: FH; d1: FH; verdict: string }[];
  against: { reason: string; n: number; wrong: number; rate: number }[];
  forR: { reason: string; n: number; held: number; rate: number }[];
  calls: Record<string, { bonded: number; died: number }>;
  misses: { mint: string; symbol: string; verdict: string; score: number; nano: { verdict: string; score: number } | null; minus: string[]; curve: number; bondSecs: number | null; at: number }[];
};
type WireT = { id: string; h: string; at: number; text: string; terms: string[]; url: string; kind: string; picked: string | null };
type WireA = { h: string; cat: string; tier: string; tweets: number; matches: number; sparks: number; picks: number; runs: number; pnl: number; w: number };
type Rising = { term: string; now: number; usual: number; x: number; mood: string; posts15: number };
type Wire = { on: boolean; j7?: { on: boolean; last: { at: number; got: number; error: string | null } | null; covered: number } | null; pulse?: { at: number; rising: Rising[]; warming?: number } | null; tweets: (WireT & { src?: string; ca?: string })[]; accounts: WireA[]; counts?: { total: number; active: number }; candidates: { h: string; pts: number }[] };
type PmRow = { sleeve: string; trades: number; wins: number; winRate: number | null; avg: number | null; w: number; paused: number | null };
type Desk = {
  ghost?: { open: number; fills: number; max: number } | null;
  wire?: Wire | null;
  pm?: PmRow[] | null;
  film?: Film | null;
  coach?: Coach | null;
  now?: DeskNowData | null;
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
  ["FILM", "reviews every decision later"],
  ["WIRE", "X posts that spawn coins"],
  ["PM", "splits capital across strategies"],
  ["PULSE", "what X is talking about now"],
  ["LENS", "opens the site, X and TG by hand"],
  ["MIND", "judges coins like a trader"],
  ["HOUND", "tracks FOMO, KOL and smart wallets"],
  ["MOMO", "runners pulling volume after migration"],
  ["CATCH", "catches senders before they send"],
  ["SHIELD", "blocks scams, honeypots and drawn lines"],
  ["FLASH", "reads every launch at 15, 45 and 90 seconds"],
  ["OVERSEER", "explores, proposes improvements"],
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

const SLEEVE_NAME: Record<string, string> = { king: "King calls", early: "Early reads", wire: "Tweet coins", vamp: "Vamps", momo: "MOMO runners", mind: "MIND calls", catch: "CATCH senders", flash: "FLASH first seconds" };

export default function DeskBoard() {
  const admin = useAdmin();
  const { data: d, error } = usePoll<Desk>(fullUrl("/api/desk", admin), 2500);
  const full = !!(d as any)?.full; // admin view: the playbook and what the agents learned
  const now = Date.now();
  const st = d?.state;
  const eq = st?.equity ?? 0;
  const base = d?.live ? st?.liveStart ?? st?.start ?? 0 : st?.start ?? 0;
  const total = pct(eq, base);
  const today = st ? pct(eq, st.dayStart) : 0;
  const winRate = st?.closed ? (st.wins / st.closed) * 100 : null;
  const passed = d?.exam?.checks.filter((c) => c.ok).length ?? 0;
  const [agent, setAgent] = useState<string | null>(null);

  return (
    <>
      <nav className="sec-bar" aria-label="Desk sections">
        {[["now", "right now"], ["record", "record"], ["balance", "balance"], ["agents", "agents"], ["signals", "signals"], ["den", "den"], ["film", "film room"]].map(([id, label]) => (
          <a key={id} href={`#${id}`}>{label}</a>
        ))}
      </nav>
      <div id="now" className="sec-anchor" />
      <DeskNow now={d?.now} live={!!d?.live} open={d?.positions.length ?? 0} closed={st?.closed ?? 0} exam={d?.exam?.checks || []} pm={(d as any)?.pm || []} />

      {d && today <= -d.cfg.dailyLoss ? (
        <div className="panel mt ghost-note">
          <b>Daily loss limit hit ({sign(today)}% today).</b> The desk opens no new trades until 00:00 UTC. The ghost desk keeps taking every clean signal (not counted, learned from): {d.ghost?.open ?? 0} open now. See the ghost tab below.
        </div>
      ) : null}
      <TrackRecord />
      <BuildBoard />

      <section className="desk-top mt" id="balance">
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
            <span><b>{d?.live ? "live" : "live exam"}</b> · <Info k="exam">{d?.live ? "promoted by the desk itself" : `${passed}/${d?.exam?.checks.length ?? 6} passed`}</Info></span>
          </div>
          <div className="pb small">
            {d?.live ? (
              <div className="muted">Went live {st?.promotedAt ? ago(st.promotedAt) + " ago" : ""} with {st?.liveStart?.toFixed(3)} SOL. Drops back to paper at -40%.</div>
            ) : (
              (d?.exam?.checks || []).map((c) => (
                <div key={c.label} className="row between" style={{ padding: "3px 0" }}>
                  <span><span style={{ color: c.ok ? "var(--rat)" : "var(--mute)" }}>{c.ok ? "■" : "□"}</span> {c.label}</span>
                  <span className="tiny"><span style={{ color: c.ok ? "var(--rat)" : "var(--text)" }}>{c.now}</span> <span className="mute2">/ {c.need}</span></span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {agent && <AgentPanel name={agent} role={ROLES.find(([x]) => x === agent)?.[1] || ""} color={AGENT_COLOR[agent]} onClose={() => setAgent(null)} />}
      <section className="agents mt" id="agents">
        {ROLES.map(([a, role]) => {
          const e = d?.agents?.[a];
          const hot = e && now - e.at < 6000;
          // an error the desk has moved past does not stay red: after 10 minutes it fades to a muted "earlier" note
          const stale = !!e && (e.tone === "bad" || e.tone === "loss") && now - e.at > 10 * 60_000;
          return (
            <div key={a} className={`agent click ${hot ? "hot" : ""}`} style={{ ["--ac" as any]: AGENT_COLOR[a] }} onClick={() => setAgent(a)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setAgent(a)} title={`Open ${a}`}>
              <div className="row between">
                <b style={{ color: AGENT_COLOR[a] }}>{a}</b>
                <span className="tiny mute2">{e ? ago(e.at) : "idle"}</span>
              </div>
              <div className="tiny muted">{role}</div>
              <div className="agent-last" style={{ color: e && !stale ? TONE[e.tone] : "var(--mute)" }}>
                {stale && <span className="agent-earlier">earlier · </span>}
                {e?.mint ? <Link href={`/c/${e.mint}`} style={{ color: "inherit" }}>{e.text}</Link> : e?.text || "waiting for the first call"}
              </div>
              <i className="agent-bar" />
            </div>
          );
        })}
      </section>

      <AlivePanel />
      <div id="signals" className="sec-anchor" />
      <FlashBoard />
      <CatchBoard />
      <MomoBoard />
      <MindBoard />
      <HoundBoard />
      <LensCam />

      <section className="panel mt" id="den" style={{ overflow: "hidden" }}>
        <div className="ph">
          <span><b>the den</b> · <Info k="den">agents at work</Info></span>
          {/* v0.1.47: the same running/paused value as RIGHT NOW (it said "trading" while RIGHT NOW said paused) */}
          <span className="row" style={{ gap: 6 }}><span className={`dot ${error || (d && !d.now?.running) ? "off" : ""}`} /> {!d ? "loading…" : d.mode === "off" ? "desk off" : d.now?.running ? (d.live ? "trading live" : "trading on paper") : "paused"}</span>
        </div>
        <DenScene agents={d?.agents || {}} events={d?.events || []} />
      </section>

      <section className="grid g-main mt">
        <div className="panel">
          <div className="ph"><span><Info k="t_balance"><b>balance</b></Info> · {d?.live ? "live wallet" : "paper desk"}</span><span className="tiny muted">start {base.toFixed(3)} SOL</span></div>
          <div className="pb"><EquityChart pts={d?.equity || []} start={base} /></div>
        </div>
        <div className="panel">
          <div className="ph"><span><b>desk.config.ts</b> · <Info k="thresholds">{full ? "every number the desk believes" : "private"}</Info></span>{full ? <span className="tiny green">admin view</span> : null}</div>
          <pre className="code">
            {d && !full ? <div className="mute2" style={{ whiteSpace: "pre-wrap" }}>{"// the playbook is private: thresholds, priors and what the agents learned.\n// every trade still shows why it was taken. click one in the track record."}</div> : null}
            {d && full
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
                    <span><span className="mute2">const </span><Info k={`cfg_${k}`}><span style={{ color: "var(--watch)" }}>{k}</span></Info></span>
                    <span className="green">{String(v)}</span>
                  </div>
                ))
              : d ? null : "loading…"}
            {d?.vet && (
              <>
                <div className="mute2" style={{ marginTop: 10 }}>// last check: ${d.vet.symbol}, {ago(d.vet.at)} ago</div>
                {d.vet.checks.map((c) => (
                  <div key={c.rule} className="row between">
                    <span style={{ color: c.ok ? "var(--rat)" : "var(--dust)" }}>{c.ok ? "✓" : "✗"} {c.rule}</span>
                    {c.v ? <span className="muted">{c.v}</span> : null}
                  </div>
                ))}
              </>
            )}
          </pre>
        </div>
      </section>

      <section className="grid g2 mt">
        <div className="panel">
          <div className="ph"><span><Info k="t_open"><b>open positions</b></Info></span><span className="tiny muted">re-checked every 0.5s</span></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Coin</th><th>Chart</th><th>P&amp;L</th><th><Info k="mcap">Mcap</Info></th><th><Info k="pnext">P(next)</Info></th><th><Info k="trail">Trail</Info></th><th><Info k="insiders">Insiders</Info></th><th>Age</th></tr></thead>
              <tbody>
                {(d?.positions || []).map((p) => {
                  const g = pct(p.lastPx, p.entryPx);
                  return (
                    <tr key={p.mint}>
                      <td><Link href={`/c/${p.mint}`} className="coin-a"><CoinImg mint={p.mint} sym={p.symbol} size={16} />${p.symbol}</Link><TradeIcons ca={p.mint} /> <span className="tiny muted">{p.costSol.toFixed(2)}◎ · {p.how || "direct"}{p.tp1Done ? ` · initials, ${Math.round((p.tokens / Math.max(1e-9, p.tokens0)) * 100)}% left` : ""}</span></td>
                      <td><Spark s={p.series} entry={p.entryPx} /></td>
                      <td style={{ color: g >= 0 ? "var(--rat)" : "var(--dust)" }}>{sign(g)}%</td>
                      <td className="muted"><LiveMc mint={p.mint} usd={p.usd} /></td>
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
          <div className="ph"><span><Info k="t_trades"><b>trades</b></Info></span><span className="tiny muted">{d?.live ? "every fill on Solscan" : "paper fills at the real curve price"}</span></div>
          <div className="scroll" style={{ maxHeight: 360 }}>
            <table className="tbl">
              <thead><tr><th>When</th><th><Info k="side">Side</Info></th><th>Coin</th><th><Info k="sol">SOL</Info></th><th><Info k="result">Result</Info></th><th><Info k="why">Why</Info></th></tr></thead>
              <tbody>
                {(d?.trades || []).slice(0, 40).map((t) => (
                  <tr key={t.id}>
                    <td className="muted">{t.sig ? <a href={solscanTx(t.sig)} target="_blank" rel="noreferrer">{ago(t.at)}</a> : ago(t.at)}</td>
                    <td style={{ color: t.side === "buy" ? "var(--watch)" : "var(--bond)" }}>{t.side}</td>
                    <td><Link href={`/c/${t.mint}`} className="coin-a"><CoinImg mint={t.mint} sym={t.symbol} size={16} />${t.symbol}</Link></td>
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
            {d?.learn && !full ? <div className="mute2" style={{ whiteSpace: "pre-wrap" }}>{`// ${d.learn.reviews ?? 0} exits reviewed, ${d.learn.shadows} signals followed in shadow.\n// what the desk learned from them is private.`}</div> : null}
            {d?.learn && full ? (
              <>
                <div className="row between"><span><span className="mute2">let </span><span style={{ color: "var(--watch)" }}>trail_scale</span></span><span className="green">{d.learn.trailK.toFixed(2)}x</span></div>
                <div className="row between"><span><span className="mute2">let </span><span style={{ color: "var(--watch)" }}>exit_reviews</span></span><span className="green">{d.learn.reviews} · {d.learn.early} too early · {d.learn.late} too late · {d.learn.good} right</span></div>
                <div className="row between"><span><span className="mute2">let </span><span style={{ color: "var(--watch)" }}>pullback_entries</span></span><span style={{ color: d.learn.stalkOn ? "var(--rat)" : "var(--mute)" }}>{d.learn.stalkOn ? `on, -${d.learn.stalkArm}%` : `locked (need ${d.learn.rules.stalkMin} shadows, +${Math.round(d.learn.rules.stalkEdge * 100)}% edge)`}</span></div>
                <div className="row between"><span><span className="mute2">let </span><span style={{ color: "var(--watch)" }}>early_entries</span></span><span style={{ color: d.learn.earlyOn ? "var(--rat)" : "var(--mute)" }}>{d.learn.earlyOn ? "on" : `locked: ${d.learn.earlyStat.n}/${d.learn.rules.earlyMin} reads, ${d.learn.earlyStat.n ? Math.round((d.learn.earlyStat.hit / d.learn.earlyStat.n) * 100) : 0}% vs King ${d.learn.earlyStat.mainN ? Math.round((d.learn.earlyStat.mainHit / d.learn.earlyStat.mainN) * 100) : 0}%`}</span></div>
                <div className="row between"><span><span className="mute2">prior </span><Info k="prior"><span style={{ color: "var(--watch)" }}>holding_floor</span></Info></span><span style={{ color: d.learn.floorOn !== false ? "var(--rat)" : "var(--mute)" }}>{d.learn.floorOn !== false ? `on: skips coins ${d.learn.rules.floorMax}%+ under their high` : "overruled by COACH"} · {d.learn.floor?.n ?? 0}/{d.learn.rules.floorMin} skipped coins reviewed{d.learn.floor?.n ? `, avg ${(Math.exp(d.learn.floor.sum / d.learn.floor.n) * 100 - 100).toFixed(0)}% in 30m` : ""}</span></div>
                <div className="row between"><span><span className="mute2">prior </span><Info k="prior"><span style={{ color: "var(--watch)" }}>dev_exit</span></Info></span><span style={{ color: d.learn.devExitOn ? "var(--rat)" : "var(--mute)" }}>{d.learn.devExitOn ? "on: sells with the dev" : `off: holds through dev sells (${d.learn.devStat?.saved ?? 0}/${d.learn.devStat?.n ?? 0} cases favour selling, needs ${d.learn.rules.devMin}+ at ${Math.round(d.learn.rules.devSaved * 100)}%)`}</span></div>
                <div className="row between"><span><span className="mute2">prior </span><Info k="prior"><span style={{ color: "var(--watch)" }}>has_socials</span></Info></span><span style={{ color: (d.learn as any).socialsOn !== false ? "var(--rat)" : "var(--mute)" }}>{(d.learn as any).socialsOn !== false ? "on: skips coins with no X, website or Telegram (tweet coins pass)" : "overruled by COACH"} · {(d.learn as any).socials?.n ?? 0}/{(d.learn.rules as any).socialsMin ?? 30} skipped coins reviewed</span></div>
                <div className="row between"><span><span className="mute2">prior </span><Info k="prior"><span style={{ color: "var(--watch)" }}>post_traction</span></Info></span><span style={{ color: (d.learn as any).tractionOn !== false ? "var(--rat)" : "var(--mute)" }}>{(d.learn as any).tractionOn !== false ? "on: tweet coins need a wave (3+ coins or 25+ SOL across them)" : "overruled by COACH"} · {(d.learn as any).traction?.n ?? 0}/{(d.learn.rules as any).tractionMin ?? 20} skipped coins reviewed</span></div>
                <div className="row between"><span><span className="mute2">let </span><span style={{ color: "var(--watch)" }}>x_mentions</span></span><span className="muted">{d.learn.xConnected ? "connected" : "not connected"}</span></div>
              </>
            ) : d ? null : "loading…"}
          </pre>
          <div className="scroll">
            <table className="tbl">
              {full ? <thead><tr><th><Info k="arms">Entry</Info></th><th>Signals</th><th>Filled</th><th>Mean after {d?.learn?.rules?.shadowMins ?? 30}m</th></tr></thead> : null}
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
          <div className="ph"><span><Info k="coachafter"><b>coach · after we sell</b></Info></span><span className="tiny muted">{d?.coach ? `${d.coach.pending} checks queued` : ""}</span></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>After the exit</th><th>Checked</th><th>Avg vs our sell</th><th>Ran 2x+</th><th>Fell 50%+</th></tr></thead>
              <tbody>
                {(d?.coach?.horizons || []).map((h) => (
                  <tr key={h.k}>
                    <td>{h.k}</td>
                    <td className="muted">{h.n}</td>
                    <td style={{ color: (h.avg ?? 0) > 0 ? "var(--dust)" : "var(--rat)" }}>{h.avg != null ? `${sign(h.avg)}%` : "–"}</td>
                    <td className="muted">{h.n ? `${h.up2} (${Math.round((h.up2 / h.n) * 100)}%)` : "–"}</td>
                    <td className="muted">{h.n ? `${h.dn50} (${Math.round((h.dn50 / h.n) * 100)}%)` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pb small">
            <div className="muted tiny" style={{ marginBottom: 6 }}>What was behind the runs we sold too early</div>
            {d?.coach?.reasons?.length ? d.coach.reasons.map((r) => <div key={r.why} className="row between tiny"><span>{r.why.replace(/#/g, "N")}</span><span className="muted">{r.n}x</span></div>) : <div className="tiny mute2">Nothing yet. Every closed trade is checked at 5m, 15m, 1h, 2h, 6h, 1d and 7d.</div>}
          </div>
        </div>
      </section>
      <section className="grid g-main mt">
        <div className="panel">
          <div className="ph"><span><Info k="wire"><b>wire</b></Info> · X posts that spawn coins</span><span className="tiny muted">{d?.wire ? (d.wire.on ? `${Math.max(d.wire.j7?.covered ?? 0, (d.wire.counts?.active ?? d.wire.accounts.filter((a) => a.tier !== "muted").length)).toLocaleString("en-US")} accounts${d.wire.j7?.on ? ` · J7 ${d.wire.j7.last?.error ? "error" : "live"}` : ""}` : (admin ? "waiting for J7_JWT or X_API_KEY" : "not connected")) : ""}</span></div>
          <div className="wire-list">
            {(d?.wire?.tweets || []).slice(0, 10).map((t) => (
              <div key={t.id} className="wire-t">
                <div className="wire-h"><a href={safeHref(t.url)} target="_blank" rel="noreferrer">@{t.h}</a><span className="muted"> · {ago(t.at)} ago{t.kind !== "post" ? ` · ${t.kind}` : ""}{t.src && !["j7", "tapi"].includes(t.src) ? ` · ${t.src}` : ""}{t.ca ? " · CA" : ""}</span>{t.picked ? <Link href={`/c/${t.picked}`} className="wire-pick">coin picked →</Link> : null}</div>
                <div className="wire-x">{t.text}</div>
                {t.terms.length ? <div className="wire-terms">{t.terms.slice(0, 6).map((x) => <span key={x}>{x}</span>)}</div> : null}
              </div>
            ))}
            {!d?.wire?.tweets?.length && <div className="pb small muted">{d?.wire?.on ? "No tracked posts yet. They land here within seconds of being posted." : "WIRE starts once the X data key is set. It already holds the seed list of accounts."}</div>}
          </div>
        </div>
        <div className="grid" style={{ alignContent: "start" }}>
          <div className="panel">
            <div className="ph"><span><Info k="pulse"><b>pulse</b></Info> · rising on X now</span><span className="tiny muted">{d?.wire?.pulse ? `${ago(d.wire.pulse.at)} ago` : ""}</span></div>
            <div className="pulse-list">
              {(d?.wire?.pulse?.rising || []).slice(0, 8).map((x) => (
                <div key={x.term} className="pulse-r">
                  <b>{x.term}</b>
                  <span className="pulse-bar"><i style={{ width: `${Math.min(100, (x.x / Math.max(...(d?.wire?.pulse?.rising || []).map((y) => y.x), 1)) * 100)}%` }} /></span>
                  <span>{x.x}x</span>
                  <em style={{ color: x.mood === "bullish" ? "var(--rat)" : x.mood === "bearish" ? "var(--dust)" : "var(--mute)" }}>{x.mood}</em>
                </div>
              ))}
              {!d?.wire?.pulse?.rising?.length && <div className="pb tiny muted">{d?.wire?.pulse?.warming ? `Learning the usual pace of every topic first: ready in about ${d.wire.pulse.warming} hour${d.wire.pulse.warming > 1 ? "s" : ""}.` : "Nothing running at 3x its usual pace right now. Rising narratives show here within a minute."}</div>}
            </div>
          </div>
          <div className="panel">
            <div className="ph"><span><Info k="pm"><b>pm</b></Info> · strategy sleeves</span></div>
            <div className="scroll">
              <table className="tbl">
                <thead><tr><th>Sleeve</th><th>Trades</th><th>Win</th><th>Avg</th><th>Size</th></tr></thead>
                <tbody>
                  {(d?.pm || []).map((x) => (
                    <tr key={x.sleeve}>
                      <td>{SLEEVE_NAME[x.sleeve] || x.sleeve}</td>
                      <td className="muted">{x.trades}</td>
                      <td className="muted">{x.winRate != null ? `${x.winRate}%` : "–"}</td>
                      <td style={{ color: (x.avg ?? 0) >= 0 ? "var(--rat)" : "var(--dust)" }}>{x.avg != null ? `${sign(x.avg)}%` : "–"}</td>
                      <td style={{ color: x.paused ? "var(--dust)" : x.w > 1 ? "var(--rat)" : "var(--text)" }}>{x.paused ? `paused to ${new Date(x.paused).toISOString().slice(11, 16)} UTC` : `${x.w}x`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel">
            <div className="ph"><span><b>accounts</b> · trust earned by results</span><span className="tiny muted">{d?.wire?.candidates?.length ? `${d.wire.candidates.length} candidates` : ""}</span></div>
            <div className="scroll" style={{ maxHeight: 320 }}>
              <table className="tbl">
                <thead><tr><th>Account</th><th>Posts</th><th>Sparked</th><th>Bonded</th><th>Trust</th></tr></thead>
                <tbody>
                  {(d?.wire?.accounts || []).filter((a) => a.tier !== "muted").slice(0, 25).map((a) => (
                    <tr key={a.h}>
                      <td><a href={`https://x.com/${a.h}`} target="_blank" rel="noreferrer">@{a.h}</a>{a.tier === "found" ? <span className="trip-tag">found</span> : null}</td>
                      <td className="muted">{a.tweets}</td>
                      <td className="muted">{a.sparks}</td>
                      <td className="muted">{a.runs}</td>
                      <td style={{ color: a.w >= 0.4 ? "var(--rat)" : a.w >= 0.2 ? "var(--text)" : "var(--mute)" }}>{a.w}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section className="panel mt film" id="film">
        <div className="ph"><span><Info k="film"><b>film room</b></Info> · every decision, reviewed against what happened next</span><span className="tiny muted">{d?.film ? `${d.film.pending} reviews queued` : ""}</span></div>
        <div className="film-grid">
          <div>
            <div className="film-k">Skips: was passing on the coin right?</div>
            <div className="scroll">
              <table className="tbl">
                <thead><tr><th>Rule</th><th>Reviewed</th><th>Right</th><th>Missed a run</th><th>Avg 2h later</th><th>Verdict</th></tr></thead>
                <tbody>
                  {(d?.film?.rules || []).map((r) => (
                    <tr key={r.rule}>
                      <td>{r.rule.replace(/_/g, " ")}</td>
                      <td className="muted">{r.h2.n || r.m30.n}</td>
                      <td className="muted">{r.h2.n ? `${Math.round((r.h2.right / r.h2.n) * 100)}%` : "–"}</td>
                      <td className="muted">{r.h2.n ? `${Math.round((r.h2.wrong / r.h2.n) * 100)}%` : "–"}</td>
                      <td style={{ color: (r.h2.avg ?? 0) > 0 ? "var(--dust)" : "var(--rat)" }}>{r.h2.avg != null ? `${sign(r.h2.avg)}%` : "–"}</td>
                      <td style={{ color: r.verdict === "costing" ? "var(--dust)" : r.verdict === "saving" ? "var(--rat)" : "var(--dim)" }}>{r.verdict}</td>
                    </tr>
                  ))}
                  {!d?.film?.rules?.length && <tr><td colSpan={6} className="muted">{d && !full ? "Rule by rule grades are private. The calls, graded, are on the right." : null}{d && !full ? null : "Every skip is checked 30 minutes, 2 hours and 24 hours later. First reviews land 30 minutes after the first skip."}</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="film-k mt">Reasons the King gives against a coin, and how often they were wrong</div>
            {(d?.film?.against || []).map((a) => (
              <div key={a.reason} className="film-row"><span>{a.reason.replace(/#/g, "N")}</span><span style={{ color: a.rate >= 5 ? "var(--dust)" : "var(--dim)" }}>{a.wrong}/{a.n} bonded anyway</span></div>
            ))}
            {!d?.film?.against?.length && <div className="tiny mute2">{d && !full ? "Private." : "Fills in as calls resolve (24 hours after launch, or at the bond)."}</div>}
          </div>
          <div>
            <div className="film-k">The King&apos;s calls, graded</div>
            <div className="film-calls">
              {(["BOND", "WATCH", "DUST"] as const).map((v) => {
                const c = d?.film?.calls?.[v];
                const n = (c?.bonded ?? 0) + (c?.died ?? 0);
                return (
                  <div key={v}>
                    <span className={`tag v-${v}`}>{v}</span>
                    <b>{n ? `${Math.round(((c?.bonded ?? 0) / n) * 1000) / 10}%` : "–"}</b>
                    <em>{n ? `${c?.bonded} of ${n} bonded` : "no resolved calls yet"}</em>
                  </div>
                );
              })}
            </div>
            <div className="film-k mt">Bonds the King didn&apos;t call</div>
            {(d?.film?.misses || []).slice(0, 8).map((m) => (
              <div key={m.mint + m.at} className="film-miss">
                <Link href={`/c/${m.mint}`} className="coin-a"><CoinImg mint={m.mint} sym={m.symbol} size={16} />${m.symbol}</Link>
                <span className={`tag v-${m.verdict}`}>{m.verdict} {m.score}</span>
                {m.nano ? <span className="tiny" style={{ color: m.nano.verdict === "BOND" ? "var(--bond)" : "var(--mute)" }}>nano {m.nano.verdict} {m.nano.score}</span> : null}
                <span className="film-why">{m.minus[0] || "no reason against recorded"}</span>
              </div>
            ))}
            {!d?.film?.misses?.length && <div className="tiny mute2">None yet.</div>}
          </div>
        </div>
      </section>
      <section className="grid g2 mt">
        <div className="panel">
          <div className="ph"><span><Info k="t_stalk"><b>stalking</b></Info> · waiting for a pullback</span><span className="tiny muted">{d?.stalks?.length ?? 0}</span></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Coin</th><th><Info k="wants">Wants</Info></th><th><Info k="dip">Dip so far</Info></th><th><Info k="since">Since</Info></th></tr></thead>
              <tbody>
                {(d?.stalks || []).map((k) => (
                  <tr key={k.mint}>
                    <td><Link href={`/c/${k.mint}`} className="coin-a"><CoinImg mint={k.mint} sym={k.symbol} size={16} />${k.symbol}</Link></td>
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
