"use client";
import { usePoll } from "./usePoll";
import { num } from "./fmt";

type D = { exports: { day: string; rows: number; url: string }[]; stats: { dug: number; dugToday: number; resolved: number; bonded: number; tracking: number } };

const SCHEMA: [string, string][] = [
  ["mint", "token address"],
  ["dev_prior_launches, dev_prior_bonded", "the creator's record before this launch"],
  ["created_at", "block time of the create tx"],
  ["name, symbol, description", "as launched"],
  ["twitter, telegram, website", "socials from the metadata"],
  ["creator", "deployer wallet"],
  ["dev_buy_sol", "SOL in the curve after the create tx"],
  ["curve_at_dig", "% of the bonding curve filled when first dug"],
  ["curve_5m, curve_1h, curve_24h", "curve % at each checkpoint"],
  ["mcap_sol_5m, mcap_sol_1h", "market cap in SOL"],
  ["curve_peak", "highest curve % the rats saw"],
  ["king_v0_score, king_v0_verdict, king_nano_score", "the Rat King's calls"],
  ["features", "the 14 numbers nano saw at 5 minutes"],
  ["bond_secs", "seconds from launch to graduation"],
  ["outcome", "BONDED, ALIVE or DIED"],
];

const TUNNELS = [
  { name: "LAUNCHES", live: true, what: "Every pump.fun create: name, ticker, description, socials, creator, dev buy, curve at birth.", unlock: "" },
  { name: "CURVES", live: true, what: "Curve checkpoints at 5m, 1h, 24h plus the hot watch that catches every graduation in near real time.", unlock: "" },
  { name: "DEV MEMORY", live: true, what: "Every creator's record: how many coins, how many bonded. Serial launchers can't hide.", unlock: "" },
  { name: "FIRST HOUR", live: false, what: "Every buy and sell in a launch's first hour: wallets, sizes, bundles, snipers.", unlock: "Opens with litter 2" },
  { name: "AFTER MIGRATION", live: false, what: "What graduated coins do on PumpSwap: the next 7 days of price and holders.", unlock: "Opens with litter 3" },
  { name: "OTHER PADS", live: false, what: "The same digging on other Solana launchpads, so the King learns beyond pump.fun.", unlock: "Holder vote after v1" },
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
        <div className="ph"><span><b>tunnels</b> · where the rats dig</span><span>{TUNNELS.filter((t) => t.live).length} / {TUNNELS.length} open</span></div>
        <div className="pb">
          <div className="grid g3" style={{ gap: 10 }}>
            {TUNNELS.map((t, i) => (
              <div key={t.name} className="screen" style={{ opacity: t.live ? 1 : 0.6 }}>
                <div className="row between">
                  <span className="nm" style={{ fontSize: 16 }}>T{i + 1} · {t.name}</span>
                  <span className={`pill ${t.live ? "" : "soon"}`} style={{ marginRight: 0, color: t.live ? "var(--rat)" : undefined }}>{t.live ? "OPEN" : "SEALED"}</span>
                </div>
                <div className="ln2" style={{ whiteSpace: "normal", marginTop: 6 }}>{t.what}</div>
                {!t.live && <div className="tiny" style={{ color: "var(--bond)", marginTop: 6 }}>{t.unlock}</div>}
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
