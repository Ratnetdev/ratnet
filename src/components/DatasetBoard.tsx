"use client";
import { usePoll } from "./usePoll";
import { num } from "./fmt";

type D = { exports: { day: string; rows: number; url: string }[]; stats: { dug: number; dugToday: number; resolved: number; bonded: number; tracking: number } };

const SCHEMA: [string, string][] = [
  ["mint", "token address"],
  ["created_at", "block time of the create tx"],
  ["name, symbol, description", "as launched"],
  ["twitter, telegram, website", "socials from the metadata"],
  ["creator", "deployer wallet"],
  ["dev_buy_sol", "SOL in the curve after the create tx"],
  ["curve_at_dig", "% of the bonding curve filled when first dug"],
  ["curve_5m, curve_1h, curve_24h", "curve % at each checkpoint"],
  ["mcap_sol_5m, mcap_sol_1h", "market cap in SOL"],
  ["king_score, king_verdict, king_counted", "the Rat King's call"],
  ["outcome", "BONDED, ALIVE or DIED"],
];

export default function DatasetBoard() {
  const { data } = usePoll<D>("/api/ledger", 8000);
  const s = data?.stats;
  return (
    <>
      <section className="grid g4">
        <div className="panel glow"><div className="pb stat"><div className="k">Rows dug</div><div className="big rat">{num(s?.dug ?? 0)}</div><div className="s">+{num(s?.dugToday ?? 0)} today</div></div></div>
        <div className="panel"><div className="pb stat"><div className="k">Labelled</div><div className="big">{num(s?.resolved ?? 0)}</div><div className="s">outcome known</div></div></div>
        <div className="panel"><div className="pb stat"><div className="k">In the oven</div><div className="big">{num(s?.tracking ?? 0)}</div><div className="s">checkpoints still to dig</div></div></div>
        <div className="panel"><div className="pb stat"><div className="k">Bonded rows</div><div className="big" style={{ color: "var(--bond)" }}>{num(s?.bonded ?? 0)}</div><div className="s">the rare positives</div></div></div>
      </section>

      <section className="grid g2 mt">
        <div className="panel">
          <div className="ph"><span><b>daily drops</b> · jsonl · free</span></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Day (UTC)</th><th>Rows</th><th>File</th></tr></thead>
              <tbody>
                {(data?.exports || []).map((e) => (
                  <tr key={e.day}><td>{e.day}</td><td>{num(e.rows)}</td><td><a href={e.url} target="_blank" rel="noreferrer">download</a></td></tr>
                ))}
                {!data?.exports.length && <tr><td colSpan={3} className="muted">The first day drops 48h after launch, once every launch in it has an outcome.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <div className="ph"><span><b>schema</b> · one row per launch</span></div>
          <div className="scroll">
            <table className="tbl">
              <tbody>{SCHEMA.map(([k, v]) => <tr key={k}><td className="green">{k}</td><td className="muted" style={{ whiteSpace: "normal" }}>{v}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="panel mt">
        <div className="ph"><span><b>roadmap</b> · where the data goes</span></div>
        <div className="pb small muted">
          <div>· <b className="green">now</b> rats dig every pump.fun launch, live. Daily drops published here.</div>
          <div>· <b style={{ color: "var(--bond)" }}>next</b> Rat King v1 pretrained from scratch on the dug dataset. Public loss curve.</div>
          <div>· <b style={{ color: "var(--bond)" }}>next</b> weights on Hugging Face after the first epoch, plus the full dataset as a HF dataset.</div>
          <div>· <b className="muted">later</b> v2 with first-hour trade flow, hit rate per version on /king.</div>
        </div>
      </section>
    </>
  );
}
