"use client";
// A coin's logo, served through /api/img (cached at the edge, several IPFS gateways raced, ticker badge fallback).
// If even that fails in the browser, a local ticker badge is drawn so a row is never blank.
import { useState } from "react";

const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;

export default function CoinImg({ mint, sym, size = 18, className = "" }: { mint?: string | null; sym?: string | null; size?: number; className?: string }) {
  const [bad, setBad] = useState(false);
  if (!mint) return null;
  const s = (sym || "").replace(/^\$/, "");
  if (bad)
    return (
      <span className={`cimg cimg-l ${className}`} style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.42)), background: `hsl(${hue(mint)} 45% 22%)`, color: `hsl(${hue(mint)} 80% 72%)` }}>
        {(s || "?").slice(0, 2).toUpperCase()}
      </span>
    );
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={`cimg ${className}`} src={`/api/img/${mint}${s ? `?s=${encodeURIComponent(s)}` : ""}`} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setBad(true)} style={{ width: size, height: size }} />;
}
