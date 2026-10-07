"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

type Row = { m: string; s: string; n: string; v: number; V: string; o: string; t: number };
type Item = { label: string; hint: string; href: string };

const PAGES: Item[] = [
  { label: "Feed", hint: "live dig + proof", href: "/" },
  { label: "Radar", hint: "curves filling now", href: "/radar" },
  { label: "Explore", hint: "filter every call", href: "/explore" },
  { label: "King says BOND", hint: "explore preset", href: "/explore?king=B&sort=king" },
  { label: "Graduations", hint: "every bond", href: "/king?tab=grads" },
  { label: "Rat King", hint: "every call + hit rate", href: "/king" },
  { label: "Lab", hint: "nano learning live", href: "/lab" },
  { label: "Status", hint: "every system, speed and health", href: "/status" },
  { label: "Rats", hint: "spawn a rat", href: "/rats" },
  { label: "Sniff", hint: "score any CA", href: "/sniff" },
  { label: "Ledger", hint: "burns + payouts", href: "/ledger" },
  { label: "Dataset", hint: "daily drops", href: "/dataset" },
  { label: "Docs", hint: "how it all works", href: "/docs" },
  { label: "API", hint: "build on the rats", href: "/developers" },
];
const VN: Record<string, string> = { B: "BOND", W: "WATCH", D: "DUST" };
const isCA = (q: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);

export default function CmdK() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName || "");
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape") setOpen(false);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("rn:cmdk", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("rn:cmdk", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    setTimeout(() => input.current?.focus(), 10);
    fetch("/api/coins").then((r) => r.json()).then((j) => setRows(j.rows || [])).catch(() => {});
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const t = q.trim();
    const lo = t.toLowerCase();
    const out: Item[] = [];
    if (isCA(t)) {
      out.push({ label: `Open coin ${t.slice(0, 4)}…${t.slice(-4)}`, hint: "coin page", href: `/c/${t}` });
      out.push({ label: "Sniff this CA", hint: "King score + report", href: `/sniff?ca=${t}` });
    }
    out.push(...PAGES.filter((p) => !lo || p.label.toLowerCase().includes(lo) || p.hint.includes(lo)).slice(0, lo ? 4 : 13));
    if (lo) {
      const coins = rows
        .filter((r) => r.s.toLowerCase().includes(lo.replace(/^\$/, "")) || r.n.toLowerCase().includes(lo) || r.m.toLowerCase().startsWith(lo))
        .sort((a, b) => b.v - a.v)
        .slice(0, 12)
        .map((r) => ({ label: `$${r.s} · ${r.n}`, hint: `${VN[r.V]} ${r.v}${r.o === "B" ? " · BONDED" : r.o === "D" ? " · died" : ""}`, href: `/c/${r.m}` }));
      out.push(...coins);
    }
    return out;
  }, [q, rows]);

  if (!open) return null;
  const go = (it?: Item) => {
    if (!it) return;
    setOpen(false);
    router.push(it.href);
  };
  return (
    <div className="cmdk-bg" onClick={() => setOpen(false)}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Search">
        <input
          ref={input}
          value={q}
          placeholder="Search a ticker, a CA, or jump to a page…"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            if (e.key === "Enter") go(items[sel]);
          }}
          spellCheck={false}
        />
        <div className="cmdk-list">
          {items.map((it, i) => (
            <div key={it.href + i} className={`cmdk-item ${i === sel ? "on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => go(it)}>
              <span><b>›</b> {it.label}</span>
              <span className="tiny muted">{it.hint}</span>
            </div>
          ))}
          {!items.length && <div className="cmdk-item">No match in the last 24h of liked coins. Paste a full CA to open or sniff it.</div>}
        </div>
        <div className="row between tiny muted" style={{ padding: "8px 18px", borderTop: "1px solid var(--line)" }}>
          <span><span className="kbd">↑↓</span> move · <span className="kbd">enter</span> open · <span className="kbd">esc</span> close</span>
          <span>tip: press <span className="kbd">/</span> anywhere</span>
        </div>
      </div>
    </div>
  );
}

export function SearchButton() {
  return (
    <button className="searchbtn" onClick={() => window.dispatchEvent(new Event("rn:cmdk"))} aria-label="Search">
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><circle cx="5.5" cy="5.5" r="4.2" /><path d="M8.6 8.6 12 12" /></svg>
      <span className="lbl">search</span>
      <span className="kbd">⌘K</span>
    </button>
  );
}
