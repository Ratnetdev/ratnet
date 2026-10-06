"use client";
import { usePoll } from "./usePoll";
import { Outcome, VerdictTag, hitOf, Mark } from "./Calls";
import { CurveBar, DevTag, FlowBar } from "./Radar";
import { fmtSecs } from "./Grads";
import { ago, chg, num, short, usd, type Mkt } from "./fmt";
import { useState } from "react";
import Info from "./Info";

type Cp = { p: number; mcap: number; at: number };
type Launch = {
  mint: string;
  createdAt: number;
  creator: string;
  name: string;
  symbol: string;
  image: string;
  description: string;
  twitter: string;
  telegram: string;
  website: string;
  devBuySol: number;
  devN: number;
  devB: number;
  dugBy: string;
  p0: number;
  pNow?: number;
  peak?: number;
  mcapNow?: number;
  cp: { t1?: Cp; t5?: Cp; h1?: Cp; d1?: Cp };
  early?: { score: number; verdict: string; curve: number; at: number } | null;
  tape?: { n: number; vel: number; uniq: number; buys: number; sells: number; solIn: number; solPerBuy: number; buyShare: number; bundleN: number; bundleShare: number; sniperN: number; top5: number; devSold: number } | null;
  g?: { funder: string | null; clN: number; clB: number; clM: number; clRatio: number; smartN: number; smartMax: number } | null;
  meta?: { lift: number; hot: string | null; dup: number; copy: boolean } | null;
  outcome?: string;
  bondSecs?: number;
  resolvedAt?: number;
};
type Call = { score: number; verdict: string; counted: boolean; progress: number; nano?: { score: number; verdict: string } | null; outcome: string | null; at: number; symbol: string; name: string };

function socialLinks(l: Launch) {
  const links = [
    l.twitter && { k: "X", h: l.twitter },
    l.telegram && { k: "TG", h: l.telegram },
    l.website && { k: "web", h: l.website },
  ].filter(Boolean) as { k: string; h: string }[];
  if (!links.length) return <span className="mute2">none</span>;
  return links.map((x, i) => (
    <span key={x.k}>
      {i ? " · " : ""}
      <a href={x.h.startsWith("http") ? x.h : `https://${x.h}`} target="_blank" rel="noreferrer nofollow">{x.k}</a>
    </span>
  ));
}

export default function CoinView({ mint }: { mint: string }) {
  const { data, error } = usePoll<{ launch: Launch | null; call: Call | null; mkt?: Mkt | null; run?: { pk: number; cUsd?: number | null; x: number | null; pkAt?: number } | null }>(`/api/coin/${mint}`, 6000);
  const run = data?.run;
  const [copied, setCopied] = useState(false);
  const l = data?.launch;
  const m = data?.mkt;
  const c = data?.call;
  const sym = c?.symbol || l?.symbol || "";
  const outcome = c?.outcome || l?.outcome || null;

  if (error && !data)
    return (
      <div className="panel">
        <div className="pb">
          <div className="crt green" style={{ fontSize: 28 }}>Not dug</div>
          <p className="muted small">The rats only keep launches they dug live (dead coins are cleared after a few hours). Burn a sniff order to have the King score any CA.</p>
          <a className="btn" href="/sniff">Sniff this CA</a>
        </div>
      </div>
    );

  const url = typeof window !== "undefined" ? window.location.href : "";
  const tweet = c
    ? `The Rat King called $${sym} ${c.verdict} ${c.score}/100, 5 minutes after launch.${outcome ? ` Outcome: ${outcome}${l?.bondSecs ? ` in ${fmtSecs(l.bondSecs)}` : ""}.` : ""}\n\nEvery call logged and checked on chain.`
    : `The rats are watching $${sym}.`;

  return (
    <>
      <section className="hero" style={{ paddingTop: 6, paddingBottom: 20 }}>
        <div className="row wrapx" style={{ gap: 16, alignItems: "center" }}>
          {l?.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={l.image.replace("ipfs://", "https://ipfs.io/ipfs/")} alt="" width={72} height={72} style={{ border: "1px solid var(--line2)", objectFit: "cover", imageRendering: "auto" }} />
          )}
          <div>
            <h1 style={{ fontSize: "clamp(36px,6vw,60px)" }}>${sym || "…"}</h1>
            <div className="muted small">{l?.name || c?.name}</div>
          </div>
        </div>
        <div className="row wrapx mt" style={{ gap: 10 }}>
          <a className="btn" href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}&url=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer">Share call</a>
          <a className="btn dim" href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer">pump.fun</a>
          <a className="btn dim" href={`https://dexscreener.com/solana/${mint}`} target="_blank" rel="noreferrer">chart</a>
          <button className="btn dim" onClick={() => { navigator.clipboard?.writeText(mint); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "copied" : "copy CA"}</button>
        </div>
      </section>

      <section className="grid g3">
        <div className="panel glow">
          <div className="ph"><span><Info k="t_v0"><b>rat king v0</b></Info></span>{c && <VerdictTag v={c.verdict} />}</div>
          <div className="pb">
            <div className="big" style={{ color: c ? `var(--${c.verdict === "BOND" ? "bond" : c.verdict === "WATCH" ? "watch" : "dust"})` : undefined }}>{c?.score ?? "–"}</div>
            <div className="s small muted mt">{c ? `called ${ago(c.at)} ago at curve ${c.progress}%${c.counted ? "" : " · late, not counted"}` : "the call lands 5 minutes after launch"}<Mark h={c ? hitOf(c.verdict, outcome, c.counted) : null} /></div>
          </div>
        </div>
        <div className="panel">
          <div className="ph"><span><Info k="nano"><b>nano</b></Info> · learned model</span>{c?.nano && <VerdictTag v={c.nano.verdict} />}</div>
          <div className="pb">
            <div className="big">{c?.nano?.score ?? "–"}</div>
            <div className="small muted mt">{c?.nano ? "learned from every outcome so far" : "still learning, no counted call yet"}<Mark h={c?.nano ? hitOf(c.nano.verdict, outcome, c.counted) : null} /></div>
          </div>
        </div>
        <div className="panel">
          <div className="ph"><span><Info k="t_outcome"><b>outcome</b></Info></span></div>
          <div className="pb">
            <div style={{ marginBottom: 10 }}><Outcome o={outcome} /> {l?.bondSecs ? <span className="small" style={{ color: "var(--bond)" }}>in {fmtSecs(l.bondSecs)}</span> : null}</div>
            {outcome === "BONDED" && c && l?.resolvedAt && c.verdict === "BOND" && (
              <div className="small green" style={{ marginBottom: 8 }}>King called it {fmtSecs(Math.max(0, Math.round((l.resolvedAt - c.at) / 1000)))} before graduation</div>
            )}
            <CurveBar p={l?.pNow ?? l?.p0 ?? 0} />
            <div className="tiny muted mt">peak {l?.peak ?? "–"}% · mcap {l?.mcapNow ? `${num(Math.round(l.mcapNow))} ◎` : "–"}</div>
          </div>
        </div>
      </section>

      <section className="panel mt">
        <div className="ph">
          <span><Info k="t_market"><b>market</b></Info> · live from the chain</span>
          {m?.url && <a href={m.url} target="_blank" rel="noreferrer">dexscreener →</a>}
        </div>
        {m ? (
          <div className="mkt">
            <div><span className="k"><Info k="mc">Market cap</Info></span><b>{usd(m.mc)}</b></div>
            <div><span className="k"><Info k="v5">Vol 5m</Info></span><b>{usd(m.v5)}</b></div>
            <div><span className="k"><Info k="v1">Vol 1h</Info></span><b>{usd(m.v1)}</b></div>
            <div><span className="k"><Info k="v24">Vol 24h</Info></span><b>{usd(m.v24)}</b></div>
            <div><span className="k"><Info k="c5">Change 5m</Info></span><b style={{ color: (m.c5 ?? 0) >= 0 ? "var(--rat)" : "var(--dust)" }}>{chg(m.c5)}</b></div>
            <div><span className="k"><Info k="c1">Change 1h</Info></span><b style={{ color: (m.c1 ?? 0) >= 0 ? "var(--rat)" : "var(--dust)" }}>{chg(m.c1)}</b></div>
            <div><span className="k"><Info k="bs">Buys / sells 1h</Info></span><FlowBar b={m.b1} s={m.s1} /></div>
            <div><span className="k">{m.liq ? "Liquidity" : "Venue"}</span><b>{m.liq ? usd(m.liq) : m.dex || "–"}</b></div>
            {run?.pk ? <div><span className="k"><Info k="peak">Peak seen</Info></span><b>{usd(run.pk)}</b></div> : null}
            {run?.cUsd ? <div><span className="k"><Info k="atcall">At the King&apos;s call</Info></span><b>{usd(run.cUsd)}</b></div> : null}
            {run?.x ? <div><span className="k"><Info k="fromcall">Call to peak</Info></span><b style={{ color: run.x >= 2 ? "var(--bond)" : "var(--text)" }}>{run.x}x</b></div> : null}
          </div>
        ) : (
          <div className="pb small muted">{data ? "No market data yet. Very fresh coins can take a minute to show up." : "loading…"}</div>
        )}
      </section>

      {l?.tape && (
        <section className="grid g2 mt">
          <div className="panel">
            <div className="ph"><span><Info k="t_tape"><b>tape</b></Info> · every trade on the curve at the read</span></div>
            <div className="mkt" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
              <div><span className="k"><Info k="trades">Trades</Info></span><b>{l.tape.n}{l.tape.vel ? <span className="tiny muted"> · {l.tape.vel}/min</span> : null}</b></div>
              <div><span className="k"><Info k="traders">Traders</Info></span><b>{l.tape.uniq}</b></div>
              <div><span className="k"><Info k="solbuy">SOL per buy</Info></span><b>{l.tape.solPerBuy} ◎</b></div>
              <div><span className="k"><Info k="buyshare">Buy share</Info></span><b>{Math.round(l.tape.buyShare * 100)}%</b></div>
              <div><span className="k"><Info k="bundle">Bundle</Info></span><b style={{ color: l.tape.bundleShare > 0.5 ? "var(--dust)" : "var(--text)" }}>{Math.round(l.tape.bundleShare * 100)}% <span className="tiny muted">{l.tape.bundleN}w</span></b></div>
              <div><span className="k"><Info k="snipers">Snipers</Info></span><b>{l.tape.sniperN}</b></div>
              <div><span className="k"><Info k="top5">Top 5 early</Info></span><b>{Math.round(l.tape.top5 * 100)}%</b></div>
              <div><span className="k"><Info k="devsold">Dev sold</Info></span><b style={{ color: l.tape.devSold > 0 ? "var(--dust)" : "var(--rat)" }}>{l.tape.devSold > 0 ? `${l.tape.devSold} ◎` : "nothing"}</b></div>
            </div>
          </div>
          <div className="panel">
            <div className="ph"><span><Info k="t_graph"><b>graph</b></Info> · who is behind it</span></div>
            <div className="mkt" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
              <div><span className="k"><Info k="funder">Dev funded by</Info></span><b>{l.g?.funder ? <a href={`https://solscan.io/account/${l.g.funder}`} target="_blank" rel="noreferrer">{short(l.g.funder, 4, 4)}</a> : "unknown"}</b></div>
              <div><span className="k"><Info k="cluster">Funder cluster</Info></span><b>{l.g ? `${l.g.clB}/${l.g.clN} bonded` : "–"}</b></div>
              <div><span className="k"><Info k="cledge">Cluster edge</Info></span><b style={{ color: (l.g?.clRatio ?? 1) >= 2 ? "var(--rat)" : (l.g?.clRatio ?? 1) < 0.5 ? "var(--dust)" : "var(--text)" }}>{l.g ? `${l.g.clRatio}x` : "–"}</b></div>
              <div><span className="k"><Info k="smart">Smart wallets early</Info></span><b style={{ color: l.g?.smartN ? "var(--bond)" : "var(--text)" }}>{l.g?.smartN ?? 0}</b></div>
              <div><span className="k"><Info k="meta">Hot meta</Info></span><b>{l.meta?.hot ? `"${l.meta.hot}" ${l.meta.lift}x` : "none"}</b></div>
              <div><span className="k"><Info k="copycat">Copycat</Info></span><b style={{ color: l.meta?.copy ? "var(--dust)" : "var(--text)" }}>{l.meta?.copy ? "copies a recent winner" : "original"}</b></div>
            </div>
          </div>
        </section>
      )}

      {l && (
        <section className="grid g2 mt">
          <div className="panel">
            <div className="ph"><span><Info k="t_dug"><b>what the rats dug</b></Info> · {l.dugBy}</span></div>
            <div className="scroll">
              <table className="tbl">
                <tbody>
                  <tr><td className="muted">born</td><td>{new Date(l.createdAt).toISOString().replace("T", " ").slice(0, 19)} UTC</td></tr>
                  <tr><td className="muted"><Info k="dugcreator">creator</Info></td><td><a href={`https://solscan.io/account/${l.creator}`} target="_blank" rel="noreferrer">{short(l.creator, 6, 6)}</a> <DevTag n={l.devN ?? 0} b={l.devB ?? 0} /></td></tr>
                  <tr><td className="muted"><Info k="devbuy">dev buy</Info></td><td>{l.devBuySol} ◎</td></tr>
                  <tr><td className="muted"><Info k="socials">socials</Info></td><td>{socialLinks(l)}</td></tr>
                  <tr><td className="muted">description</td><td style={{ whiteSpace: "normal" }} className="small">{l.description || <span className="mute2">none</span>}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel">
            <div className="ph"><span><Info k="t_cp"><b>checkpoints</b></Info></span></div>
            <div className="scroll">
              <table className="tbl">
                <thead><tr><th>When</th><th><Info k="curve">Curve</Info></th><th><Info k="mcap">Mcap</Info></th></tr></thead>
                <tbody>
                  <tr><td>at dig</td><td>{l.p0}%</td><td className="muted">–</td></tr>
                  {(["t1", "t5", "h1", "d1"] as const).map((k) => (
                    <tr key={k}>
                      <td>{k === "t1" ? `1 min${l.early ? ` · early ${l.early.verdict} ${l.early.score}` : ""}` : k === "t5" ? "5 min" : k === "h1" ? "1 hour" : "24 hours"}</td>
                      <td>{l.cp[k] ? `${l.cp[k]!.p}%` : <span className="mute2">{l.outcome ? "–" : "pending"}</span>}</td>
                      <td className="muted">{l.cp[k]?.mcap ? `${num(Math.round(l.cp[k]!.mcap))} ◎` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
