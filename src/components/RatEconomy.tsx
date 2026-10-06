"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePoll } from "./usePoll";
import { useLive } from "./Live";
import { countdown, num, pumpCoin } from "./fmt";
import Info from "./Info";

type Board = {
  round: { id: number; startsAt: number; endsAt: number };
  litter: { n: number; size: number; open: boolean; spawned: number };
  rats: { active: boolean }[];
  costs: { spawn: number; sniff: number; minWork: number };
  live: boolean;
  mint: string | null;
  lastRound: { id: number; ownersSol: number; eligible: number; perRat: number; status: string } | null;
  paidTotal: number;
};

const sol = (n: number | null | undefined, d = 3) => (n == null ? "–" : `◎${n.toFixed(d)}`);

function useTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
}

function useBoard() {
  return usePoll<Board>("/api/rats", 15000).data;
}

function BuyBtn({ mint, className = "btn dim" }: { mint: string | null; className?: string }) {
  return mint ? (
    <a className={className} href={pumpCoin(mint)} target="_blank" rel="noreferrer">Buy $RAT</a>
  ) : (
    <span className={`${className} is-off`} title="The $RAT contract address is posted here and on X at launch">Buy $RAT · at launch</span>
  );
}

/** One line under the hero, the way Crawlnet does it: what owners earn, the live round, the cost, and the two buttons. */
export function BurnStrip() {
  useTick();
  const b = useBoard();
  const lr = b?.lastRound;
  return (
    <section className="burnstrip">
      <div className="bs-line">
        <span>
          <Info k="round">rat owners split <b>40% of all fees</b> every 12h</Info>
        </span>
        <span className="bs-sep">·</span>
        <span>round #{b?.round.id ?? "…"} pays in <b>{b ? countdown(b.round.endsAt) : "--:--:--"}</b></span>
        <span className="bs-sep">·</span>
        <span>
          {lr ? (
            <>last round <b>{sol(lr.ownersSol)}</b> ({sol(lr.perRat, 4)} per rat)</>
          ) : (
            <>first payout after launch</>
          )}
        </span>
        <span className="bs-sep">→</span>
        <span>
          <Info k="ratcost">spawn a rat · burn <b>{num(b?.costs.spawn ?? 100000)} $RAT</b></Info>
        </span>
      </div>
      <div className="bs-cta">
        <BuyBtn mint={b?.mint ?? null} />
        <Link href="/rats" className="btn">Spawn a rat</Link>
      </div>
    </section>
  );
}

const STEPS = [
  ["01", "burn", "Burn 100,000 $RAT. The tokens are destroyed for good and a rat is born into the open litter."],
  ["02", "dig", "Your rat reads new pump.fun launches for the network. 50 digs in a round makes it eligible."],
  ["03", "earn", "Every 12 hours, 40% of $RAT creator fees go to rat owners, split by digs and bag size. Paid in SOL."],
];

/** The full burn economy on the homepage. The /rats page has the spawn flow and every rat. */
export function RatSection() {
  useTick();
  const b = useBoard();
  const stats = (useLive().data as any)?.stats;
  const l = b?.litter;
  const alive = b ? b.rats.filter((r) => r.active).length : null;
  const fill = l && l.size ? Math.min(100, (l.spawned / l.size) * 100) : 0;
  return (
    <section className="panel mt ratecon" id="own">
      <div className="ph">
        <span><Info k="t_spawn"><b>own a rat</b></Info> · burn $RAT, earn SOL</span>
        <Link href="/rats">rats →</Link>
      </div>
      <div className="re-grid">
        <div className="re-left">
          <h2 className="re-h">Burn once. Earn from every fee, every 12 hours.</h2>
          <ol className="re-steps">
            {STEPS.map(([n, t, d]) => (
              <li key={n}>
                <span className="re-n">{n}</span>
                <div>
                  <b>{t}</b>
                  <p>{d}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="re-split">
            <div className="re-split-bar">
              <i style={{ width: "60%" }} />
              <i className="own" style={{ width: "40%" }} />
            </div>
            <div className="re-split-lbl">
              <span><Info k="compute"><b>60%</b> compute</Info></span>
              <span><b>40%</b> rat owners</span>
            </div>
          </div>
          <div className="row wrapx mt" style={{ gap: 10 }}>
            <Link href="/rats" className="btn">Spawn a rat</Link>
            <BuyBtn mint={b?.mint ?? null} className="btn dim" />
            <Link href="/ledger" className="btn dim">Ledger</Link>
          </div>
        </div>

        <div className="re-right">
          <div className="re-stats">
            <div>
              <span className="k"><Info k="round">Round #{b?.round.id ?? "…"} pays in</Info></span>
              <b>{b ? countdown(b.round.endsAt) : "--:--:--"}</b>
            </div>
            <div>
              <span className="k"><Info k="paidowners">Paid to owners</Info></span>
              <b>{sol(b?.paidTotal)}</b>
            </div>
            <div>
              <span className="k"><Info k="ratsalive">Rats alive</Info></span>
              <b>{num(alive)}</b>
            </div>
            <div>
              <span className="k"><Info k="burned">$RAT burned</Info></span>
              <b>{num(stats?.burnedRat ?? 0)}</b>
            </div>
          </div>

          <div className="re-litter">
            <div className="row between small">
              <span><Info k="litter">Litter {l?.n ?? 1}</Info></span>
              <span className="muted">{l ? `${num(l.spawned)} / ${num(l.size)} born` : "…"} · {l?.open ? "open" : "closed"}</span>
            </div>
            <div className="re-bar"><i style={{ width: `${fill}%` }} /></div>
          </div>

          <div className="re-tiers">
            <div className="k"><Info k="bagmult">Bag multiplier per rat</Info></div>
            <div className="re-tier-row">
              {[
                ["100K", "1x"],
                ["500K", "1.25x"],
                ["1M", "1.5x"],
                ["2.5M", "2x"],
              ].map(([bag, m]) => (
                <div key={bag}>
                  <b>{m}</b>
                  <span>{bag}</span>
                </div>
              ))}
            </div>
            <p className="tiny muted" style={{ margin: "10px 0 0" }}>
              $RAT held per rat. Payouts cap at 2x the spawn cost unless you hold 100K+ per rat.
            </p>
          </div>

          <div className="re-sniff small">
            <Info k="t_sniff">Or burn <b>{num(b?.costs.sniff ?? 10000)} $RAT</b> to sniff any coin</Info>
            <Link href="/sniff">sniff →</Link>
          </div>
        </div>
      </div>
    </section>
  );
}
