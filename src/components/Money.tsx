"use client";
import Link from "next/link";
import Info from "./Info";
import { countdown, num } from "./fmt";
import { usePoll } from "./usePoll";

export type Econ = {
  live: boolean;
  round: { id: number; startsAt: number; endsAt: number };
  fees: { soFar: number; projected: number | null; owners: number | null; compute: number | null; allTime: number | null; at: number | null };
  perRatX1: number | null;
  weights: { sum: number; n: number; capped: number } | null;
  paid: { sol: number | null; wallets: number; rounds: number };
  spawn: { rat: number; sol: number | null };
  capX: number;
  capFree: number;
  tiers: { bag: number; label: string; mult: number; capped: boolean; byClose: number | null; perDay: number | null; payback: number | null }[];
};

const s3 = (n: number | null | undefined, d = 3) => (n == null ? "–" : n.toFixed(d));

/** What one rat earns this round at each bag size (Crawlnet's best screen, done for rats). */
export function EarnTable({ e }: { e: Econ | null | undefined }) {
  const live = !!e?.live && (e?.fees.soFar ?? 0) > 0;
  return (
    <section className="panel mt">
      <div className="ph">
        <span><Info k="earn"><b>what a rat earns this round</b></Info></span>
        <span className="tiny muted">{e ? `closes in ${countdown(e.round.endsAt)}` : "…"}</span>
      </div>
      <div className="scroll">
        <table className="tbl earn">
          <thead>
            <tr>
              <th><Info k="bagmult">Bag per rat</Info></th>
              <th>×</th>
              <th><Info k="byclose">SOL by close</Info></th>
              <th><Info k="perday">SOL a day</Info></th>
              <th><Info k="payback">Pays back</Info></th>
            </tr>
          </thead>
          <tbody>
            {(e?.tiers || []).map((t) => (
              <tr key={t.label}>
                <td>
                  <span className="earn-bag">{t.label}</span>
                  <span className={`earn-cap ${t.capped ? "c" : ""}`}>{t.capped ? `stops at ${e?.capX ?? 2}x cost` : "no cap"}</span>
                </td>
                <td>×{t.mult}</td>
                <td>{live ? s3(t.byClose) : "–"}</td>
                <td className="muted">{live ? s3(t.perDay) : "–"}</td>
                <td className="muted">{live && t.payback != null ? `${t.payback} days` : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pb tiny muted earn-note">
        {live && e ? (
          <>
            Pool ◎{s3(e.fees.owners)} so far{e.fees.projected != null ? `, ≈ ◎${s3(e.fees.projected * 0.4)} by close at this pace` : ""}. {e.weights ? `${e.weights.n} rats in it, weights sum to ${e.weights.sum}.` : ""}
            {e.spawn.sol != null ? ` A rat costs ${num(e.spawn.rat)} $RAT ≈ ◎${s3(e.spawn.sol)}.` : ""} An estimate: fees move.
          </>
        ) : (
          <>Live once $RAT trades: the rats read the creator fees straight from pump.fun&apos;s fee vault, so the pool shows while it fills.</>
        )}
      </div>
    </section>
  );
}

/** The rules in one place, plain. */
export function RulesList({ minWork, spawn, sniff }: { minWork: number; spawn: number; sniff: number }) {
  const rows: [string, React.ReactNode][] = [
    ["price", <><b>{num(spawn)} $RAT</b> per rat, burned. Gone from the supply for good.</>],
    ["work", <>a rat needs <b>{minWork} digs</b> in a round to be paid for it. Rats dig on their own, nothing to run.</>],
    ["bag", <>$RAT held by the owner&apos;s wallet, split over its rats. More per rat = a bigger share: <b>100K ×1 → 500K ×1.25 → 1M ×1.5 → 2.5M ×2</b>.</>],
    ["cap", <>under <b>100K per rat</b>: a rat earns up to <b>2x</b> what it cost, then stops. 100K+ per rat: <b>no cap</b>.</>],
    ["share", <>pool × the rat&apos;s multiplier ÷ the sum of all multipliers in the round.</>],
    ["pool", <><b>40%</b> of every $RAT creator fee, paid in SOL every 12 hours (00:00 and 12:00 UTC). The other 60% pays for the digging, training and calls.</>],
    ["sniff", <>or burn <b>{num(sniff)} $RAT</b> to have the rats read any coin you paste.</>],
  ];
  return (
    <section className="panel mt">
      <div className="ph"><span><b>the rules</b> · how rats earn</span></div>
      <dl className="rules">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Fees in, 60/40 split, owners paid. Every number from the chain or the ledger. */
export function MoneyFlow({ e }: { e: Econ | null | undefined }) {
  const live = !!e?.live;
  return (
    <section className="panel mt">
      <div className="ph">
        <span><Info k="flow"><b>money flow</b></Info></span>
        <span className="tiny muted">{e?.fees.at ? "read from pump.fun's fee vault" : "starts at launch"}</span>
      </div>
      <div className="flow">
        <div className="flow-box">
          <div className="flow-k">creator fees</div>
          <div className="flow-v">◎{s3(e?.fees.allTime)}</div>
          <div className="flow-s">all time · this round <b>+◎{s3(e?.fees.soFar)}</b></div>
        </div>
        <div className="flow-split">
          <div className="flow-arm">
            <span className="flow-pct">60%</span>
            <div className="flow-box sm">
              <div className="flow-k">compute</div>
              <div className="flow-s">digging, training, calls · ◎{s3(e?.fees.compute)} this round</div>
            </div>
          </div>
          <div className="flow-arm">
            <span className="flow-pct">40%</span>
            <div className="flow-box sm hi">
              <div className="flow-k">this round&apos;s pool</div>
              <div className="flow-v">◎{s3(e?.fees.owners)}</div>
              <div className="flow-s">{e?.perRatX1 != null ? `≈ ◎${s3(e.perRatX1, 4)} per rat at ×1 · ` : ""}closes in {e ? countdown(e.round.endsAt) : "--:--:--"}</div>
            </div>
          </div>
        </div>
        <div className="flow-box">
          <div className="flow-k">rat owners</div>
          <div className="flow-v">◎{s3(e?.paid.sol)} paid</div>
          <div className="flow-s">{e?.paid.wallets ?? 0} wallets · {e?.paid.rounds ?? 0} rounds</div>
        </div>
        <Link href="/rats" className="flow-box add">
          <div className="flow-k">+ your rat</div>
          <div className="flow-s">burn {num(e?.spawn.rat ?? 100000)} $RAT and join {live ? "this round" : "the first round"} →</div>
        </Link>
      </div>
    </section>
  );
}

/** Self-loading wrappers for the server pages. */
type RatsApi = { econ: Econ | null; costs: { spawn: number; sniff: number; minWork: number } };
export function RatsMoney() {
  const d = usePoll<RatsApi>("/api/rats", 15000).data;
  return (
    <>
      <EarnTable e={d?.econ} />
      <RulesList minWork={d?.costs.minWork ?? 50} spawn={d?.costs.spawn ?? 100000} sniff={d?.costs.sniff ?? 10000} />
    </>
  );
}
export function LedgerFlow() {
  const d = usePoll<RatsApi>("/api/rats", 15000).data;
  return <MoneyFlow e={d?.econ} />;
}
