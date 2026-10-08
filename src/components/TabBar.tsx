"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLive } from "./Live";

// App-style bottom bar on phones: the five places people actually go, one thumb away.
const TABS: { href: string; label: string; match: string[]; icon: JSX.Element }[] = [
  { href: "/", label: "feed", match: ["/"], icon: <path d="M2 3h12v2H2zM2 7h12v2H2zM2 11h8v2H2z" /> },
  { href: "/desk", label: "desk", match: ["/desk"], icon: <path d="M1 12h14v2H1zM3 8h2v3H3zM7 5h2v6H7zM11 2h2v9h-2z" /> },
  { href: "/radar", label: "coins", match: ["/radar", "/explore", "/sniff", "/c"], icon: <path d="M7 1h2v2H7zM3 3h2v2H3zM11 3h2v2h-2zM1 7h2v2H1zM13 7h2v2h-2zM6 6h4v4H6zM3 11h2v2H3zM11 11h2v2h-2zM7 13h2v2H7z" /> },
  { href: "/king", label: "king", match: ["/king", "/lab", "/receipts", "/status"], icon: <path d="M1 4h2v2h2V3h2v3h2V3h2v3h2V4h2v9H1zM3 11h10V9H3z" /> },
  { href: "/rats", label: "rats", match: ["/rats", "/ledger"], icon: <path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z" /> },
];

export default function TabBar() {
  const path = usePathname() || "/";
  const d = useLive().data as any;
  const radar = (d?.radar || []).length as number;
  const desk = d?.desk as { live: boolean } | null;
  const on = (t: (typeof TABS)[number]) => (t.href === "/" ? path === "/" : t.match.some((m) => path === m || path.startsWith(m + "/")));
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className={`tab ${on(t) ? "on" : ""} ${t.label === "rats" ? "add" : ""}`}>
          <span className="tab-ico">
            <svg width="16" height="16" viewBox="0 0 16 16" shapeRendering="crispEdges" fill="currentColor" aria-hidden>{t.icon}</svg>
            {t.label === "coins" && radar > 0 && <em className="tab-badge">{radar > 99 ? "99+" : radar}</em>}
            {t.label === "desk" && <i className={`tab-dot ${desk?.live ? "live" : ""}`} />}
          </span>
          <span className="tab-l">{t.label}</span>
        </Link>
      ))}
    </nav>
  );
}
