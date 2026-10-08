"use client";
import Link from "next/link";
import TradeLinks from "./venues";
import Scorecard, { FeedbackBox, type Card } from "./Scorecard";
import { solscanTx, solscanAcc, short, usd } from "./fmt";

export type Ctx = {
  createdAt: number;
  ageMs: number;
  curve: number | null;
  callAt: number | null;
  callCurve: number | null;
  callMc: number | null;
  chasePct: number | null;
  king: { score: number; verdict: string } | null;
  nano: { score: number; verdict: string } | null;
  early: { score: number; verdict: string } | null;
  checks: { rule: string; ok: boolean; v?: string }[];
  flow: string | null;
  buzz: string | null;
  tape: { n: number; vel: number; uniq: number; organic: number | null; spb: number; buyShare: number; bundle: number; bundleN: number; snipers: number; top5: number; devSold: number } | null;
  graph: { funder: string | null; clN: number; clB: number; clRatio: number; smartN: number } | null;
  dev: { launches: number; bonded: number; buySol: number };
  socials: { x: boolean; tg: boolean; web: boolean };
  meta: { hot: string | null; copy: boolean } | null;
  solUsd: number | null;
  sleeve?: string;
  wire?: { h: string; text: string; how: string; lagSec: number; trust: number } | null;
  card?: Card | null;
  mind?: { verdict: string; conviction: number; thesis: string; narrative: string; reasons: string[]; risks: string[] } | null;
  wallets?: { name: string; cls: string; conf: string; sol: number; minsBefore: number }[] | null;
};
export type Exit = { at: number; sol: number; reason: string; pnlPct: number | null; sig?: string; px?: number; mc?: number | null; tokens?: number };
export type Trip = {
  mint: string;
  symbol: string;
  openedAt: number;
  closedAt: number | null;
  open: boolean;
  live: boolean;
  costSol: number;
  backSol: number;
  valueSol: number;
  pnlSol: number;
  pnlPct: number;
  why: string;
  exits: Exit[];
  buySig?: string;
  holdMs: number;
  king?: number;
  nano?: number | null;
  how?: string;
  entryPx?: number;
  peakPct?: number | null;
  exitPct?: number | null;
  series?: [number, number][];
  tokens?: number;
  held?: number;
  entryMc?: number | null;
  exitMc?: number | null;
  nowMc?: number | null;
  peakMc?: number | null;
  ctx?: Ctx | null;
  after?: { k: string; at: number; px: number; vsExit: number; vsEntry: number; mc: number | null; why: string[] }[];
};
const HZ = [["5m", 5 * 60_000], ["15m", 15 * 60_000], ["1h", 3600_000], ["2h", 7200_000], ["6h", 21600_000], ["1d", 86400_000], ["7d", 604800_000]] as const;

/** COACH's checks after the exit: where the coin went, and what moved it. */
function After({ t }: { t: Trip }) {
  if (t.open || !t.closedAt) return null;
  const by: Record<string, NonNullable<Trip["after"]>[number]> = {};
  for (const c of t.after || []) by[c.k] = c;
  const notes = (t.after || []).filter((c) => c.why.length);
  return (
    <section className="td-sec">
      <h4>After the exit <span className="muted">COACH checks where it went and why</span></h4>
      <div className="td-after">
        {HZ.map(([k, ms]) => {
          const c = by[k];
          const due = t.closedAt! + ms;
          return (
            <div key={k}>
              <span>{k}</span>
              {c ? <b style={{ color: c.vsExit >= 50 ? "var(--bond)" : col(c.vsExit) }}>{sgn(c.vsExit)}%</b> : <b className="muted">{due > Date.now() ? `in ${dur(due - Date.now())}` : "…"}</b>}
              <em>{c ? usd(c.mc) : ""}</em>
            </div>
          );
        })}
      </div>
      {notes.length ? (
        <div className="td-note">
          {notes.map((c) => <div key={c.k}><span>{c.k}</span>{c.why.join(", ")}</div>)}
        </div>
      ) : null}
      <div className="tiny mute2" style={{ marginTop: 6 }}>vs our exit price. Positive means the coin kept running after we sold.</div>
    </section>
  );
}

export const sgn = (n: number, d = 1) => `${n > 0 ? "+" : ""}${n.toFixed(d)}`;
export const col = (n: number) => (n > 0 ? "var(--rat)" : n < 0 ? "var(--dust)" : "var(--dim)");
export function dur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`;
}
// a missing or bad time shows as "–" (an Invalid Date used to throw and take the whole page down)
const okMs = (ms: unknown): ms is number => typeof ms === "number" && Number.isFinite(ms) && Math.abs(ms) < 8.64e15;
const stamp = (ms: number) => (okMs(ms) ? new Date(ms).toISOString().slice(5, 19).replace("T", " ") : "–");
const hhmm = (ms: number) => (okMs(ms) ? new Date(ms).toISOString().slice(11, 19) : "–");
/** Market cap now or at exit, vs entry. */
export function moveOf(t: Trip): number | null {
  const end = t.open ? t.nowMc : t.exitMc;
  if (t.entryMc && end) return Math.round((end / t.entryMc - 1) * 1000) / 10;
  return t.open ? null : t.exitPct ?? null;
}
const RULE: Record<string, string> = {
  king_or_nano_bond: "King or nano said BOND",
  early_read_bond: "Early read said BOND",
  nano_agrees: "Nano check",
  curve_window: "Curve inside the buy window",
  curve_not_late: "Curve not already late at the call (a learned prior)",
  dev_not_serial: "Dev not a serial launcher",
  dev_buy_sane: "Dev buy sane",
  dev_not_selling: "Dev not selling (info only on memes)",
  bundle_ok: "Bundle small enough",
  cluster_ok: "Funder cluster has bonded before",
  not_a_copycat: "Not a copycat",
  not_a_farm: "Not a farm or bot coin",
  tape_read: "Trades read by TAPE",
  fresh_signal: "Signal fresh",
  holding_floor: "Holding its floor (not dumped from its high)",
  has_socials: "Has X, website or Telegram (or tied to a tweet)",
  post_traction: "The post spawned a wave of coins",
  wire_post: "Tracked X post behind it",
  mind_send: "MIND said SEND with enough conviction",
  independent_signal: "Another signal agreed (King, wallets, MOMO or a post wave)",
  traction: "Real volume and many buyers right now",
  buy_pressure: "More buyers than sellers",
  holder_spread: "Holders spread out (top 10)",
  liquidity_ok: "Enough liquidity",
  open_slots: "Free slot",
  daily_loss_ok: "Daily loss limit not hit",
};
export const ruleName = (r: string) => RULE[r] || r.replace(/_/g, " ");

/** Price across the whole trade: entry line, every sell, the peak. */
export function TripChart({ t }: { t: Trip }) {
  const s = t.series || [];
  if (s.length < 2 || !t.entryPx) return <div className="trip-nochart">No price chart for this trade yet.</div>;
  const W = 640, H = 150, P = 8;
  const t0 = s[0][0], t1 = Math.max(s[s.length - 1][0], ...t.exits.map((x) => x.at));
  const pxs = [...s.map((x) => x[1]), t.entryPx, ...t.exits.map((x) => x.px || t.entryPx!)];
  const lo = Math.min(...pxs), hi = Math.max(...pxs);
  const X = (tt: number) => P + ((tt - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
  const Y = (v: number) => H - P - ((v - lo) / Math.max(1e-18, hi - lo)) * (H - 2 * P);
  const line = s.map(([tt, v], i) => `${i ? "L" : "M"}${X(tt).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const up = (s[s.length - 1][1] || 0) >= t.entryPx;
  const pk = s.reduce((b, x) => (x[1] > b[1] ? x : b), s[0]);
  return (
    <>
      <svg className="trip-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <line x1={P} x2={W - P} y1={Y(t.entryPx)} y2={Y(t.entryPx)} stroke="rgba(255,255,255,.25)" strokeDasharray="4 4" />
        <path d={line} fill="none" stroke={up ? "#8cff5a" : "#ff5c5c"} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        <circle cx={X(pk[0])} cy={Y(pk[1])} r="3" fill="#ffb547" />
        {t.exits.filter((x) => x.px).map((x, i) => (
          <rect key={i} x={X(x.at) - 3} y={Y(x.px!) - 3} width="6" height="6" fill="#e8e8e8" />
        ))}
      </svg>
      <div className="trip-legend"><i className="lg-entry" /> entry <i className="lg-sell" /> sell <i className="lg-peak" /> peak</div>
    </>
  );
}

function KV({ k, v, c, sub }: { k: string; v: React.ReactNode; c?: string; sub?: React.ReactNode }) {
  return (
    <div>
      <span>{k}</span>
      <b style={c ? { color: c } : undefined}>{v}</b>
      {sub ? <em>{sub}</em> : null}
    </div>
  );
}

/** Everything about one trade: the numbers, why it passed, what the rats saw, every fill. */
export default function TripDetail({ t, coinLink = true }: { t: Trip; coinLink?: boolean }) {
  const c = t.ctx;
  const move = moveOf(t);
  const end = t.open ? t.nowMc : t.exitMc;
  const left = t.peakMc && end && !t.open ? Math.max(0, Math.round((t.peakMc / end - 1) * 1000) / 10) : null;
  const call = c?.king ? `King ${c.king.verdict} ${c.king.score}` : c?.early ? `Early ${c.early.verdict} ${c.early.score}` : t.king != null ? `King ${t.king}` : "–";
  const tp = c?.tape;
  const g = c?.graph;
  return (
    <div className="td">
      <div className="td-head">
        <KV k="Entry market cap" v={usd(t.entryMc)} sub={c?.curve != null ? `curve ${c.curve}%` : t.how === "stalk" ? "pullback" : ""} />
        <KV k={t.open ? "Market cap now" : "Exit market cap"} v={usd(end)} sub={t.open ? "live" : t.closedAt ? stamp(t.closedAt) : ""} />
        <KV k="Change" v={move != null ? `${sgn(move)}%` : "–"} c={col(move ?? 0)} sub="market cap, entry to exit" />
        <KV k="Peak while held" v={usd(t.peakMc)} sub={t.peakPct != null ? `${sgn(t.peakPct)}% from entry` : ""} />
        <KV k="P&L" v={`${sgn(t.pnlSol, 3)} ◎`} c={col(t.pnlSol)} sub={`${sgn(t.pnlPct)}% on ${t.costSol.toFixed(3)} ◎`} />
        <KV k="Held" v={dur(t.holdMs)} sub={left != null ? `${left}% left on the table` : t.open ? "still open" : ""} />
      </div>

      <div className="td-grid">
        <section>
          <h4>Entry</h4>
          <div className="td-kv">
            <KV k="Coin age at buy" v={c ? dur(c.ageMs) : "–"} sub={c ? `launched ${stamp(c.createdAt)}` : ""} />
            <KV k="The call" v={call} sub={c?.nano ? `nano ${c.nano.verdict} ${c.nano.score}` : t.nano != null ? `nano ${t.nano}` : "nano learning"} />
            <KV k="Market cap at call" v={usd(c?.callMc)} sub={c?.callCurve != null ? `curve ${c.callCurve}%` : ""} />
            <KV k="Call to buy" v={c?.callAt ? dur(t.openedAt - c.callAt) : "–"} sub={c?.chasePct != null ? `price ${sgn(c.chasePct)}% vs call` : ""} />
            <KV k="Strategy" v={t.how === "catch" ? "CATCH sender" : t.how === "flash" ? "FLASH first seconds" : t.how === "momo" ? "MOMO runner" : t.how === "mind" ? "MIND call" : t.how === "wire" ? "tweet coin" : t.how === "stalk" ? "pullback" : t.how === "early" ? "minute 1" : "on the call"} sub={t.live ? "live wallet" : "paper"} />
            <KV k="Size" v={`${t.costSol.toFixed(3)} ◎`} sub={t.tokens ? `${Math.round(t.tokens).toLocaleString("en-US")} tokens` : ""} />
          </div>
          {c?.wire ? (
            <div className="td-wire">
              <span>born from a post by <a href={`https://x.com/${c.wire.h}`} target="_blank" rel="noreferrer">@{c.wire.h}</a> · {c.wire.how} · {c.wire.lagSec}s after it · trust {c.wire.trust}</span>
              <q>{c.wire.text}</q>
            </div>
          ) : null}
          {c?.flow || c?.buzz ? (
            <div className="td-note">
              {c.flow ? <div><span>FLOW</span>{c.flow}</div> : null}
              {c.buzz ? <div><span>BUZZ</span>{c.buzz}</div> : null}
            </div>
          ) : null}
          {c?.wallets?.length ? (
            <div className="td-note">
              <div><span>HOUND</span>{c.wallets.map((w) => `${w.name} (${w.cls}${w.conf !== "confirmed" ? ", unconfirmed" : ""}) ${w.sol} SOL ${w.minsBefore}m before`).join(" · ")}</div>
            </div>
          ) : null}
          {c?.mind ? (
            <div className="td-note">
              <div><span>MIND</span><b style={{ color: c.mind.verdict === "SEND" ? "var(--rat)" : c.mind.verdict === "WATCH" ? "var(--watch)" : "var(--mute)" }}>{c.mind.verdict} {c.mind.conviction}</b> · {c.mind.thesis}</div>
            </div>
          ) : null}
        </section>

        <section>
          <h4>What the rats saw</h4>
          {tp || g || c ? (
            <div className="td-kv">
              <KV k="Trades / traders" v={tp ? `${tp.n} / ${tp.uniq}` : "–"} sub={tp ? `${tp.vel}/min${tp.organic != null ? ` · ${tp.organic} organic` : ""}` : "not read"} />
              <KV k="SOL per buy" v={tp ? `${tp.spb} ◎` : "–"} sub={tp ? `buys ${Math.round(tp.buyShare * 100)}% of recent` : ""} />
              <KV k="Bundle / snipers" v={tp ? `${Math.round(tp.bundle * 100)}% / ${tp.snipers}` : "–"} c={tp && tp.bundle > 0.5 ? "var(--dust)" : undefined} sub={tp ? `${tp.bundleN} bundle wallets · top 5 ${Math.round(tp.top5 * 100)}%` : ""} />
              <KV k="Dev" v={c?.dev ? `${c.dev.launches} launches, ${c.dev.bonded} bonded` : "–"} sub={c?.dev ? `bought ${c.dev.buySol} ◎${tp ? ` · sold ${tp.devSold > 0 ? `${tp.devSold} ◎` : "nothing"}` : ""}` : ""} c={tp && tp.devSold > 0 ? "var(--dust)" : undefined} />
              <KV k="Funder" v={g?.funder ? <a href={solscanAcc(g.funder)} target="_blank" rel="noreferrer">{short(g.funder, 4, 4)}</a> : "fresh"} sub={g ? `${g.clB}/${g.clN} bonded · ${g.clRatio}x edge` : ""} />
              <KV k="Smart wallets" v={g ? g.smartN : "–"} c={g?.smartN ? "var(--bond)" : undefined} sub={c ? `${[c.socials?.x && "X", c.socials?.tg && "TG", c.socials?.web && "web"].filter(Boolean).join(" · ") || "no socials"}${c.meta?.hot ? ` · meta "${c.meta.hot}"` : ""}${c.meta?.copy ? " · copycat" : ""}` : ""} />
            </div>
          ) : (
            <div className="muted small">Recorded for trades from v0.1.7 on.</div>
          )}
        </section>
      </div>

      {c?.checks?.length ? (
        <section className="td-sec">
          <h4>Why it passed VET <span className="muted">{c.checks.filter((x) => x.ok).length} of {c.checks.length} checks</span></h4>
          <div className="td-checks">
            {c.checks.map((x) => (
              <div key={x.rule} className={x.ok ? "ok" : "no"}>
                <i>{x.ok ? "✓" : "✗"}</i>
                <span>{ruleName(x.rule)}</span>
                <em>{x.v}</em>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <Scorecard card={c?.card} king={c?.king} nano={c?.nano} />

      <section className="td-sec">
        <h4>Price</h4>
        <TripChart t={t} />
      </section>

      <After t={t} />

      <section className="td-sec">
        <h4>Every fill</h4>
        <div className="td-fills">
          <div className="td-fill">
            <span className="d">{stamp(t.openedAt)}</span>
            <b className="buy">BUY</b>
            <span>{t.costSol.toFixed(3)} ◎</span>
            <span>{usd(t.entryMc)}</span>
            <span className="muted" />
            <span className="r">{t.why}{t.buySig ? <> · <a href={solscanTx(t.buySig)} target="_blank" rel="noreferrer">tx</a></> : null}</span>
          </div>
          {t.exits.map((x, i) => (
            <div key={i} className="td-fill">
              <span className="d">{stamp(x.at)}</span>
              <b className="sell">SELL</b>
              <span>{x.sol.toFixed(3)} ◎</span>
              <span>{usd(x.mc)}</span>
              <span style={{ color: col(x.pnlPct ?? 0) }}>{x.pnlPct != null ? `${sgn(x.pnlPct)}%` : ""}</span>
              <span className="r">{x.reason}{x.sig ? <> · <a href={solscanTx(x.sig)} target="_blank" rel="noreferrer">tx</a></> : null}</span>
            </div>
          ))}
          {t.open && (
            <div className="td-fill">
              <span className="d">now</span>
              <b>HOLD</b>
              <span>{t.valueSol.toFixed(3)} ◎</span>
              <span>{usd(t.nowMc)}</span>
              <span style={{ color: col(t.pnlPct) }}>{sgn(t.pnlPct)}%</span>
              <span className="r muted">{t.held ? `${Math.round(t.held).toLocaleString("en-US")} tokens at the live price` : "at the live price"}</span>
            </div>
          )}
        </div>
      </section>

      <FeedbackBox mint={t.mint} symbol={t.symbol} kind="trade" refAt={t.openedAt} />

      <div className="td-links">
        {coinLink && <Link href={`/c/${t.mint}`}>open ${t.symbol} →</Link>}
        <TradeLinks ca={t.mint} size="sm" />
      </div>
    </div>
  );
}
