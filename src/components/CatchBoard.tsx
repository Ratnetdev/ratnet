"use client";
import { useRef } from "react";
// CATCH on /desk: what it is looking at right now, its honest record by score band, and the latest labels.
// Next to it, the BOARD: coins where several agent families agree, each agent's stance as a chip.
import Link from "next/link";
import { usePoll } from "./usePoll";
import Info from "./Info";
import CoinImg from "./CoinImg";
import { ago, usdK } from "./fmt";
import { AGENT_COLOR } from "./DenScene";

type Top = { mint: string; sym: string; stage: "curve" | "pool"; mc: number; p: number; prior: number; why: string[]; conf: number; age: number };
type V = {
  live: { at: number; ready: boolean; n: number; pos: number; cut: { band: number; n: number; hit: number } | null; scanned: number; pools?: number; live?: number; top: Top[] } | null;
  fast?: { n: number; pos: number; ready: boolean; all: { n: number; hit: number } };
  model: { n: number; pos: number; ready: boolean; need: number };
  bands: { b: number; n: number; hit: number; qn: number; qhit: number }[];
  all: { n: number; hit: number };
  hist?: { n: number; hit: number };
  stages: { curve: { n: number; hit: number }; pool: { n: number; hit: number } };
  recent: { mint: string; sym: string; at: number; stage: string; mc: number; peak: number; hit: boolean; p: number; prior: number }[];
};
type B = { coins: { mint: string; sym: string; score: number; pos: number; neg: number; posts: { a: string; s: number; at: number; t: string }[] }[] };

const pc = (h: number, n: number) => (n ? `${Math.round((h / n) * 100)}%` : "–");

export default function CatchBoard() {
  const box = useRef<HTMLElement>(null); // below the fold: no polling while off-screen
  const v = (usePoll<{ catch: V | null; board: B | null }>("/api/boards", 10000, { ref: box }).data?.catch ?? null);
  const bd = (usePoll<{ catch: V | null; board: B | null }>("/api/boards", 10000, { ref: box }).data?.board ?? null);
  const ready = !!v?.model.ready;
  const top = v?.live?.top || [];
  return (
    <section className="panel mt catch" ref={box}>
      <div className="ph">
        <span><Info k="catch"><b>CATCH</b></Info> · the sender catcher: coins moving like the ones that ran to $300K+</span>
        <span className="tiny muted">{v ? (ready ? `model live · ${v.model.n} labels` : `learning · ${v.model.n}/${v.model.need} labels, ${v.model.pos} senders`) : ""}{v?.hist?.n ? ` · ${v.hist.n} from replayed history` : ""}{v?.fast ? ` · 2h model ${v.fast.ready ? "live" : "learning"}, ${v.fast.n} labels` : ""}</span>
      </div>
      <div className="catch-grid">
        <div>
          <div className="sc-h">Looking at now <span className="muted">· {v?.live ? `${v.live.scanned} coins${v.live.pools ? `, ${v.live.pools} pools watched` : ""}${v.live.live ? `, ${v.live.live} on the live trade stream` : ""}, ${ago(v.live.at)} ago` : "waiting for the first pass"}</span></div>
          <table className="tbl catch-tbl">
            <thead><tr><th>Coin</th><th>Stage</th><th>MC</th><th>{ready ? "P(send)" : "Score"}</th><th className="hide-m">Why</th></tr></thead>
            <tbody>
              {top.slice(0, 10).map((x) => {
                const val = ready ? Math.round(x.p * 100) : x.prior;
                const hot = ready ? x.p >= (v?.live?.cut?.band ?? 1) : x.prior >= 72;
                return (
                  <tr key={x.mint}>
                    <td><Link href={`/c/${x.mint}`} className="coin-a"><CoinImg mint={x.mint} sym={x.sym} size={16} />${x.sym}</Link></td>
                    <td className="muted">{x.stage === "pool" ? "migrated" : "curve"}</td>
                    <td>{usdK(x.mc)}</td>
                    <td><span className="catch-bar"><i style={{ width: `${val}%`, background: hot ? "var(--bond)" : "var(--dim)" }} /></span> <b style={{ color: hot ? "var(--bond)" : undefined }}>{val}{ready ? "%" : ""}</b></td>
                    <td className="tiny muted hide-m">{x.why.slice(0, 2).join(" · ")}</td>
                  </tr>
                );
              })}
              {!top.length ? <tr><td colSpan={5} className="muted small">Nothing hot right now. CATCH looks every ~12 seconds.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div>
          <div className="sc-h">Record <span className="muted">· every look graded 6h later: did it reach $300K (or 2x)?</span></div>
          <div className="catch-rec">
            <div><span className="k">All looks</span><b>{pc(v?.all.hit || 0, v?.all.n || 0)}</b><em>{v?.all.hit || 0} of {v?.all.n || 0} sent</em></div>
            <div><span className="k">On the curve</span><b>{pc(v?.stages.curve.hit || 0, v?.stages.curve.n || 0)}</b><em>{v?.stages.curve.n || 0} looks</em></div>
            <div><span className="k">After migration</span><b>{pc(v?.stages.pool.hit || 0, v?.stages.pool.n || 0)}</b><em>{v?.stages.pool.n || 0} looks</em></div>
          </div>
          <table className="tbl catch-bands">
            <thead><tr><th>{ready ? "Model band" : "Score band"}</th><th>Looks</th><th>Sent</th></tr></thead>
            <tbody>
              {(v?.bands || []).slice().reverse().filter((b) => (ready ? b.n : b.qn) > 0).slice(0, 6).map((b) => (
                <tr key={b.b}>
                  <td>{ready ? `${b.b * 10}-${b.b * 10 + 9}%` : `${b.b * 10}-${b.b * 10 + 9}`}</td>
                  <td className="muted">{ready ? b.n : b.qn}</td>
                  <td style={{ color: (ready ? b.hit / Math.max(1, b.n) : b.qhit / Math.max(1, b.qn)) >= 0.2 ? "var(--bond)" : undefined }}>{ready ? pc(b.hit, b.n) : pc(b.qhit, b.qn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="sc-h mt">Latest labels</div>
          {(v?.recent || []).slice(0, 6).map((x) => (
            <Link key={x.mint + x.at} href={`/c/${x.mint}`} className="catch-lab">
              <b style={{ color: x.hit ? "var(--bond)" : "var(--mute)" }}>{x.hit ? "SENT" : "no"}</b>
              <span className="coin-a"><CoinImg mint={x.mint} sym={x.sym} size={14} />${x.sym}</span>
              <span className="tiny muted">{x.stage === "pool" ? "migrated" : "curve"} at {usdK(x.mc)} → peak {usdK(x.peak)}</span>
            </Link>
          ))}
        </div>
      </div>

      <div className="sc-h mt" style={{ padding: "0 14px" }}><Info k="board"><b>BOARD</b></Info> <span className="muted">· where the agents agree right now (each family counts once)</span></div>
      <div className="board-list">
        {(bd?.coins || []).map((c) => (
          <div key={c.mint} className="board-row">
            <Link href={`/c/${c.mint}`} className="coin-a"><CoinImg mint={c.mint} sym={c.sym} size={18} /><b>${c.sym || c.mint.slice(0, 4)}</b></Link>
            <span className={`board-n ${c.pos >= 3 ? "hot" : ""}`} title="independent agent families for / against (agents of the same family count once)">{c.pos} for{c.neg ? <em> · {c.neg} against</em> : null}</span>
            <span className="board-chips">
              {c.posts.slice(0, 8).map((p) => (
                <span key={p.a} className="board-chip" title={p.t} style={{ borderColor: p.s > 0 ? AGENT_COLOR[p.a] || "var(--rat)" : "var(--dust)", color: p.s > 0 ? AGENT_COLOR[p.a] || "var(--rat)" : "var(--dust)" }}>
                  {p.s > 0 ? "+" : "−"} {p.a}
                </span>
              ))}
            </span>
          </div>
        ))}
        {bd && !bd.coins.length ? <div className="muted small" style={{ padding: "6px 14px 14px" }}>No coin has two or more agents on it in the last 30 minutes.</div> : null}
      </div>
    </section>
  );
}
