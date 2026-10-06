"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  ["/", "Feed"],
  ["/radar", "Radar"],
  ["/king", "Rat King"],
  ["/lab", "Lab"],
  ["/rats", "Rats"],
  ["/sniff", "Sniff"],
  ["/ledger", "Ledger"],
  ["/dataset", "Dataset"],
  ["/docs", "Docs"],
  ["/developers", "API"],
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href} className={path === href ? "on" : ""}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
