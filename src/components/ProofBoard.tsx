"use client";
import { usePoll } from "./usePoll";
import CoinImg from "./CoinImg";
import { ago, num, sol, spct } from "./fmt";

type Row = { mint: string; sym: string | null; at: number; live: number; paper: number; gap: number; exact: boolean; books: number };
type Fill = { at: number; mint: string; symbol: string; path: string; early: boolean; total: number; slip: number | null };
type Shadow = { id: string; all: number | null; old: number | null; new: number | null };
type Proof = {
  at: number;
  desk: { live: boolean; start: number | null; equity: number | null; returnPct: number | null; sessionPct: number | null; trips: number | null; winRate: number | null };
  gap: { trades: number; exact: number; gap: number; raw: number } | null;
  pairs: Row[];
  fills: { n: number; live: number; ms: number | null; p90: number | null; wait: number | null; prep: number | null; land: number | null; slip: number | null; early: number; fast: { n: number; ms: number | null }; beat: { n: number; ms: number | null } };
  recentFills: Fill[];
  grid: { books: number; passed: number; trips: number | null; keep: { k: number; n: number } | null; bags: { n: number; best: string | null; live: number | null; desk: Shadow; rows: (Shadow & { ran: number })[] } | null; ladder: { n: number; best: string | null; rows: Shadow[] } | null } | null;
  king: { dug: number; resolved: number; baseRate: number; bond: { n: number; hit: number; rate: number } | null } | null;
};

const sec = (ms: number | null | undefined) => (ms == null ? "–" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const tone = (v: number | null | undefined) => (v == null ? undefined : v > 0 ? "var(--rat)" : v < 0 ? "var(--dust)" : undefined);
const LABEL: Record<string, string> = { book: "its own exit", desk: "desk ladder", all2: "all at 2x", all15: "all at 1.5x", lad13: "1.3x ladder", lad15: "1.5x ladder", lad2: "2x ladder", lad2b: "2x ladder, 20% bag", bag10: "ladder + 10% bag", bag20: "ladder + 20% bag", bag30: "ladder + 30% bag" };

export default function ProofBoard() {
  const { data: p } = usePoll<Proof>("/api/proof", 30000);
  const d = p?.desk;
  const f = p?.fills;
  const k = p?.king;
  return (
    <>
      <section className="grid g4">
        <div className="panel glow"><div className="pb stat">
          <div className="k">Live desk</div>
          <div className="big rat">{d?.equity != null ? sol(d.equity, 3) : "–"}</div>
          <div className="s">put in {d?.start ?? "–"} ◎ · <span style={{ color: tone(d?.returnPct) }}>{spct(d?.returnPct)}</span> · {d?.sessionPct != null ? <>since the last restart <span style={{ color: tone(d.sessionPct) }}>{spct(d.sessionPct)}</span></> : ""}</div>
        </div></div>
        <div className="panel"><div className="pb stat">
          <div className="k">Real money vs paper</div>
          <div className="big" style={{ color: tone(p?.gap?.gap) }}>{p?.gap ? `${p.gap.gap > 0 ? "+" : ""}${p.gap.gap} pts` : "–"}</div>
          <div className="s">a trade, on {num(p?.gap?.trades ?? 0)} live trades paired with their paper twin{p?.gap && p.gap.raw > p.gap.gap ? ` (measured ${p.gap.raw > 0 ? "+" : ""}${p.gap.raw}; never counted better than the cost of a trade)` : ""}</div>
        </div></div>
        <div className="panel"><div className="pb stat">
          <div className="k">Signal to fill</div>
          <div className="big">{sec(f?.ms)}</div>
          <div className="s">median over {num(f?.n ?? 0)} buys · 90% under {sec(f?.p90)} · fill vs signal price {spct(f?.slip)}</div>
        </div></div>
        <div className="panel"><div className="pb stat">
          <div className="k">The King&apos;s BOND calls</div>
          <div className="big" style={{ color: "var(--bond)" }}>{k?.bond ? `${k.bond.rate}%` : "–"}</div>
          <div className="s">migrate, vs {k?.baseRate ?? "–"}% of all launches · {num(k?.bond?.n ?? 0)} graded by the chain · {num(k?.dug ?? 0)} launches dug</div>
        </div></div>
      </section>

      <section className="grid g-main mt">
        <div className="panel" style={{ alignSelf: "start" }}>
          <div className="ph"><span><b>every live trade vs its paper twin</b> · the same strategy, the same coin, minutes apart</span></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Coin</th><th>When</th><th>Live</th><th>Paper</th><th>Gap</th><th>Matched</th></tr></thead>
              <tbody>
                {(p?.pairs || []).map((r) => (
                  <tr key={`${r.mint}${r.at}`}>
                    <td><a href={`/c/${r.mint}`} className="coin-a"><CoinImg mint={r.mint} sym={r.sym || "?"} size={16} />${r.sym || r.mint.slice(0, 4)}</a></td>
                    <td className="muted">{ago(r.at)}</td>
                    <td style={{ color: tone(r.live) }}>{spct(r.live)}</td>
                    <td style={{ color: tone(r.paper) }}>{spct(r.paper)}</td>
                    <td style={{ color: tone(r.gap) }}>{r.gap > 0 ? "+" : ""}{r.gap} pts</td>
                    <td className="muted">{r.exact ? "exact" : `by coin and time${r.books > 1 ? ` (${r.books} strategies)` : ""}`}</td>
                  </tr>
                ))}
                {!p?.pairs?.length && <tr><td colSpan={6} className="muted">No live trade paired yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="pb tiny muted">Paper is the strategy&apos;s trade at the desk&apos;s own take-profit steps, before costs. Live is what the wallet got back, after every fee. A strategy is followed only while its paper record plus this gap makes 5%+ a trade.</div>
        </div>

        <div className="grid" style={{ alignContent: "start" }}>
          <div className="panel">
            <div className="ph"><span><b>fill ledger</b> · every GRID buy</span></div>
            <div className="pb small">
              <div className="row between"><span className="muted">signal to start</span><span>{sec(f?.wait)}</span></div>
              <div className="row between"><span className="muted">checks before the send</span><span>{sec(f?.prep)}</span></div>
              <div className="row between"><span className="muted">send to landed</span><span>{sec(f?.land)}</span></div>
              <div className="row between mt"><span className="muted">bought on arrival</span><span>{num(f?.fast.n ?? 0)} · {sec(f?.fast.ms)}</span></div>
              <div className="row between"><span className="muted">bought on the next beat</span><span>{num(f?.beat.n ?? 0)} · {sec(f?.beat.ms)}</span></div>
              <div className="row between"><span className="muted">ordered at the signal (before paper filled)</span><span>{num(f?.early ?? 0)}</span></div>
            </div>
            <div className="scroll">
              <table className="tbl">
                <thead><tr><th>Coin</th><th>Path</th><th>Signal to fill</th><th>vs signal</th></tr></thead>
                <tbody>
                  {(p?.recentFills || []).map((x) => (
                    <tr key={`${x.mint}${x.at}`}>
                      <td><a href={`/c/${x.mint}`} className="coin-a">${x.symbol}</a></td>
                      <td className="muted">{x.path}{x.early ? " · early" : ""}</td>
                      <td>{sec(x.total)}</td>
                      <td style={{ color: tone(x.slip == null ? null : -x.slip) }}>{spct(x.slip)}</td>
                    </tr>
                  ))}
                  {!p?.recentFills?.length && <tr><td colSpan={4} className="muted">The ledger starts with the next GRID buy.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="ph"><span><b>what the desk tests on paper</b> · {num(p?.grid?.trips ?? 0)} trips, {p?.grid?.passed ?? 0} of {p?.grid?.books ?? 0} strategies passed</span></div>
            <div className="pb small">
              {p?.grid?.ladder && (
                <>
                  <div className="tiny muted">EXITS ON THE SAME {num(p.grid.ladder.n)} TRIPS (% a trip before costs, older / newest)</div>
                  {p.grid.ladder.rows.map((r) => (
                    <div key={r.id} className="row between"><span className={r.id === p.grid!.ladder!.best ? "green" : "muted"}>{LABEL[r.id] || r.id}{r.id === p.grid!.ladder!.best ? " (best on both halves)" : ""}</span><span style={{ color: tone(r.all) }}>{spct(r.all)} <span className="mute2">({spct(r.old)} / {spct(r.new)})</span></span></div>
                  ))}
                </>
              )}
              {p?.grid?.bags && (
                <>
                  <div className="tiny muted mt">HOLD A BAG? {num(p.grid.bags.n)} TRIPS, A 50% TRAIL UP TO 24H</div>
                  <div className="row between"><span className="muted">desk ladder</span><span style={{ color: tone(p.grid.bags.desk.all) }}>{spct(p.grid.bags.desk.all)}</span></div>
                  {p.grid.bags.rows.map((r) => (
                    <div key={r.id} className="row between"><span className="muted">{LABEL[r.id] || r.id}</span><span style={{ color: tone(r.all) }}>{spct(r.all)} <span className="mute2">({r.ran} ran past the ladder)</span></span></div>
                  ))}
                  <div className="tiny muted mt">Live: {p.grid.bags.live ? `${Math.round(p.grid.bags.live * 100)}% bag` : "no bag"}. A bag goes live only when it beats the ladder on both halves of 60+ trips.</div>
                </>
              )}
              {p?.grid?.keep && <div className="tiny muted mt">Open gains count at {Math.round(p.grid.keep.k * 100)}%: what closed trips kept of their peak gain ({num(p.grid.keep.n)} trips).</div>}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
