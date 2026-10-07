"use client";
// Every loop and agent, with when it last finished a pass. Red = stalled (silent for 3x its normal pace).
import { usePoll } from "./usePoll";

type P = { name: string; age: number | null; ok: boolean; stalled: boolean; note: string };
const LABEL: Record<string, string> = { desk: "desk", rats_fast: "rats (fast)", rats_slow: "rats (slow)", stream: "live stream", flash: "FLASH", historian: "historian", catch: "CATCH", momo: "MOMO", hound: "HOUND", mind: "MIND", lens: "LENS", overseer: "OVERSEER", wire: "WIRE", j7: "J7 feed", receipts: "receipts", telegram: "telegram" };
const fmt = (s: number | null) => (s == null ? "never" : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);

export default function AlivePanel() {
  const d = usePoll<{ parts: P[] }>("/api/alive", 5000).data;
  const parts = d?.parts || [];
  const bad = parts.filter((p) => p.stalled || !p.ok).length;
  return (
    <section className="panel">
      <div className="ph">
        <span><b>all systems</b> · every loop and agent, last finished pass</span>
        <span className={`tiny ${bad ? "red" : "green"}`}>{d ? (bad ? `${bad} need a look` : "all running") : "…"}</span>
      </div>
      <div className="pb alive-grid">
        {parts.map((p) => (
          <div key={p.name} className={`alive-c ${p.stalled ? "is-bad" : !p.ok ? "is-warn" : ""}`} title={p.note}>
            <i />
            <span>{LABEL[p.name] || p.name}</span>
            <b>{fmt(p.age)}</b>
          </div>
        ))}
      </div>
    </section>
  );
}
