"use client";
import { useState } from "react";
import { usePoll } from "./usePoll";
import { Call, CallList } from "./Calls";
import type { Stats } from "./LiveBoard";
import { num } from "./fmt";

type King = {
  calls: Call[];
  resolved: Call[];
  stats: Stats;
  weights: { key: string; label: string; max: number }[];
  verdicts: { bond: number; watch: number };
  version: string;
};

export default function KingBoard() {
  const [page, setPage] = useState(0);
  const [tab, setTab] = useState<"latest" | "resolved">("latest");
  const { data } = usePoll<King>(`/api/king?page=${page}`, 8000);
  const s = data?.stats;
  return (
    <>
      <section className="grid g4">
        {[
          ["BOND calls", s?.bond, "var(--bond)", (x: any) => `${num(x.hit)} of ${num(x.res)} bonded`],
          ["WATCH calls", s?.watch, "var(--watch)", (x: any) => `${num(x.bonded)} of ${num(x.res)} bonded`],
          ["DUST calls", s?.dust, "var(--dust)", (x: any) => `${num(x.hit)} of ${num(x.res)} did not bond`],
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
            <div className="s">{s ? `${num(s.bonded)} of ${num(s.resolved)} launches bonded` : "–"}</div>
          </div>
        </div>
      </section>

      <section className="grid g-main mt">
        <div className="panel">
          <div className="ph">
            <span className="row" style={{ gap: 14 }}>
              <a onClick={() => setTab("latest")} style={{ cursor: "pointer", color: tab === "latest" ? "var(--rat)" : undefined }}>latest calls</a>
              <a onClick={() => setTab("resolved")} style={{ cursor: "pointer", color: tab === "resolved" ? "var(--rat)" : undefined }}>just resolved</a>
            </span>
            {tab === "latest" && (
              <span className="row">
                <button className="btn dim" style={{ padding: "3px 10px" }} disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
                <span className="tiny">page {page + 1}</span>
                <button className="btn dim" style={{ padding: "3px 10px" }} disabled={(data?.calls.length || 0) < 60} onClick={() => setPage(page + 1)}>›</button>
              </span>
            )}
          </div>
          <CallList calls={(tab === "latest" ? data?.calls : data?.resolved) || []} />
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
              <div>· Outcome is read from the bonding curve: BONDED the moment the curve completes, else at 24h ALIVE or DIED (under 5% curve).</div>
              <div>· BOND is right if it bonded. DUST is right if it did not.</div>
              <div>· Nothing is deleted. Misses stay on the board.</div>
            </div>
          </div>
          <div className="panel">
            <div className="ph"><span><b>next</b> · rat king v1</span><span className="pill soon">training</span></div>
            <div className="pb small muted">
              Trained from scratch on the dug dataset. Public loss curve, hit rate per version, weights on Hugging Face after the first epoch. v1 runs side by side with v0 so you can see it win or lose.
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
