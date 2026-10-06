"use client";
import { Logo, useVenues } from "./venues";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { chg, short, usd } from "./fmt";

// A fast, information-dense alert: who called it, how strong, what the tape and the wallets say, and one tap to trade.

export type Kind = "bond" | "near" | "grad" | "desk";
export type AlertT = { id: string; kind: Kind; title: string; sub: string; mint: string; symbol: string; at: number; king?: number | null; nano?: number | null; who?: string };
export type Term = "gmgn" | "axiom" | "fomo" | "pump" | "dex";
// alert buy buttons use the same referral links as the rest of the site
export const TERMS: Record<Term, { label: string }> = {
  gmgn: { label: "GMGN" },
  axiom: { label: "Axiom" },
  fomo: { label: "FOMO" },
  pump: { label: "pump.fun" },
  dex: { label: "DexScreener" },
};

const KIND: Record<Kind, { label: string; color: string; glow: string }> = {
  bond: { label: "BOND CALL", color: "var(--bond)", glow: "rgba(255,181,71,.35)" },
  near: { label: "ABOUT TO BOND", color: "var(--watch)", glow: "rgba(127,209,255,.3)" },
  grad: { label: "GRADUATED", color: "var(--rat)", glow: "rgba(140,255,90,.35)" },
  desk: { label: "DESK TRADE", color: "#ff7ab6", glow: "rgba(255,122,182,.3)" },
};

type Coin = {
  launch: null | {
    name: string;
    image: string;
    twitter: string;
    telegram: string;
    website: string;
    devN: number;
    devB: number;
    pNow?: number;
    outcome?: string;
    createdAt: number;
    tape?: { n: number; uniq: number; solPerBuy: number; buyShare: number; bundleShare: number; sniperN: number; devSold: number } | null;
    g?: { smartN: number; clRatio: number; clN: number; clB: number } | null;
    meta?: { hot: string | null; lift: number; copy: boolean } | null;
  };
  call: null | { score: number; verdict: string; nano?: { score: number; verdict: string } | null };
  mkt: null | { mc: number | null; c5: number | null; v5: number; b1: number; s1: number; liq: number | null };
  run?: null | { pk: number; x: number | null };
};

function useCoin(mint: string) {
  const [d, setD] = useState<Coin | null>(null);
  useEffect(() => {
    let dead = false;
    const go = () =>
      fetch(`/api/coin/${mint}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => !dead && j && setD(j))
        .catch(() => {});
    go();
    const t = setInterval(go, 5000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [mint]);
  return d;
}

function useAge(at: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - at) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const Ring = ({ v, label, color }: { v: number | null | undefined; label: string; color: string }) => {
  const p = Math.max(0, Math.min(100, v ?? 0));
  const R = 15;
  const C = 2 * Math.PI * R;
  return (
    <div className="ac-ring" title={`${label} ${v ?? "–"}/100`}>
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden>
        <circle cx="20" cy="20" r={R} fill="none" stroke="var(--line2)" strokeWidth="3" />
        <circle cx="20" cy="20" r={R} fill="none" stroke={color} strokeWidth="3" strokeDasharray={`${(p / 100) * C} ${C}`} transform="rotate(-90 20 20)" strokeLinecap="butt" />
      </svg>
      <b style={{ color }}>{v ?? "–"}</b>
      <span>{label}</span>
    </div>
  );
};

export default function AlertCard({ t, term, top, pinned, onClose, onPin, onHover, onRaise, life }: { t: AlertT; term: Term; top: boolean; pinned: boolean; onClose: () => void; onPin: () => void; onHover: (h: boolean) => void; onRaise?: () => void; life: number }) {
  const url = useVenues();
  const d = useCoin(t.mint);
  const age = useAge(t.at);
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);
  const k = KIND[t.kind];
  const l = d?.launch;
  const m = d?.mkt;
  const king = d?.call?.score ?? t.king ?? null;
  const nano = d?.call?.nano?.score ?? t.nano ?? null;
  const curve = l?.outcome === "BONDED" || t.kind === "grad" ? 100 : l?.pNow ?? null;
  const tape = l?.tape;
  const g = l?.g;
  const ref = useRef<HTMLDivElement>(null);

  const copy = () => {
    navigator.clipboard?.writeText(t.mint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  // keyboard: only the newest card listens. B buy, C copy CA, O open, P pin, Esc close
  useEffect(() => {
    if (!top) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "b") window.open(url(TERMS[term] ? term : "gmgn", t.mint), "_blank", "noopener");
      else if (key === "c") copy();
      else if (key === "o") window.location.href = `/c/${t.mint}`;
      else if (key === "p") onPin();
      else if (key === "escape") onClose();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top, term, t.mint, pinned]);

  const flags: { t: string; c: string }[] = [];
  if (g?.smartN) flags.push({ t: `${g.smartN} smart wallet${g.smartN > 1 ? "s" : ""}`, c: "var(--bond)" });
  if (g && g.clRatio >= 2) flags.push({ t: `dev cluster ${g.clRatio}x`, c: "var(--rat)" });
  if (g && g.clN >= 5 && g.clB === 0) flags.push({ t: "factory dev", c: "var(--dust)" });
  if (tape && tape.devSold > 0) flags.push({ t: `dev sold ${tape.devSold}◎`, c: "var(--dust)" });
  if (tape && tape.bundleShare >= 0.4) flags.push({ t: `bundle ${Math.round(tape.bundleShare * 100)}%`, c: "var(--dust)" });
  if (l?.meta?.copy) flags.push({ t: "copycat", c: "var(--dust)" });
  if (l?.meta?.hot) flags.push({ t: `meta "${l.meta.hot}"`, c: "var(--watch)" });
  if (l && l.devN === 0) flags.push({ t: "fresh dev", c: "var(--dim)" });
  else if (l && l.devB > 0) flags.push({ t: `dev ${l.devB}/${l.devN} bonded`, c: "var(--rat)" });

  return (
    <div
      ref={ref}
      className={`acard ${top ? "ac-first" : ""}`}
      style={{ ["--ac" as any]: k.color, ["--glow" as any]: k.glow }}
      onMouseEnter={() => {
        setHover(true);
        onHover(true);
      }}
      onMouseLeave={() => {
        setHover(false);
        onHover(false);
      }}
      role="alert"
    >
      <div className="ac-head">
        <span className="ac-kind">{k.label}</span>
        {!top && <button className="ac-hsym" onClick={onRaise} title="Show this alert">${t.symbol}</button>}
        {t.who && <span className="ac-who">{t.who}</span>}
        <span className="ac-age">{age}</span>
        <button className={`ac-ico ${pinned ? "on" : ""}`} onClick={onPin} title="Pin (P)" aria-label="Pin">
          <svg width="12" height="12" viewBox="0 0 12 12" shapeRendering="crispEdges" fill="currentColor" aria-hidden>
            <rect x="3" y="1" width="6" height="1" /><rect x="4" y="2" width="4" height="4" /><rect x="2" y="6" width="8" height="1" /><rect x="5" y="7" width="2" height="4" />
          </svg>
        </button>
        <button className="ac-ico" onClick={onClose} title="Close (Esc)" aria-label="Close">×</button>
      </div>

      <div className="ac-body">
        <div className="ac-id">
          <div className="ac-img">{l?.image ? <img src={l.image} alt="" loading="lazy" /> : <span>{t.symbol.slice(0, 2)}</span>}</div>
          <div style={{ minWidth: 0 }}>
            <Link href={`/c/${t.mint}`} className="ac-sym">${t.symbol}</Link>
            <div className="ac-name">{(l?.name || "").slice(0, 26)}</div>
            <button className="ac-ca" onClick={copy} title="Copy CA (C)">{copied ? "copied ✓" : short(t.mint, 5, 5)}</button>
          </div>
        </div>
        <div className="ac-rings">
          <Ring v={king} label="KING" color="var(--bond)" />
          <Ring v={nano} label="NANO" color="var(--rat)" />
        </div>
      </div>

      <div className="ac-stats">
        <div><span>MCAP</span><b>{usd(m?.mc)}</b></div>
        <div><span>5M</span><b style={{ color: (m?.c5 ?? 0) >= 0 ? "var(--rat)" : "var(--dust)" }}>{chg(m?.c5)}</b></div>
        <div><span>VOL 5M</span><b>{usd(m?.v5)}</b></div>
        <div><span>TRADERS</span><b>{tape?.uniq ?? "–"}</b></div>
      </div>

      <div className="ac-curve" title="bonding curve">
        <i style={{ width: `${curve ?? 0}%` }} />
        <span>{curve != null ? `curve ${curve}%` : "curve …"}</span>
        {m && m.b1 + m.s1 > 0 && <span className="ac-flow">buys {Math.round((m.b1 / (m.b1 + m.s1)) * 100)}%</span>}
      </div>

      {!!flags.length && (
        <div className="ac-flags">
          {flags.slice(0, 5).map((f) => (
            <span key={f.t} style={{ color: f.c, borderColor: f.c }}>{f.t}</span>
          ))}
        </div>
      )}

      {t.kind === "desk" && <div className="ac-sub">{t.sub}</div>}

      <div className="ac-actions">
        <a className="ac-buy" href={url(TERMS[term] ? term : "gmgn", t.mint)} target="_blank" rel="noreferrer">
          <Logo v={TERMS[term] ? term : "gmgn"} size={13} /> BUY ON {(TERMS[term] || TERMS.gmgn).label.toUpperCase()} <kbd>B</kbd>
        </a>
        <button className="ac-btn" onClick={copy}>{copied ? "✓" : "CA"} <kbd>C</kbd></button>
        <Link className="ac-btn" href={`/c/${t.mint}`}>OPEN <kbd>O</kbd></Link>
        <div className="ac-socials">
          {l?.twitter && <a href={l.twitter.startsWith("http") ? l.twitter : `https://${l.twitter}`} target="_blank" rel="noreferrer nofollow" title="X">X</a>}
          {l?.telegram && <a href={l.telegram.startsWith("http") ? l.telegram : `https://${l.telegram}`} target="_blank" rel="noreferrer nofollow" title="Telegram">TG</a>}
          {l?.website && <a href={l.website.startsWith("http") ? l.website : `https://${l.website}`} target="_blank" rel="noreferrer nofollow" title="Website">WEB</a>}
          <a href={url("dex", t.mint)} target="_blank" rel="noreferrer" title="DexScreener"><Logo v="dex" size={12} /></a>
        </div>
      </div>

      {!pinned && <i className="ac-life" style={{ animationDuration: `${life}ms`, animationPlayState: hover ? "paused" : "running" }} />}
    </div>
  );
}
