"use client";
// v0.1.81: WALLETS. Every early buyer of every pump.fun coin, scored on whether the coins they bought migrated.
import { usePoll } from "./usePoll";
import { ago } from "./fmt";

type Top = { w: string; n: number; hits: number; rate: number; lo: number };
type V = {
  at: number | null;
  wallets?: number;
  scored?: number;
  proven?: number;
  base?: number;
  pending?: number;
  buys?: number;
  resolved?: number;
  top?: Top[];
  fire?: { up: boolean; since: number; trades: number; creates: number; completes: number; tape: number; curveSaved?: number; poolSaved?: number };
  dune?: { on: boolean; running: boolean; done: number; chunks: number; rows: number; error: string; stopped: string };
};

export default function WalletsBoard() {
  const d = usePoll<V>("/api/desk/wallets", 60_000).data;
  if (!d) return null;
  if (!d.at)
    return (
      <section className="panel mt" id="wallets">
        <div className="ph"><span><b>wallets</b> · every early buyer, scored on what the coin did next</span></div>
        <div className="pb muted small">Starts when the firehose is connected (every pump.fun trade, live).</div>
      </section>
    );
  const f = d.fire;
  return (
    <section className="panel mt" id="wallets">
      <div className="ph">
        <span><b>wallets</b> · every early buyer, scored on what the coin did next</span>
        <span className="tiny muted">{ago(d.at)} ago</span>
      </div>
      <div className="pb small">
        <span style={{ color: f?.up ? "var(--rat)" : "var(--dust)" }}>{f?.up ? "firehose live" : "firehose down"}</span>
        {f ? ` · ${f.trades.toLocaleString()} trades, ${f.creates.toLocaleString()} launches, ${f.completes.toLocaleString()} migrations since ${ago(f.since)} ago` : ""}
        {f?.up && f.curveSaved != null ? <div className="tiny mute2" style={{ marginTop: 4 }}>chain reads answered from the firehose: {f.curveSaved}% of curve reads, {f.poolSaved ?? 0}% of pool reads</div> : null}
        {d.dune?.on ? (
          <div className="tiny mute2" style={{ marginTop: 4 }}>
            history (90 days before the firehose, same rules): {d.dune.done}/{d.dune.chunks || 18} parts loaded, {(d.dune.rows ?? 0).toLocaleString()} wallet records
            {d.dune.running ? " · loading" : ""}
            {d.dune.error ? ` · ${d.dune.error}` : d.dune.stopped ? " · paused" : ""}
          </div>
        ) : null}
        <div className="tiny mute2" style={{ marginTop: 4 }}>
          {(d.wallets ?? 0).toLocaleString()} wallets tracked, {(d.scored ?? 0).toLocaleString()} with 6+ scored early buys, <b style={{ color: "var(--rat)" }}>{d.proven ?? 0} proven</b> (hit rate clearly 3x the {d.base}% base rate or more). {(d.pending ?? 0).toLocaleString()} coins waiting for their outcome.
        </div>
      </div>
      {d.top?.length ? (
        <div className="scroll">
          <table className="tbl rec-tbl">
            <thead><tr><th>wallet</th><th>early buys scored</th><th>migrated</th><th>hit rate</th><th>at least*</th></tr></thead>
            <tbody>
              {d.top.map((t) => (
                <tr key={t.w}><td>{t.w}</td><td>{t.n}</td><td>{t.hits}</td><td>{t.rate}%</td><td style={{ color: "var(--rat)" }}>{t.lo}%</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="pb tiny mute2">*the lower bound of the hit rate (95% confidence): a wallet with 2 lucky buys does not rank. Early = bought under 30% curve with 0.05+ SOL, not the dev. GRID tests "a proven wallet bought" and "2+ proven wallets bought" as entry rules.</div>
    </section>
  );
}
