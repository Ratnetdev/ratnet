"use client";
import { useEffect, useState } from "react";
import { usePoll } from "./usePoll";
import { burnFlow, useWallet, WalletButton } from "./Wallet";
import { ago, countdown, num, short, solscanTx } from "./fmt";
import Info from "./Info";

type RatView = {
  id: number;
  name: string;
  owner: string;
  litter: number;
  sig: string;
  spawnedAt: number;
  costSol: number | null;
  earnedSol: number;
  active: boolean;
  work: number;
  workAll: number;
  last: { mint: string; symbol: string; at: number; kind: string } | null;
};
type Board = {
  round: { id: number; startsAt: number; endsAt: number };
  litter: { n: number; size: number; open: boolean; spawned: number };
  rats: RatView[];
  scouts: { name: string; last: { symbol: string; at: number; kind: string } }[];
  costs: { spawn: number; repeat: number; pup: number; pupMax: number; sniff: number; minWork: number };
  live: boolean;
  mine: RatView[];
  myPrice: number | null;
  pups: { name: string; owner: string; parent: string; spawnedAt: number; earnedSol: number }[];
  minePups: { name: string; parent: string; spawnedAt: number; earnedSol: number; sig: string }[];
};

function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export default function RatsBoard() {
  const { address, signAndSend } = useWallet();
  const { data, reload } = usePoll<Board>(`/api/rats${address ? `?wallet=${address}` : ""}`, 6000);
  const [step, setStep] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"spawn" | "pup">("spawn");
  const [parent, setParent] = useState("");
  useTick();

  const spawn = async () => {
    setErr("");
    setBusy(true);
    try {
      if (kind === "pup") {
        const r = await burnFlow({ wallet: address, kind: "pup", signAndSend, verifyUrl: "/api/rats/pup", verifyBody: { parent: parent || undefined }, onStep: setStep });
        setStep(`${r.pup.name} is born, riding with ${r.pup.parent}.`);
        reload();
        return;
      }
      const r = await burnFlow({ wallet: address, kind: "spawn", signAndSend, verifyUrl: "/api/rats/spawn", verifyBody: {}, onStep: setStep });
      setStep(r.queued ? `${r.rat.name} is queued for the next litter.` : `${r.rat.name} is born and digging.`);
      reload();
    } catch (e: any) {
      setErr(e.message);
      setStep("");
    } finally {
      setBusy(false);
    }
  };

  const l = data?.litter;
  const cells = l ? Array.from({ length: Math.min(l.size, 400) }, (_, i) => i < l.spawned) : [];
  const realRats = data?.rats || [];
  const ratPrice = data?.myPrice ?? data?.costs.spawn ?? 100000;
  const price = kind === "pup" ? data?.costs.pup ?? 25000 : ratPrice;
  const discounted = kind === "spawn" && data && ratPrice < data.costs.spawn;
  const adults = realRats.filter((r) => r.active);
  const pupsLeft = data ? data.costs.pupMax - data.pups.length : null;

  return (
    <>
      <section className="grid g-main">
        <div className="panel glow">
          <div className="ph">
            <span><Info k="litter"><b>litter {l?.n ?? 1}</b></Info> · {l ? `${l.spawned} / ${l.size} born` : "…"}</span>
            <span>{l?.open ? <span className="green">OPEN</span> : <span style={{ color: "var(--dust)" }}>CLOSED</span>}</span>
          </div>
          <div className="pb">
            <div className="litter">{cells.map((on, i) => <i key={i} className={on ? "on" : ""} />)}</div>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Rats come in weekly litters. When a litter sells out, the next one opens the following week. Late burns queue for the next litter automatically.
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="ph"><span><Info k="t_spawn"><b>spawn</b></Info> · burn {num(price)} $RAT{discounted ? <span className="tiny muted"> (30% off your next rat)</span> : null}</span></div>
          <div className="spawn-tabs">
            <button className={kind === "spawn" ? "on" : ""} onClick={() => setKind("spawn")}>
              <b>rat</b> <span>{num(data?.costs.spawn ?? 100000)}</span>
            </button>
            <button className={kind === "pup" ? "on" : ""} onClick={() => setKind("pup")}>
              <b><Info k="pup">pup</Info></b> <span>{num(data?.costs.pup ?? 25000)}</span>
            </button>
          </div>
          <div className="pb">
            {!data?.live ? (
              <p className="muted small" style={{ marginTop: 0 }}>Spawning opens the moment $RAT is live. Litter 1: {l?.size ?? 100} rats.</p>
            ) : (
              <>
                {kind === "pup" && (
                  <label className="pup-pick">
                    <span className="tiny muted">rides with</span>
                    <select className="input" value={parent} onChange={(e) => setParent(e.target.value)}>
                      <option value="">any rat (the one with the fewest pups)</option>
                      {adults.map((r) => (
                        <option key={r.name} value={r.name}>{r.name} · owner {short(r.owner)}</option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="row between">
                  <WalletButton />
                  <button className="btn" disabled={!address || busy || (kind === "spawn" ? !l?.open : !adults.length || (pupsLeft ?? 1) <= 0)} onClick={spawn}>
                    {busy ? "Spawning…" : kind === "pup" ? "Burn & spawn pup" : "Burn & spawn"}
                  </button>
                </div>
                {step && <div className="ok">{step}</div>}
                {err && <div className="err">{err}</div>}
              </>
            )}
            {kind === "spawn" ? (
              <div className="small muted mt">
                <div>· Burned for good, verified on chain.</div>
                <div>· 40% of $RAT fees go to rat owners every 12h.</div>
                <div>· A rat must do {data?.costs.minWork ?? 50}+ digs in a round to earn.</div>
                <div>· Every next rat from the same wallet: {num(data?.costs.repeat ?? 70000)} $RAT (30% off).</div>
                <div>· Hold 100K+ $RAT per rat to lift the 2x earn cap. The lowest bag you hold in a round is the one that counts.</div>
              </div>
            ) : (
              <div className="small muted mt">
                <div>· A pup rides with an adult rat and earns when its rat earns.</div>
                <div>· It weighs ×0.25 of a rat. 80% of its share is yours, 20% goes to its rat&apos;s owner.</div>
                <div>· {pupsLeft != null ? `${num(pupsLeft)} of ${num(data!.costs.pupMax)} pups left.` : "1,000 pups in total."}</div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="grid g3 mt">
        <div className="panel">
          <div className="pb stat">
            <div className="k"><Info k="round">Round #{data?.round.id ?? "…"} ends in</Info></div>
            <div className="big rat">{data ? countdown(data.round.endsAt) : "--:--:--"}</div>
            <div className="s">Rounds are 12h. Fees split 60% compute, 40% rat owners.</div>
          </div>
        </div>
        <div className="panel">
          <div className="pb stat">
            <div className="k"><Info k="ratsalive">Rats alive</Info></div>
            <div className="big">{num(realRats.filter((r) => r.active).length)}</div>
            <div className="s">{num(realRats.filter((r) => !r.active).length)} queued for the next litter</div>
          </div>
        </div>
        <div className="panel">
          <div className="pb stat">
            <div className="k"><Info k="bagmult">Bag multiplier per rat</Info></div>
            <div className="small" style={{ lineHeight: 1.8 }}>
              100K → 1x · 500K → 1.25x
              <br />
              1M → 1.5x · 2.5M → 2x
            </div>
            <div className="s">Linear in between. The lowest bag held during the round counts.</div>
          </div>
        </div>
      </section>

      {address && (
        <section className="panel mt">
          <div className="ph"><span><Info k="t_yours"><b>your rats</b></Info> · {short(address)}</span></div>
          <div className="pb">
            {data?.mine.length ? (
              <div className="scroll">
                <table className="tbl">
                  <thead>
                    <tr><th>Rat</th><th><Info k="litter">Litter</Info></th><th><Info k="digs">Digs this round</Info></th><th><Info k="earned">Earned</Info></th><th>Born</th><th><Info k="burntx">Burn</Info></th></tr>
                  </thead>
                  <tbody>
                    {data.mine.map((r) => (
                      <tr key={r.id}>
                        <td className="green">{r.name}</td>
                        <td>{r.active ? r.litter : `${r.litter} (queued)`}</td>
                        <td>
                          {r.work} {r.work >= (data.costs.minWork || 50) ? <span className="green tiny">eligible</span> : <span className="tiny mute2">needs {data.costs.minWork}</span>}
                        </td>
                        <td>{r.earnedSol} ◎</td>
                        <td className="muted">{ago(r.spawnedAt)} ago</td>
                        <td><a href={solscanTx(r.sig)} target="_blank" rel="noreferrer">tx</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <span className="muted small">No rats yet.</span>
            )}
            {!!data?.minePups.length && (
              <div className="scroll mt">
                <table className="tbl">
                  <thead><tr><th><Info k="pup">Pup</Info></th><th>Rides with</th><th><Info k="earned">Earned</Info></th><th>Born</th></tr></thead>
                  <tbody>
                    {data.minePups.map((x) => (
                      <tr key={x.name}><td>{x.name}</td><td className="muted">{x.parent}</td><td>{x.earnedSol} ◎</td><td className="muted">{ago(x.spawnedAt)} ago</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      {realRats.length > 0 && (
        <section className="panel mt">
          <div className="ph"><span><Info k="t_top"><b>top rats</b></Info> · all time</span></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>#</th><th>Rat</th><th>Owner</th><th><Info k="digsall">Digs all time</Info></th><th><Info k="digs">This round</Info></th><th><Info k="earned">Earned</Info></th></tr></thead>
              <tbody>
                {[...realRats].sort((a, b) => b.workAll - a.workAll).slice(0, 10).map((r, i) => (
                  <tr key={r.id}>
                    <td className="muted">{i + 1}</td>
                    <td className="green">{r.name}</td>
                    <td className="muted">{short(r.owner)}</td>
                    <td>{num(r.workAll)}</td>
                    <td>{num(r.work)}</td>
                    <td>{r.earnedSol} ◎</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel mt">
        <div className="ph"><span><Info k="t_screens"><b>rat screens</b></Info> · live</span><span>{realRats.length ? `${realRats.length} rats` : "scouts on duty until litter 1"}</span></div>
        <div className="pb">
          <div className="screens">
            {(realRats.length ? realRats : []).map((r) => (
              <div key={r.id} className={`screen ${r.active ? "" : "queued"}`}>
                <div className="nm">{r.name}</div>
                <div className="ln2">owner {short(r.owner)}</div>
                <div className="ln2">{r.last ? `${r.last.kind} $${r.last.symbol} · ${ago(r.last.at)}` : "sniffing around…"}</div>
                <div className="ln2">digs {r.work} this round · {num(r.workAll)} total</div>
                <div className="meter"><i style={{ width: `${Math.min(100, (r.work / (data?.costs.minWork || 50)) * 100)}%` }} /></div>
              </div>
            ))}
            {!realRats.length &&
              (data?.scouts.length ? data.scouts : Array.from({ length: 8 }, (_, i) => ({ name: `SCOUT-${i + 1}`, last: null as any }))).map((sc) => (
                <div key={sc.name} className="screen scout">
                  <div className="nm">{sc.name}</div>
                  <div className="ln2">house rat · not owned</div>
                  <div className="ln2">{sc.last ? `${sc.last.kind} $${sc.last.symbol} · ${ago(sc.last.at)}` : "waking up…"}</div>
                </div>
              ))}
          </div>
        </div>
      </section>
    </>
  );
}
