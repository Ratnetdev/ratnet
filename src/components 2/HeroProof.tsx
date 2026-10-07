"use client";
import Link from "next/link";
import { useLive } from "./Live";
import { useProof } from "./Proof";
import CountUp from "./CountUp";
import Info from "./Info";
import { fmtSecs } from "./Grads";

/** Two numbers that say why this matters. Everything else lives behind the "?". */
export default function HeroProof() {
  const ld = useLive().data as any;
  const s = ld?.stats;
  const desk = ld?.desk as { eq: number; base: number; live: boolean } | null;
  const dg = desk && desk.base ? ((desk.eq - desk.base) / desk.base) * 100 : null;
  const proof = useProof();
  const ready = s && s.bond.n >= 10 && s.baseRate > 0 && s.bond.rate != null;
  const lift = ready ? Math.round((s.bond.rate / s.baseRate) * 10) / 10 : null;
  return (
    <div className="hero-proof">
      <span className="chip">
        <b className="green">{lift ? <><CountUp value={lift} decimals={1} />x</> : "–"}</b>
        <Info k="lift">{lift ? "vs random" : "vs random, warming up"}</Info>
      </span>
      <span className="chip">
        <b style={{ color: "var(--bond)" }}>{proof?.leadAvg != null ? fmtSecs(proof.leadAvg) : "–"}</b>
        <Info k="lead">head start</Info>
      </span>
      <Link href="/desk" className="chip" style={{ textDecoration: "none" }}>
        <b style={{ color: dg == null || dg >= 0 ? "var(--rat)" : "var(--dust)" }}>{dg == null ? "–" : `${dg >= 0 ? "+" : ""}${dg.toFixed(1)}%`}</b>
        <span>{desk?.live ? "live desk" : "desk (paper)"} →</span>
      </Link>
    </div>
  );
}
