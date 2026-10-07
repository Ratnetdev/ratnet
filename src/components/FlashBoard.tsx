"use client";
// FLASH on /desk: every launch read from the live stream at 15, 45 and 90 seconds. Its honest record per look time
// (bonded within the hour), whether a look time has earned the right to trade, and what it is looking at now.
import Link from "next/link";
import { usePoll } from "./usePoll";
import { ago } from "./fmt";

type Cut = { band: number; n: number; hit: number; base: number } | null;
type V = {
  model: { n: number; pos: number; ready: boolean; need: number };
  stages: { stage: number; n: number; hit: number; cut: Cut }[];
  live: { at: number; top: { mint: string; sym: string; stage: number; p: number; prior: number; prog: number; uniq: number; why: string[] }[] } | null;
};
const pc = (h: number, n: number) => (n ? `${((h / n) * 100).toFixed(1)}%` : "–");

export default function FlashBoard() {
  const v = usePoll<V>("/api/flash", 3000).data;
  const ready = !!v?.model.ready;
  return (
    <section className="panel">
      <div className="ph">
        <span><b>FLASH</b> · every launch read at 15, 45 and 90 seconds, from the live trade stream</span>
        <span className="tiny muted">{v ? (ready ? `model live · ${v.model.n} labels, ${v.model.pos} bonds` : `learning · ${v.model.n}/${v.model.need} labels`) : ""}</span>
      </div>
      <div className="pb">
        <table className="tbl">
          <thead><tr><th>Look</th><th>Looks labelled</th><th>Bonded within 1h</th><th>Trading</th></tr></thead>
          <tbody>
            {(v?.stages || []).map((s) => (
              <tr key={s.stage}>
                <td>{s.stage}s</td>
                <td className="muted">{s.n}</td>
                <td>{pc(s.hit, s.n)}</td>
                <td className={s.cut ? "green" : "muted"}>{s.cut ? `on: scores ${Math.round(s.cut.band * 100)}+ bond ${Math.round(s.cut.hit * 100)}% (base ${(s.cut.base * 100).toFixed(1)}%)` : "not yet: earns it with its record"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="tiny muted mt">Looking at now{v?.live ? ` · ${ago(v.live.at)} ago` : ""}</div>
        <table className="tbl">
          <thead><tr><th>Coin</th><th>Look</th><th>Curve</th><th>Wallets</th><th>{ready ? "P(2x, held)" : "Score"}</th><th className="hide-m">Why</th></tr></thead>
          <tbody>
            {(v?.live?.top || []).slice(0, 10).map((x) => (
              <tr key={`${x.mint}${x.stage}`}>
                <td><Link href={`/c/${x.mint}`}>${x.sym}</Link></td>
                <td className="muted">{x.stage}s</td>
                <td>{x.prog}%</td>
                <td className="muted">{x.uniq}</td>
                <td>{ready ? `${Math.round(x.p * 100)}%` : x.prior}</td>
                <td className="hide-m muted">{x.why.slice(0, 2).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
