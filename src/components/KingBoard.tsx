"use client";
import { useEffect, useState } from "react";
import GradList, { Grad } from "./Grads";
import { usePoll } from "./usePoll";
import { Call, CallList } from "./Calls";
import type { Stats } from "./LiveBoard";
import { num } from "./fmt";

type King = {
  calls: Call[];
  grads: Grad[];
  nano: { n: number; pos: number; min: number };
  resolved: Call[];
  stats: Stats;
  weights: { key: string; label: string; max: number }[];
  verdicts: { bond: number; watch: number };
  version: string;
};

export default function KingBoard() {
  const [page, setPage] = useState(0);
  const [tab, setTab] = useState<"latest" | "bond" | "grads" | "resolved">("latest");
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "grads" || t === "bond" || t === "resolved") setTab(t);
  }, []);
  const { data } = usePoll<King>(`/api/king?page=${page}${tab === "bond" ? "&verdict=BOND" : ""}`, 8000);
  const s = data?.stats;
  return (
    <>
      <section className="grid g4">
        {[
          ["BOND calls that bonded", s?.bond, "var(--bond)", (x: any) => `${num(x.hit)} of ${num(x.n)} so far`],
          ["WATCH calls that bonded", s?.watch, "var(--watch)", (x: any) => `${num(x.bonded)} of ${num(x.res)} resolved`],
          ["DUST calls right", s?.dust, "var(--dust)", (x: any) => `${num(x.hit)} of ${num(x.res)} resolved`],
        ].map(([label, x, color, sub]: any) => (
          <div className="panel" key={label}>
            <div className="pb stat">
              <div className="k">{label}</div>
              <div className="big" style={{ color }}>{x?.rate != null ? `${x.rate}%` : "–"}</div>
              <div className="s">{x ? `${sub(x)} · ${num(x.n)} made` : "–"}</div>
            </div>
          </div>
        ))}
        <div className="panel">
          <div className="pb stat">
            <div className="k">Base rate</div>
            <div className="big">{s?.baseRate != null ? `${s.baseRate}%` : "–"}</div>
            <div className="s">{s ? `${num(s.bonded)} of ${num(s.dug)} dug launches bonded` : "–"}</div>
          </div>
        </div>
      </section>

      <section className="grid g-main mt">
        <div className="panel">
          <div className="ph">
            <span className="row wrapx" style={{ gap: 14 }}>
              {(
                [
                  ["latest", "latest calls"],
                  ["bond", "BOND calls"],
                  ["grads", "graduations"],
                  ["resolved", "just resolved"],
                ] as const
              ).map(([k, label]) => (
                <a key={k} onClick={() => { setTab(k); setPage(0); }} style={{ cursor: "pointer", color: tab === k ? "var(--rat)" : undefined }}>
                  {label}
                </a>
              ))}
            </span>
            {tab === "latest" && (
              <span className="row">
                <button className="btn dim" style={{ padding: "3px 10px" }} disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
                <span className="tiny">page {page + 1}</span>
                <button className="btn dim" style={{ padding: "3px 10px" }} disabled={(data?.calls.length || 0) < 60} onClick={() => setPage(page + 1)}>›</button>
              </span>
            )}
          </div>
          {tab === "grads" ? <GradList grads={data?.grads || []} full /> : <CallList calls={(tab === "resolved" ? data?.resolved : data?.calls) || []} />}
        </div>

        <div className="grid" style={{ alignContent: "start" }}>
          <div className="panel">
            <div className="ph">
              <span><b>scorer {data?.version || "v0"}</b> · fully public</span>
            </div>
            <div className="pb small">
              <p className="muted" style={{ marginTop: 0 }}>
                v0 is a transparent baseline. No black box: these are the exact weights. It exists so the hit rate is tracked from hour one, and so v1 has a number to beat.
              </p>
              <table className="tbl">
                <tbody>
                  {(data?.weights || []).map((w) => (
                    <tr key={w.key}>
                      <td style={{ whiteSpace: "normal" }}>{w.label}</td>
                      <td className="right green">{w.max}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted tiny">
                Raw points are scaled to 0 to 100. BOND at {data?.verdicts.bond ?? 60}+, WATCH at {data?.verdicts.watch ?? 30} to {(data?.verdicts.bond ?? 60) - 1}, DUST below.
              </p>
            </div>
          </div>
          <div className="panel">
            <div className="ph"><span><b>the rules</b> · how a call is checked</span></div>
            <div className="pb small muted">
              <div>· The call is made 5 minutes after the coin is born.</div>
              <div>· Calls made more than 15 minutes after birth are marked late and never count.</div>
              <div>· BONDED the moment the curve completes (the rats re-check hot curves every few seconds).</div>
              <div>· DIED early if the curve is under 1% at the 1-hour check and never passed 3%.</div>
              <div>· Otherwise at 24h: ALIVE, or DIED under 5% curve.</div>
              <div>· BOND hit rate = BOND calls that bonded / all BOND calls. A pending call counts as a miss until it bonds.</div>
              <div>· DUST is right if it did not bond.</div>
              <div>· Nothing is deleted. Misses stay on the board.</div>
            </div>
          </div>
          <div className="panel">
            <div className="ph"><span><b>nano</b> · learning live</span><a href="/lab">lab →</a></div>
            <div className="pb small muted">
              Next to v0, Rat King nano learns from scratch on every outcome the rats record. {data?.nano ? `${data.nano.n} lessons so far, ${data.nano.pos} of them bonds.` : ""} Its calls count once it has {data?.nano?.min ?? 200} lessons. After nano comes v1: a model pretrained from scratch on the full dataset, weights on Hugging Face.
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
