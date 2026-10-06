"use client";
import { usePoll } from "./usePoll";
import { ago, countdown, num, short, solscanAcc, solscanTx } from "./fmt";
import { Fragment, useEffect, useState } from "react";

type Payout = { owner: string; rats: string[]; work: number; mult: number; sol: number; capped: number; sig?: string };
type Round = { id: number; startsAt: number; endsAt: number; feesSol: number; computeSol: number; ownersSol: number; cappedSol: number; eligible: number; payouts: Payout[]; status: string };
type Burn = { sig: string; kind: string; wallet: string; amount: number; at: number; ca?: string };
type Ledger = { rounds: Round[]; burns: Burn[]; current: { id: number; endsAt: number }; stats: { burnedRat: number; sniffs: number } };

export default function LedgerBoard() {
  const { data } = usePoll<Ledger>("/api/ledger", 10000);
  const [, tick] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const totals = (data?.rounds || []).reduce(
    (a, r) => ({ fees: a.fees + r.feesSol, owners: a.owners + (r.status === "paid" ? r.ownersSol - r.cappedSol : 0), compute: a.compute + r.computeSol }),
    { fees: 0, owners: 0, compute: 0 }
  );

  return (
    <>
      <section className="grid g4">
        <div className="panel glow"><div className="pb stat"><div className="k">$RAT burned</div><div className="big rat">{num(data?.stats.burnedRat ?? 0)}</div><div className="s">spawns + sniff orders</div></div></div>
        <div className="panel"><div className="pb stat"><div className="k">Paid to rat owners</div><div className="big">{totals.owners.toFixed(3)} ◎</div><div className="s">40% of fees</div></div></div>
        <div className="panel"><div className="pb stat"><div className="k">To compute</div><div className="big">{totals.compute.toFixed(3)} ◎</div><div className="s">60%: digging, training, calls</div></div></div>
        <div className="panel"><div className="pb stat"><div className="k">Round #{data?.current.id ?? "…"} closes in</div><div className="big">{data ? countdown(data.current.endsAt) : "--:--:--"}</div><div className="s">every 12h</div></div></div>
      </section>

      <section className="panel mt">
        <div className="ph"><span><b>payout rounds</b> · every transfer on Solscan</span></div>
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Round</th><th>Window (UTC)</th><th>Fees</th><th>Compute 60%</th><th>Owners 40%</th><th>Eligible rats</th><th>Status</th><th /></tr></thead>
            <tbody>
              {(data?.rounds || []).map((r) => (
                <Fragment key={r.id}>
                  <tr>
                    <td className="green">#{r.id}</td>
                    <td className="muted">{new Date(r.startsAt).toISOString().slice(5, 16).replace("T", " ")} → {new Date(r.endsAt).toISOString().slice(11, 16)}</td>
                    <td>{r.feesSol} ◎</td>
                    <td>{r.computeSol} ◎</td>
                    <td>{r.ownersSol} ◎{r.cappedSol > 0 && <span className="tiny muted"> ({r.cappedSol} capped)</span>}</td>
                    <td>{r.eligible}</td>
                    <td>{r.status === "paid" ? <span className="green">paid</span> : r.status}</td>
                    <td><a style={{ cursor: "pointer" }} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "hide" : "payouts"}</a></td>
                  </tr>
                  {open === r.id &&
                    r.payouts.map((p) => (
                      <tr key={`${r.id}-${p.owner}`}>
                        <td />
                        <td><a href={solscanAcc(p.owner)} target="_blank" rel="noreferrer">{short(p.owner)}</a></td>
                        <td colSpan={2} className="muted small">{p.rats.join(", ")} · {p.work} digs · {p.mult}x</td>
                        <td>{p.sol} ◎</td>
                        <td />
                        <td colSpan={2}>{p.sig ? <a href={solscanTx(p.sig)} target="_blank" rel="noreferrer">tx {short(p.sig)}</a> : <span className="muted">pending</span>}</td>
                      </tr>
                    ))}
                </Fragment>
              ))}
              {!data?.rounds.length && <tr><td colSpan={8} className="muted">First round closes 12h after launch.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel mt">
        <div className="ph"><span><b>burns</b> · verified on chain</span></div>
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>What</th><th>Wallet</th><th>Amount</th><th>When</th><th>Tx</th></tr></thead>
            <tbody>
              {(data?.burns || []).map((b) => (
                <tr key={b.sig}>
                  <td>{b.kind === "spawn" ? <span className="green">spawn</span> : <span style={{ color: "var(--watch)" }}>sniff</span>}</td>
                  <td><a href={solscanAcc(b.wallet)} target="_blank" rel="noreferrer">{short(b.wallet)}</a></td>
                  <td>{num(b.amount)} $RAT</td>
                  <td className="muted">{ago(b.at)} ago</td>
                  <td><a href={solscanTx(b.sig)} target="_blank" rel="noreferrer">{short(b.sig, 6, 6)}</a></td>
                </tr>
              ))}
              {!data?.burns.length && <tr><td colSpan={5} className="muted">No burns yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
