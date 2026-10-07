"use client";
// MIND on the desk: the coin it is thinking about right now, its latest calls, and its record.
import Link from "next/link";
import { usePoll } from "./usePoll";
import Info from "./Info";
import { ago } from "./fmt";

type H = { k: string; n: number; avg: number | null; up: number | null; x2: number };
type Rec = { verdict: string; n: number; h: H[] };
type Live = { at: number; mint: string; symbol: string; name?: string; image?: string; why: string; stage: "reading" | "thinking" | "done" | "error"; facts?: string[]; verdict?: string; conviction?: number; thesis?: string; reasons?: string[]; risks?: string[]; narrative?: string; meme?: string };
type Recent = { mint: string; symbol: string; image?: string; at: number; why: string; verdict: string; conviction: number; thesis: string; narrative: string; mc: number | null; grad: boolean; sent: boolean };
type View = { on: boolean; model: string; live: Live | null; recent: Recent[]; queued: number; record: Rec[]; unlock: { ok: boolean; n: number; mean: number; up: number; need: { n: number } }; lessons: { n: number; proven: number } };
export type Judgement = { verdict: string; conviction: number; thesis: string; reasons: string[]; risks: string[]; narrative: string; meme: string; copy: string; horizon: string; at: number; why: string; mc: number | null; grad: boolean; sent?: boolean };

const WHY: Record<string, string> = { momo: "MOMO runner", wallets: "tracked wallets buying", kol: "a KOL posted it", wire: "tweet coin", bond: "BOND call", bonded: "just migrated", pulse: "rising narrative", lens: "LENS look" };
export const VCOL: Record<string, string> = { SEND: "var(--rat)", WATCH: "var(--watch)", PASS: "var(--mute)" };
const img = (u?: string) => (u || "").replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/");
const usdK = (n: number | null) => (n == null ? "" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n}`);
const pc = (n: number | null) => (n == null ? "–" : `${n > 0 ? "+" : ""}${n}%`);

/** One judgement, as a card. Used on /desk (live) and on coin pages. */
export function MindCard({ j, symbol, foot = true }: { j: Judgement; symbol?: string; foot?: boolean }) {
  return (
    <div className="mc">
      <div className="mc-top">
        <b style={{ color: VCOL[j.verdict] }}>{j.verdict}</b>
        <span className="mc-conv"><i style={{ width: `${j.conviction}%`, background: VCOL[j.verdict] }} /></span>
        <span className="mc-n">{j.conviction}</span>
        {j.narrative && j.narrative !== "none" ? <span className="mc-tag">{j.narrative}</span> : null}
        {j.copy ? <span className="mc-tag">{j.copy}</span> : null}
        {j.horizon ? <span className="mc-tag">{j.horizon}</span> : null}
        {j.sent ? <span className="mc-tag sent">sent to the desk</span> : null}
      </div>
      <p className="mc-thesis">{j.thesis}</p>
      {j.meme ? <div className="mc-meme">{j.meme}</div> : null}
      <div className="sc-grid">
        <div>{j.reasons.map((x) => <div key={x} className="sc-r plus"><i>+</i>{x}</div>)}</div>
        <div>{j.risks.map((x) => <div key={x} className="sc-r minus"><i>-</i>{x}</div>)}</div>
      </div>
      {foot ? <div className="tiny mute2" style={{ marginTop: 6 }}>{symbol ? `$${symbol} · ` : ""}{WHY[j.why] || j.why} · {ago(j.at)} ago{j.mc ? ` · at ${usdK(j.mc)}${j.grad ? " after migration" : " on the curve"}` : ""}</div> : null}
    </div>
  );
}

export default function MindBoard() {
  const v = usePoll<View>("/api/mind", 2500).data;
  const l = v?.live;
  const send = v?.record.find((r) => r.verdict === "SEND");
  return (
    <section className="panel mt mind">
      <div className="ph">
        <span><Info k="mind"><b>MIND</b></Info> · the trader&apos;s mind: the meme, the narrative, who is talking, the timing</span>
        <span className="tiny muted">{v ? (v.on ? `${v.queued} queued · ${v.lessons.n} lessons (${v.lessons.proven} proven)` : "off · add ANTHROPIC_API_KEY") : ""}</span>
      </div>
      <div className="mind-grid">
        <div className="mind-live">
          {l ? (
            <div className={`ml ${l.stage}`}>
              <div className="ml-head">
                {l.image ? <img src={img(l.image)} alt="" width={44} height={44} /> : <span className="ml-ph" />}
                <div>
                  <Link href={`/c/${l.mint}`}><b>${l.symbol}</b></Link> <span className="muted small">{l.name}</span>
                  <div className="tiny mute2">{WHY[l.why] || l.why} · {ago(l.at)} ago</div>
                </div>
                <span className="ml-stage">{l.stage === "done" ? "decided" : l.stage === "error" ? "no answer" : l.stage}</span>
              </div>
              {l.stage === "done" && l.verdict ? (
                <MindCard j={{ verdict: l.verdict, conviction: l.conviction ?? 0, thesis: l.thesis || "", reasons: l.reasons || [], risks: l.risks || [], narrative: l.narrative || "", meme: l.meme || "", copy: "", horizon: "", at: l.at, why: l.why, mc: null, grad: false }} foot={false} />
              ) : (
                <pre className="ml-facts">{(l.facts || ["reading the coin…"]).join("\n")}</pre>
              )}
            </div>
          ) : (
            <div className="muted small pb">{v?.on ? "Waiting for the first coin worth a look: KOL calls, tweet coins, BOND calls, fresh migrations and narrative coins." : "MIND needs a language model. Add ANTHROPIC_API_KEY in Vercel and it starts judging within a minute."}</div>
          )}
        </div>
        <div>
          <div className="sc-h">Record <span className="muted">· every call followed, before and after migration</span></div>
          <table className="tbl mind-rec">
            <thead><tr><th>Call</th><th>n</th><th>15m</th><th>1h</th><th>6h</th><th>24h</th><th>2x+</th></tr></thead>
            <tbody>
              {(v?.record || []).map((r) => (
                <tr key={r.verdict}>
                  <td style={{ color: VCOL[r.verdict] }}>{r.verdict}</td>
                  <td className="muted">{r.n}</td>
                  {r.h.map((h) => <td key={h.k} style={{ color: (h.avg ?? 0) > 0 ? "var(--rat)" : (h.avg ?? 0) < 0 ? "var(--dust)" : "var(--dim)" }}>{pc(h.avg)}</td>)}
                  <td className="muted">{r.h[3]?.x2 ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="tiny muted" style={{ marginTop: 8 }}>
            {v?.unlock.ok ? <span className="green">SEND calls earned real money: the desk trades them.</span> : <>SEND calls trade once {v?.unlock.need.n ?? 20}+ of them average +15% after 6 hours with 40%+ up. Now {send?.h[2]?.n ?? 0} graded, {pc(v?.unlock.mean ?? null)} avg, {v?.unlock.up ?? 0}% up.</>}
          </div>
          <div className="sc-h mt">Latest calls</div>
          {(v?.recent || []).slice(0, 7).map((x) => (
            <Link key={x.mint + x.at} href={`/c/${x.mint}`} className="mind-row">
              <b style={{ color: VCOL[x.verdict] }}>{x.verdict} {x.conviction}</b>
              <span className="mind-sym">${x.symbol}</span>
              <span className="mind-th">{x.thesis}</span>
              <span className="tiny muted">{ago(x.at)}</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
