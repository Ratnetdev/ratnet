"use client";
// One chart for the whole site: a line or bars over time, one y-axis, a crosshair with a tooltip on hover (or touch),
// and an optional dashed reference series in the same unit (e.g. the base rate under the King's hit rate).
import { useEffect, useRef, useState } from "react";

export type Series = { name: string; color: string; points: { t: number; v: number | null }[]; dashed?: boolean };

const fmtT = (t: number, bucket: "hour" | "day" | "minute") => {
  const d = new Date(t);
  if (bucket === "day") return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + (bucket === "hour" ? "" : "");
};

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export default function Chart({ series, kind = "line", unit = "", bucket = "hour", height = 220, digits = 1, zeroBase = true, empty = "No data yet.", polar = false, xLabel }: { series: Series[]; kind?: "line" | "bar"; unit?: string; bucket?: "hour" | "day" | "minute"; height?: number; digits?: number; zeroBase?: boolean; empty?: string; polar?: boolean; xLabel?: (i: number) => string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(260, Math.round(el.clientWidth))));
    ro.observe(el);
    setW(Math.max(260, Math.round(el.clientWidth)));
    return () => ro.disconnect();
  }, []);

  const main = series[0];
  const pts = main?.points || [];
  const vals = series.flatMap((s) => s.points.map((p) => p.v)).filter((v): v is number => v != null && Number.isFinite(v));
  if (!pts.length || !vals.length)
    return (
      <div ref={wrap} className="chart-empty muted small" style={{ height }}>
        {empty}
      </div>
    );

  const L = 46;
  const R = 12;
  const T = 12;
  const B = 26;
  const H = height;
  const iw = w - L - R;
  const ih = H - T - B;
  const lo0 = Math.min(...vals);
  const hi0 = Math.max(...vals);
  const lo = zeroBase ? Math.min(0, lo0) : lo0 - (hi0 - lo0) * 0.1;
  const hi = zeroBase ? niceMax(hi0) : hi0 + (hi0 - lo0) * 0.1 || hi0 + 1;
  const n = pts.length;
  const x = (i: number) => (kind === "bar" ? L + (iw / n) * (i + 0.5) : L + (n === 1 ? iw / 2 : (iw * i) / (n - 1)));
  const y = (v: number) => T + ih - ((v - lo) / Math.max(1e-9, hi - lo)) * ih;
  const ticks = [lo, lo + (hi - lo) / 2, hi];
  const fv = (v: number | null) => (v == null ? "–" : `${v.toFixed(digits)}${unit}`);
  const path = (s: Series) => {
    let d = "";
    let pen = false;
    s.points.forEach((p, i) => {
      if (p.v == null || !Number.isFinite(p.v)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const bw = Math.min(32, Math.max(2, iw / n - 2)); // bars never get fatter than 32px, however few
  const onMove = (cx: number) => {
    const rel = cx - L;
    const i = kind === "bar" ? Math.floor(rel / (iw / n)) : Math.round((rel / iw) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };
  const hx = hover != null ? x(hover) : 0;
  const tipLeft = hover != null && hx > w * 0.6;

  return (
    <div ref={wrap} className="chart" style={{ height, position: "relative" }}>
      <svg
        width={w}
        height={H}
        role="img"
        aria-label={`${main.name} chart`}
        onMouseMove={(e) => onMove(e.clientX - (e.currentTarget.getBoundingClientRect().left))}
        onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => onMove(e.touches[0].clientX - e.currentTarget.getBoundingClientRect().left)}
        onTouchMove={(e) => onMove(e.touches[0].clientX - e.currentTarget.getBoundingClientRect().left)}
      >
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={L} x2={w - R} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeDasharray={i === 0 ? undefined : "2 4"} />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize="10" fill="var(--dim)">{v >= 1000 ? `${Math.round(v / 100) / 10}K` : `${Math.round(v * 10) / 10}`}{unit && v < 1000 ? unit : ""}</text>
          </g>
        ))}
        {[0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize="10" fill="var(--dim)">{xLabel ? xLabel(i) : fmtT(pts[i].t, bucket)}</text>
        ))}
        {kind === "bar"
          ? main.points.map((p, i) => (p.v == null ? null : <rect key={i} x={x(i) - bw / 2} y={Math.min(y(p.v), y(0))} width={bw} height={Math.max(1, Math.abs(y(0) - y(p.v)))} rx={2} fill={polar ? (p.v >= 0 ? "var(--rat)" : "var(--dust)") : main.color} opacity={hover == null || hover === i ? 0.9 : 0.45} />))
          : <path d={path(main)} fill="none" stroke={main.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {series.slice(1).map((s) => <path key={s.name} d={path(s)} fill="none" stroke={s.color} strokeWidth={1.5} strokeDasharray={s.dashed ? "4 4" : undefined} opacity={0.85} />)}
        {hover != null && (
          <g pointerEvents="none">
            <line x1={hx} x2={hx} y1={T} y2={T + ih} stroke="var(--dim)" strokeDasharray="2 3" />
            {series.map((s) => {
              const v = s.points[hover]?.v;
              return v == null ? null : <circle key={s.name} cx={hx} cy={y(v)} r={4} fill="var(--bg)" stroke={s.color} strokeWidth={2} />;
            })}
          </g>
        )}
        <rect x={L} y={T} width={iw} height={ih} fill="transparent" />
      </svg>
      {hover != null && (
        <div className="chart-tip" style={{ left: tipLeft ? undefined : hx + 12, right: tipLeft ? w - hx + 12 : undefined, top: 8 }}>
          <div className="muted">{xLabel ? xLabel(hover) : bucket === "day" ? fmtT(pts[hover].t, "day") : `${new Date(pts[hover].t).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${fmtT(pts[hover].t, bucket)}`}</div>
          {series.map((s) => (
            <div key={s.name} className="chart-tip-row">
              <i style={{ background: s.color }} />
              <span>{s.name}</span>
              <b>{fv(s.points[hover]?.v ?? null)}</b>
            </div>
          ))}
        </div>
      )}
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.name}><i style={{ background: s.color, opacity: s.dashed ? 0.7 : 1 }} />{s.name}</span>
          ))}
        </div>
      )}
    </div>
  );
}
