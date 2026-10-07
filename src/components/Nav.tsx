"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLive } from "./Live";
import { SITE } from "@/config/site";

type Item = { href: string; label: string; desc: string; tag?: string };
type Group = { label: string; href?: string; items?: Item[] };

// Grouped by what people come to do: watch, trade, check the AI, take part, read up.
const GROUPS: Group[] = [
  { label: "Feed", href: "/" },
  { label: "Desk", href: "/desk" },
  {
    label: "Coins",
    items: [
      { href: "/radar", label: "Radar", desc: "Live coins filling their curve, closest to bonding on top" },
      { href: "/explore", label: "Explore", desc: "Filter every BOND and WATCH call of the last 24h" },
      { href: "/king#runners", label: "Runners", desc: "How far called coins ran after the call" },
      { href: "/sniff", label: "Sniff a coin", desc: "Paste any CA and get the King's read" },
    ],
  },
  {
    label: "Rat King",
    items: [
      { href: "/king", label: "Calls", desc: "Every call, hit rate, graduations, calibration" },
      { href: "/king?tab=fame", label: "Hall of fame", desc: "The BOND calls that ran furthest from the call" },
      { href: "/receipts", label: "Receipts", desc: "Every call sealed on-chain each hour. Verify it yourself" },
      { href: "/lab", label: "Lab", desc: "Models learning live, historian, season, weights" },
      { href: "/status", label: "Status", desc: "Every system, its speed and health, live" },
    ],
  },
  {
    label: "Rats",
    items: [
      { href: "/rats", label: "Spawn a rat", desc: "Burn $RAT for a rat that digs and earns fees", tag: "earn" },
      { href: "/ledger", label: "Ledger", desc: "Payout rounds, burns and fees, with Solscan links" },
    ],
  },
  {
    label: "Docs",
    items: [
      { href: "/docs", label: "How it works", desc: "Rats, the King, the desk, the economy" },
      { href: "/dataset", label: "Dataset", desc: "Daily open drops of every resolved launch" },
      { href: "/developers", label: "API", desc: "Free JSON endpoints, build your own bot" },
    ],
  },
];

const active = (path: string, g: Group) => (g.href ? path === g.href : (g.items || []).some((i) => path === i.href.split("#")[0]));

function DeskDot() {
  const d = (useLive().data as any)?.desk as { live: boolean } | null;
  return <i className={`nav-dot ${d?.live ? "live" : ""}`} title={d?.live ? "trading its own wallet" : "learning on paper"} />;
}

/** Scroll to #hash after a menu click on the same page (Next keeps the scroll position otherwise). */
function goHash(href: string) {
  const h = href.split("#")[1];
  if (!h) return;
  setTimeout(() => document.getElementById(h)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
}

export default function Nav() {
  const path = usePathname();
  const pointer = useRef<string>("mouse");
  const [open, setOpen] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const [going, setGoing] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    setOpen(null);
    setMobile(false);
    setGoing(false);
  }, [path]);
  // any internal link click starts the progress bar, so a click always shows it landed (slow pages included)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement)?.closest?.("a") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || !a.href) return;
      const u = new URL(a.href, location.href);
      if (u.origin !== location.origin || u.pathname === location.pathname) return;
      setGoing(true);
    };
    document.addEventListener("click", onClick, true);
    const t = going ? setTimeout(() => setGoing(false), 10_000) : null;
    return () => {
      document.removeEventListener("click", onClick, true);
      if (t) clearTimeout(t);
    };
  }, [going]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(null);
        setMobile(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  useEffect(() => {
    document.body.style.overflow = mobile ? "hidden" : "";
  }, [mobile]);

  return (
    <nav className="nav" ref={ref}>
      {going && <i className="nav-progress" aria-hidden />}
      <div className="nav-desk">
        {GROUPS.map((g) =>
          g.href ? (
            <Link key={g.label} href={g.href} className={`nav-top ${active(path, g) ? "on" : ""}`} onClick={() => setOpen(null)}>
              {g.label}
              {g.href === "/desk" && <DeskDot />}
            </Link>
          ) : (
            <div key={g.label} className="nav-grp" onMouseEnter={() => setOpen(g.label)} onMouseLeave={() => setOpen((o) => (o === g.label ? null : o))}>
              <button className={`nav-top ${active(path, g) ? "on" : ""} ${open === g.label ? "open" : ""}`} aria-expanded={open === g.label} onPointerDown={(e) => (pointer.current = e.pointerType)} onClick={() => setOpen(pointer.current === "mouse" ? g.label : open === g.label ? null : g.label)}>
                {g.label}
                <svg width="8" height="8" viewBox="0 0 8 8" shapeRendering="crispEdges" fill="currentColor" aria-hidden><rect x="1" y="2" width="6" height="1" /><rect x="2" y="3" width="4" height="1" /><rect x="3" y="4" width="2" height="1" /></svg>
              </button>
              {open === g.label && (
                <div className="nav-menu" role="menu">
                  {g.items!.map((i) => (
                    <Link key={i.href} href={i.href} className={`nav-item ${path === i.href.split("#")[0] ? "on" : ""}`} role="menuitem" onClick={() => { setOpen(null); goHash(i.href); }}>
                      <b>
                        {i.label}
                        {i.tag && <em>{i.tag}</em>}
                      </b>
                      <span>{i.desc}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )
        )}
      </div>

      <button className="nav-burger" aria-label="Menu" aria-expanded={mobile} onClick={() => setMobile(!mobile)}>
        <svg width="18" height="18" viewBox="0 0 18 18" shapeRendering="crispEdges" fill="currentColor" aria-hidden>
          {mobile ? (
            <>
              <rect x="3" y="3" width="2" height="2" /><rect x="5" y="5" width="2" height="2" /><rect x="7" y="7" width="4" height="4" /><rect x="11" y="11" width="2" height="2" /><rect x="13" y="13" width="2" height="2" />
              <rect x="13" y="3" width="2" height="2" /><rect x="11" y="5" width="2" height="2" /><rect x="5" y="11" width="2" height="2" /><rect x="3" y="13" width="2" height="2" />
            </>
          ) : (
            <>
              <rect x="2" y="4" width="14" height="2" /><rect x="2" y="8" width="14" height="2" /><rect x="2" y="12" width="14" height="2" />
            </>
          )}
        </svg>
      </button>

      {mobile &&
        typeof document !== "undefined" &&
        createPortal(
        <div className="nav-sheet">
          <div className="nav-sheet-top">
            {GROUPS.filter((g) => g.href).map((g) => (
              <Link key={g.label} href={g.href!} className={`nav-big ${active(path, g) ? "on" : ""}`} onClick={() => setMobile(false)}>
                {g.label}
                {g.href === "/desk" && <DeskDot />}
              </Link>
            ))}
          </div>
          {GROUPS.filter((g) => g.items).map((g) => (
            <div key={g.label} className="nav-sheet-grp">
              <div className="nav-sheet-h">{g.label}</div>
              {g.items!.map((i) => (
                <Link key={i.href} href={i.href} className={`nav-item ${path === i.href.split("#")[0] ? "on" : ""}`} onClick={() => { setMobile(false); goHash(i.href); }}>
                  <b>
                    {i.label}
                    {i.tag && <em>{i.tag}</em>}
                  </b>
                  <span>{i.desc}</span>
                </Link>
              ))}
            </div>
          ))}
          <a className="nav-x-big" href={SITE.x} target="_blank" rel="noreferrer">
            <span className="xg">𝕏</span> Follow {SITE.handle}
          </a>
        </div>,
          document.body
        )}
    </nav>
  );
}

/** Header button to the project's X account. */
export function XButton() {
  return (
    <a className="xbtn" href={SITE.x} target="_blank" rel="noreferrer" aria-label={`RATNET on X (${SITE.handle})`} title={`Follow ${SITE.handle}`}>
      <span className="xg">𝕏</span>
    </a>
  );
}
