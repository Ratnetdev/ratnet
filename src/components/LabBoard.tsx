"use client";
import { usePoll } from "./usePoll";
import { num } from "./fmt";
import type { Stats } from "./LiveBoard";
import Info from "./Info";

type Weights = {
  samples: number;
  bonded_samples: number;
  loss_ema: number;
  acc_ema: number;
  counted_calls_from: number;
  updated_at: number;
  weights: { feature: string; label: string; w: number }[];
  log: { n: number; loss: number; acc: number; pos: number; at: number }[];
};

function LossChart({ log }: { log: Weights["log"] }) {
  const W = 640;
  const H = 200;
  const P = 30;
  if (log.length < 2)
    return <div className="muted small" style={{ height: H, display: "grid", placeItems: "center" }}>The loss curve draws itself as outcomes come in. First point after 25 resolved launches.</div>;
  const xs = log.map((l) => l.n);
  const ys = log.map((l) => l.loss);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys) * 1.05;
  const y0 = Math.max(0, Math.min(...ys) * 0.9);
  const sx = (v: number) => P + ((v - x0) / Math.max(1, x1 - x0)) * (W - P * 2);
  const sy = (v: number) => H - P - ((v - y0) / Math.max(1e-6, y1 - y0)) * (H - P * 2);
  const d = log.map((l, i) => `${i ? "L" : "M"}${sx(l.n).toFixed(1)},${sy(l.loss).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="training loss">
      {[0, 0.5, 1].map((t) => {
        const v = y0 + (y1 - y0) * t;
        return (
          <g key={t}>
            <line x1={P} x2={W - P} y1={sy(v)} y2={sy(v)} stroke="var(--line)" strokeDasharray="3 4" />
            <text x={4} y={sy(v) + 4} fill="var(--mute)" fontSize="10">{v.toFixed(3)}</text>
          </g>
        );
      })}
      <path d={d} fill="none" stroke="var(--rat)" strokeWidth="2" style={{ filter: "drop-shadow(0 0 4px rgba(140,255,90,.5))" }} />
      <text x={W - P} y={H - 8} fill="var(--mute)" fontSize="10" textAnchor="end">{num(x1)} samples</text>
      <text x={P} y={H - 8} fill="var(--mute)" fontSize="10">{num(x0)}</text>
    </svg>
  );
}

function WeightBars({ weights }: { weights: Weights["weights"] }) {
  const max = Math.max(0.01, ...weights.map((w) => Math.abs(w.w)));
  return (
    <table className="tbl">
      <tbody>
        {weights.map((w) => (
          <tr key={w.feature}>
            <td style={{ width: "42%" }}>{w.label}</td>
            <td>
              <div style={{ position: "relative", height: 10, background: "var(--line)" }}>
                <div style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: "var(--mute)" }} />
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: w.w >= 0 ? "50%" : `${50 - (Math.abs(w.w) / max) * 50}%`,
                    width: `${(Math.abs(w.w) / max) * 50}%`,
                    background: w.w >= 0 ? "var(--rat)" : "var(--dust)",
                  }}
                />
              </div>
            </td>
            <td className="right" style={{ width: 70, color: w.w >= 0 ? "var(--rat)" : "var(--dust)" }}>{w.w.toFixed(3)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function LabBoard() {
  const { data } = usePoll<Weights>("/api/king/weights", 15000);
  const { data: king } = usePoll<{ stats: Stats }>("/api/king", 15000);
  const s = king?.stats;
  const ready = (data?.samples ?? 0) >= (data?.counted_calls_from ?? 200);
  const rows: [string, string, string][] = s
    ? [
        ["BOND calls that bonded", s.bond.rate != null ? `${s.bond.rate}% (${s.bond.hit}/${s.bond.n})` : "–", s.nano?.bond.rate != null ? `${s.nano.bond.rate}% (${s.nano.bond.hit}/${s.nano.bond.n})` : "–"],
        ["WATCH calls that bonded", s.watch.rate != null ? `${s.watch.rate}%` : "–", s.nano?.watch.rate != null ? `${s.nano.watch.rate}%` : "–"],
        ["DUST calls that did not bond", s.dust.rate != null ? `${s.dust.rate}%` : "–", s.nano?.dust.rate != null ? `${s.nano.dust.rate}%` : "–"],
        ["BOND calls made", num(s.bond.n), num(s.nano?.bond.n ?? 0)],
        ["Trench base rate", s.baseRate != null ? `${s.baseRate}%` : "–", s.baseRate != null ? `${s.baseRate}%` : "–"],
      ]
    : [];

  return (
    <>
      <section className="grid g4">
        <div className="panel glow"><div className="pb stat"><div className="k"><Info k="samples">Samples learned</Info></div><div className="big rat">{num(data?.samples ?? 0)}</div><div className="s">every resolved launch is one step</div></div></div>
        <div className="panel"><div className="pb stat"><div className="k"><Info k="bondsseen">Bonds seen</Info></div><div className="big" style={{ color: "var(--bond)" }}>{num(data?.bonded_samples ?? 0)}</div><div className="s">the rare positives it learns from</div></div></div>
        <div className="panel"><div className="pb stat"><div className="k"><Info k="loss">Loss (EMA)</Info></div><div className="big">{data ? data.loss_ema.toFixed(3) : "–"}</div><div className="s">log loss, lower is better (0.693 = coin flip)</div></div></div>
        <div className="panel"><div className="pb stat"><div className="k"><Info k="labstatus">Status</Info></div><div className="big" style={{ color: ready ? "var(--rat)" : "var(--watch)" }}>{ready ? "CALLING" : "LEARNING"}</div><div className="s">{ready ? "nano calls count on the board" : `${num(data?.samples ?? 0)} / ${data?.counted_calls_from ?? 200} before its calls count`}</div></div></div>
      </section>

      <section className="grid g-main mt">
        <div className="panel">
          <div className="ph"><span><Info k="t_tloss"><b>training loss</b></Info> · rat king nano · live</span></div>
          <div className="pb"><LossChart log={data?.log || []} /></div>
        </div>
        <div className="panel">
          <div className="ph"><span><Info k="t_vs"><b>v0 vs nano</b></Info> · head to head</span></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th><Info k="counted">Counted calls</Info></th><th><Info k="v0">v0 rules</Info></th><th><Info k="nano">nano</Info></th></tr></thead>
              <tbody>{rows.map(([a, b, c]) => <tr key={a}><td style={{ whiteSpace: "normal" }}>{a}</td><td>{b}</td><td className="green">{c}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="pb tiny muted">Same launches, same moment (5 minutes after birth), same rules for counting. If nano cannot beat the hand-written rules, you will see it here.</div>
        </div>
      </section>

      <section className="grid g2 mt">
        <div className="panel">
          <div className="ph"><span><Info k="t_weights"><b>weights</b></Info> · what it has learned</span><a href="/api/king/weights" target="_blank">json →</a></div>
          <div className="pb">
            {data ? <WeightBars weights={data.weights} /> : <span className="muted small">loading…</span>}
            <p className="tiny muted" style={{ marginBottom: 0 }}>Green pushes a launch toward BOND, red toward DUST. All start at zero. Nothing is hand-tuned.</p>
          </div>
        </div>
        <div className="panel">
          <div className="ph"><span><Info k="t_how"><b>how nano learns</b></Info></span></div>
          <div className="pb small muted">
            <div>· Born at zero. No pretrained weights, no outside data.</div>
            <div>· 5 minutes after each launch, the rats freeze 28 features: curve, climb, dev buy, socials, ticker, the dev&apos;s history, time of day, plus what TAPE, GRAPH and META read: trade speed, SOL per buy, unique traders, bundles, snipers, top-5 share, dev sells, smart wallets, the dev&apos;s funder cluster, copycats and the hot meta.</div>
            <div>· Every lesson waits for the same 2-hour label (bonded within 2h), so winners and losers are learned at the same moment and the model is never fooled by fast winners.</div>
            <div>· A second model does the same at minute 1. The desk may act on it only once its record beats the minute-5 King.</div>
            <div>· The HISTORIAN replays past pump.fun launches in time order, scoring each one before learning from it, so the models start trained.</div>
            <div>· It learns from every graduation, including the ones the King got wrong and the ones that graduated before the 5-minute call (those use what the rats saw at dig time).</div>
            <div>· Bonds are rare (around 1 in 100), so a bond counts 8x in the loss.</div>
            <div>· Its calls only count on the board after {data?.counted_calls_from ?? 200} lessons.</div>
            <div className="mt"><b className="green">Next: Rat King v1.</b> A sequence model pretrained from scratch on the full dug dataset (launch text plus first-hour flow), loss curve public, weights on Hugging Face after the first epoch. Nano is the baseline it has to beat.</div>
          </div>
        </div>
      </section>
    </>
  );
}
