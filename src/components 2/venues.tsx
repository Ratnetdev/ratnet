"use client";
// Trade buttons with logos, used on every coin across the site. Templates (with your referral codes) come from the
// server with the live feed; until they arrive the plain links work.
import { useState } from "react";
import { useLive } from "./Live";

export type Venue = "pump" | "dex" | "gmgn" | "axiom" | "fomo";
export const VENUE: Record<Venue, { label: string; domain: string; plain: string }> = {
  pump: { label: "pump.fun", domain: "pump.fun", plain: "https://pump.fun/coin/{ca}" },
  dex: { label: "DexScreener", domain: "dexscreener.com", plain: "https://dexscreener.com/solana/{ca}" },
  gmgn: { label: "GMGN", domain: "gmgn.ai", plain: "https://gmgn.ai/sol/token/{ca}" },
  axiom: { label: "Axiom", domain: "axiom.trade", plain: "https://axiom.trade/t/{ca}" },
  fomo: { label: "FOMO", domain: "fomo.family", plain: "https://fomo.family" },
};
export const TRADE: Venue[] = ["gmgn", "axiom", "fomo", "pump", "dex"];

export function useVenues() {
  const tpl = ((useLive().data as any)?.live?.venues || {}) as Partial<Record<Venue, string>>;
  return (v: Venue, ca: string) => (tpl[v] || VENUE[v].plain).replace(/\{ca\}/g, ca);
}

export function Logo({ v, size = 14 }: { v: Venue; size?: number }) {
  const [bad, setBad] = useState(false);
  if (bad) return <span className="vlogo vlogo-l" style={{ width: size, height: size, fontSize: Math.round(size * 0.72) }}>{VENUE[v].label[0].toUpperCase()}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="vlogo" src={`/api/logo/${v}`} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setBad(true)} />;
}

/** A row of trade buttons with logos. */
export default function TradeLinks({ ca, only, size = "md" }: { ca: string; only?: Venue[]; size?: "sm" | "md" }) {
  const url = useVenues();
  return (
    <span className={`vrow ${size}`}>
      {(only || TRADE).map((v) => (
        <a key={v} className="vbtn" href={url(v, ca)} target="_blank" rel="noreferrer" title={`Open on ${VENUE[v].label}`}>
          <Logo v={v} size={size === "sm" ? 12 : 14} />
          <span>{VENUE[v].label}</span>
        </a>
      ))}
    </span>
  );
}

/** Logos only, for tight rows (call lists, tables): same links, same referral codes. */
export function TradeIcons({ ca, only }: { ca: string; only?: Venue[] }) {
  const url = useVenues();
  return (
    <span className="vicons" onClick={(e) => e.stopPropagation()}>
      {(only || TRADE).map((v) => (
        <a key={v} href={url(v, ca)} target="_blank" rel="noreferrer" title={`Open on ${VENUE[v].label}`} aria-label={VENUE[v].label}>
          <Logo v={v} size={13} />
        </a>
      ))}
    </span>
  );
}
