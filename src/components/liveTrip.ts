"use client";
// v0.1.84: an open trade's market cap, change and P&L from the live price (lib/pxcache, rewritten every second from the
// firehose), not from the desk's page copy (rebuilt every ~6s and cached on top: up to ~20s behind). The P&L keeps
// the desk's own math: what came back from sells plus what is still held, the held part moved by the live price.
import { useLivePx } from "./livepx";
import type { Trip } from "./TripDetail";

export function liveTripNumbers(t: Pick<Trip, "open" | "nowMc" | "backSol" | "valueSol" | "costSol" | "pnlSol" | "pnlPct">, liveMc: number | null | undefined) {
  if (!t.open || !liveMc || !t.nowMc || !(t.nowMc > 0)) return { nowMc: t.nowMc ?? null, pnlSol: t.pnlSol, pnlPct: t.pnlPct, live: false };
  const r = liveMc / t.nowMc;
  const back = t.backSol + t.valueSol * r;
  return { nowMc: liveMc, pnlSol: Math.round((back - t.costSol) * 1e4) / 1e4, pnlPct: t.costSol ? Math.round((back / t.costSol - 1) * 1000) / 10 : t.pnlPct, live: true };
}

export function useLiveTrip<T extends Trip>(t: T): T {
  const lp = useLivePx(t.open ? t.mint : null);
  const n = liveTripNumbers(t, lp?.mcUsd);
  return n.live ? { ...t, nowMc: n.nowMc, pnlSol: n.pnlSol, pnlPct: n.pnlPct } : t;
}

/** An open position's price change from the live price (SOL per token), the page copy's while none is in. */
export function useLivePct(mint: string, entryPx: number, lastPx: number) {
  const lp = useLivePx(mint);
  const px = lp?.px && lp.px > 0 ? lp.px : lastPx;
  return entryPx ? ((px - entryPx) / entryPx) * 100 : 0;
}
