"use client";
import { useState } from "react";
import { usePoll } from "./usePoll";
import { useLive } from "./Live";
import { num } from "./fmt";

type Bucket = { lo: number; n: number; b: number; rate: number | null };
type HourRow = { h: number; d: number; b: number; bn: number; bh: number; nbn: number; nbh: number };
type Receipt = { mint: string; symbol: string; bondedAt: number; secs: number; lead?: number | null; v0: { score: number; verdict: string } | null };
export type ProofData = { v0: Bucket[]; nano: Bucket[]; hourly: HourRow[]; leadAvg: number | null; leadN: number; receipts: Receipt[] };

export function useProof() {
  return usePoll<ProofData>("/api/proof", 30000).data;
}

/** Bond rate per score bucket. If the score means anything, the bars climb left to right. */
export function ScoreChart({ title = true }: { title?: boolean }) {
  const proof = useProof();
  const live = useLive().data as any;
  const [model, setModel] = useState<"v0" | "nano">("v0");
  const rows = proof?.[model] || [];
  const base = live?.stats?.baseRate ?? null;
  const max = Math.max(5, ...rows.map((r) => r.rate ?? 0), base ?? 0);
  const hi = rows.slice(6).reduce((a, r) => ({ n: a.n + r.n, b: a.b + r.b }), { n: 0, b: 0 });
  const lo = rows.slice(0, 3).reduce((a, r) => ({ n: a.n + r.n, b: a.b + r.b }), { n: 0, b: 0 });
  const pc = (x: { n: number; b: number }) => (x.n ? Math.round((x.b / x.n) * 1000) / 10 : null);
  const H = 160;
  return (
    <div className="panel">
      <div className="ph">
        <span><b>does the score mean anything?</b> · graduation rate by score</span>
        <span className="row" style={{ gap: 6 }}>
          {(["v0", "nano"] as const).map((m) => (
            <button key={m} className={`btn ${model === m ? "" : "dim"}`} style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => setModel(m)}>{m}</button>
          ))}
        </span>
      </div>
      <div className="pb">
        {title && (
          <p className="small" style={{ marginTop: 0 }}>
            {hi.n >= 5 && lo.n >= 5 ? (
              <>
                Coins scored <b style={{ color: "var(--bond)" }}>60+</b> graduated <b style={{ color: "var(--bond)" }}>{pc(hi)}%</b> of the time. Coins under <b style={{ color: "var(--dust)" }}>30</b>: <b style={{ color: "var(--dust)" }}>{pc(lo)}%</b>.
              </>
            ) : (
              <span className="muted">Each bar is the share of coins with that score that graduated. It fills in as calls come in.</span>
            )}
          </p>
        )}
        <svg viewBox={`0 0 600 ${H + 40}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="graduation rate by score bucket">
          {base != null && (
            <g>
              <line x1="0" x2="600" y1={H - (base / max) * H} y2={H - (base / max) * H} stroke="var(--dim)" strokeDasharray="4 4" />
              <text x="596" y={H - (base / max) * H - 4} fill="var(--dim)" fontSize="10" textAnchor="end">random {base}%</text>
            </g>
          )}
          {rows.map((r, i) => {
            const h = ((r.rate ?? 0) / max) * H;
            const x = i * 60 + 8;
            const col = r.lo >= 60 ? "var(--bond)" : r.lo >= 30 ? "var(--watch)" : "var(--dust)";
            return (
              <g key={r.lo}>
                <title>{`${r.lo}-${r.lo + 9}: ${r.b} of ${r.n} graduated`}</title>
                <rect x={x} y={H - h} width="44" height={Math.max(1, h)} fill={col} opacity={r.n < 5 ? 0.35 : 0.9} />
                {r.rate != null && r.n >= 1 && <text x={x + 22} y={H - h - 5} fill="var(--text)" fontSize="11" textAnchor="middle">{r.rate}%</text>}
                <text x={x + 22} y={H + 15} fill="var(--dim)" fontSize="10" textAnchor="middle">{r.lo === 90 ? "90+" : `${r.lo}-${r.lo + 9}`}</text>
                <text x={x + 22} y={H + 29} fill="var(--mute)" fontSize="9" textAnchor="middle">{num(r.n)}</text>
              </g>
            );
          })}
        </svg>
        <div className="tiny muted">Score at minute 5 on the bottom, number of coins under it. Faded bars have fewer than 5 coins. Coins still running count as not graduated yet.</div>
      </div>
    </div>
  );
}

/** Last 24 hours, hour by hour: King BOND hit rate against the random base rate. */
export function HourlyChart() {
  const proof = useProof();
  const rows = proof?.hourly || [];
  const pts = rows.map((r) => ({ ...r, hit: r.bn ? (r.bh / r.bn) * 100 : null, base: r.d ? (r.b / r.d) * 100 : null }));
  const max = Math.max(5, ...pts.map((p) => p.hit ?? 0), ...pts.map((p) => p.base ?? 0));
  const W = 600;
  const H = 140;
  const bw = W / 24;
  const basePath = pts
    .map((p, i) => (p.base == null ? null : `${i * bw + bw / 2},${H - (p.base / max) * H}`))
    .filter(Boolean)
    .join(" L");
  return (
    <div className="panel">
      <div className="ph"><span><b>last 24 hours</b> · King BOND hit rate per hour vs random</span></div>
      <div className="pb">
        <svg viewBox={`0 0 ${W} ${H + 22}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="hourly hit rate">
          {pts.map((p, i) => {
            const h = ((p.hit ?? 0) / max) * H;
            return (
              <g key={p.h}>
                <title>{`${new Date(p.h).toISOString().slice(11, 13)}:00 UTC · BOND ${p.bh}/${p.bn}${p.hit != null ? ` (${p.hit.toFixed(1)}%)` : ""} · random ${p.b}/${p.d}`}</title>
                <rect x={i * bw + 3} y={H - h} width={bw - 6} height={Math.max(p.bn ? 1 : 0, h)} fill="var(--bond)" opacity={p.bn < 3 ? 0.35 : 0.9} />
                {i % 3 === 0 && <text x={i * bw + bw / 2} y={H + 15} fill="var(--mute)" fontSize="9" textAnchor="middle">{new Date(p.h).toISOString().slice(11, 13)}h</text>}
              </g>
            );
          })}
          {basePath && <path d={`M${basePath}`} fill="none" stroke="var(--dim)" strokeWidth="1.5" strokeDasharray="4 3" />}
        </svg>
        <div className="tiny muted"><span style={{ color: "var(--bond)" }}>■</span> King BOND calls that graduated · <span>- - -</span> random launch. Hours by launch time (UTC). Recent hours keep rising as their coins graduate.</div>
      </div>
    </div>
  );
}
