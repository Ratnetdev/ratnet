"use client";
// Every loop, with the agents it runs and when it last finished a pass. Red = stalled (silent for 3x its normal pace),
// amber = its last pass reported a problem (the reason shows under it, no hover needed on phones).
import { usePoll } from "./usePoll";

type P = { name: string; age: number | null; ok: boolean; stalled: boolean; note: string };
const LABEL: Record<string, string> = { desk: "desk", rats_fast: "rats (fast)", rats_slow: "rats (slow)", stream: "live stream", flash: "FLASH", historian: "historian", catch: "CATCH", momo: "MOMO", hound: "HOUND", mind: "MIND", lens: "LENS", overseer: "OVERSEER", wire: "WIRE", j7: "J7 feed", receipts: "receipts", telegram: "telegram" };
// the 25 agents, by the loop that runs them (feeds and receipts are plumbing, not agents)
export const RUNS: Record<string, string[]> = {
  desk: ["VET", "FLOW", "BUZZ", "SIZE", "EXEC", "RISK", "COACH", "LEDGER", "FILM", "PM", "PULSE", "SHIELD"],
  rats_fast: ["SCOUT", "KING", "TAPE", "GRAPH"],
  flash: ["FLASH"],
  historian: ["HISTORIAN"],
  catch: ["CATCH"],
  momo: ["MOMO"],
  hound: ["HOUND"],
  mind: ["MIND"],
  lens: ["LENS"],
  overseer: ["OVERSEER"],
  wire: ["WIRE"],
};
const SUB: Record<string, string> = { rats_slow: "hot curves, migrations, lessons", stream: "launches, trades, migrations", j7: "X posts for WIRE", receipts: "hourly proof seals", telegram: "alerts" };
const fmt = (s: number | null) => (s == null ? "never" : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);
// the part of a note worth showing when something is off: the error, not the counters
const why = (p: P) => {
  if (p.stalled) return p.age == null ? "has not reported yet" : `silent for ${fmt(p.age)}`;
  const m = p.note.match(/(?:error|Error)[^,]*:([^,]+)/) || p.note.match(/(pass still running[^,]*)/) || p.note.match(/([^,]*(?:failed|timeout|429|ran past)[^,]*)/i);
  return (m ? m[1] : p.note).trim().slice(0, 70);
};

export default function AlivePanel() {
  const d = usePoll<{ parts: P[] }>("/api/alive", 5000).data;
  const parts = d?.parts || [];
  const bad = parts.filter((p) => p.stalled || !p.ok).length;
  const agents = Object.values(RUNS).reduce((a, x) => a + x.length, 0);
  return (
    <section className="panel">
      <div className="ph">
        <span><b>all systems</b> · {agents} agents in {parts.length || 16} loops, last finished pass</span>
        <span className={`tiny ${bad ? "red" : "green"}`}>{d ? (bad ? `${bad} need a look` : "all running") : "…"}</span>
      </div>
      <div className="pb alive-grid">
        {parts.map((p) => {
          const off = p.stalled || !p.ok;
          return (
            <div key={p.name} className={`alive-c ${p.stalled ? "is-bad" : !p.ok ? "is-warn" : ""}`} title={p.note}>
              <i />
              <span className="alive-n">
                <span>{LABEL[p.name] || p.name}</span>
                <small className={off ? "alive-why" : ""}>{off ? why(p) : RUNS[p.name] && RUNS[p.name].length > 1 ? RUNS[p.name].join(" · ") : SUB[p.name] || ""}</small>
              </span>
              <b>{fmt(p.age)}</b>
            </div>
          );
        })}
      </div>
    </section>
  );
}
