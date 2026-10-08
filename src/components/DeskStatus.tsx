"use client";
import Link from "next/link";
import { useLive } from "./Live";

type Exam = { live: boolean; passed: number; total: number; checks: { l: string; ok: boolean; now: string; need: string }[]; walletSol: number | null; wallet: string | null };

/** Front and centre: this agent will trade its own wallet, and here is how close it is. */
export default function DeskStatus() {
  const d = (useLive().data as any)?.desk as { eq: number; base: number; live: boolean; exam?: Exam | null } | null;
  const ex = d?.exam;
  const live = !!d?.live;
  const total = ex?.total ?? 6; // v0.1.47: the exam has six checks
  const passed = ex?.passed ?? 0;
  const pnl = d && d.base ? ((d.eq - d.base) / d.base) * 100 : null;
  return (
    <Link href="/desk" className={`desk-status ${live ? "is-live" : ""}`}>
      <span className="ds-tag">
        <i />
        {live ? "LIVE" : "IN TRAINING"}
      </span>
      <span className="ds-main">
        <b>{live ? "Trading its own wallet" : "Self-trading agent, learning on paper"}</b>
        <span>
          {live
            ? `Every buy and sell on chain${ex?.walletSol != null ? `, wallet ${ex.walletSol.toFixed(2)} SOL` : ""}${pnl != null ? `, ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%` : ""}.`
            : `It earns its own wallet${ex?.walletSol != null ? ` (${ex.walletSol.toFixed(2)} SOL)` : ""} by passing its exam.${pnl != null ? ` Paper ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}% so far.` : ""}`}
        </span>
      </span>
      {!live && (
        <span className="ds-exam" title={(ex?.checks || []).map((c) => `${c.ok ? "✓" : "·"} ${c.l}: ${c.now} / ${c.need}`).join("\n")}>
          {Array.from({ length: total }, (_, i) => (
            <i key={i} className={i < passed ? "ok" : ""} />
          ))}
          <em>{d ? `${passed}/${total}` : "…"}</em>
        </span>
      )}
      <span className="ds-go">watch →</span>
    </Link>
  );
}
