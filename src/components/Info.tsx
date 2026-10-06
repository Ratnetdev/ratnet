"use client";
import { useState } from "react";

export const GLOSSARY: Record<string, string> = {
  bond: "Graduating: the coin fills its bonding curve and moves to a real pool. About 1 in 100 make it.",
  curve: "The pump.fun meter. Buys fill it, sells drain it. 100% = graduation.",
  verdicts: "Scored 0 to 100 at minute 5. BOND 60+, WATCH 30 to 59, DUST under 30.",
  hit: "Share of King BOND calls that graduated. Running calls count as misses until they bond.",
  base: "Share of all launches that graduate. What random picking gets you.",
  lift: "King BOND calls graduate this many times more often than a random launch.",
  nano: "A second model learning from zero on every outcome. Weights public in the Lab.",
  dev: "How many coins this dev launched before, and how many graduated.",
  lead: "Average time between the King's BOND call and the graduation.",
  dust: "Right when the coin does not graduate. Most launches die, so this runs high.",
  dug: "Every pump.fun launch the rats have read.",
  cam: "The rats working live. Every nugget is a real coin. Click a line to open it.",
  grads: "Coins that just graduated, how fast, and what the King said at minute 5.",
  radar: "Live coins filling their curve, closest to graduating on top.",
  feed: "Everything the rats do, as it happens.",
};

export default function Info({ k, children }: { k: keyof typeof GLOSSARY | string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onClick={(e) => { e.preventDefault(); setOpen(!open); }}>
      {children}
      <span className="info-q" aria-label="What is this?">?</span>
      {open && <span className="info-pop" role="tooltip">{GLOSSARY[k] || ""}</span>}
    </span>
  );
}
