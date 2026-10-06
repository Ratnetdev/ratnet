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
  desk: "Paper: real curve prices, simulated fills with fees and slippage. Live: a real wallet, every fill on Solscan.",
  exam: "The desk trades on paper until it passes every line here. Then it goes live by itself with the funded wallet.",
  den: "Each rat is one agent. It hops and talks when it acts. A coin rolls down the line when the desk buys.",
  thresholds: "The exact rules the desk trades by, and how the last candidate scored on each one.",
  runners: "Every coin the rats followed after the King's call, for 7 days after it bonds. Peak is the highest market cap seen. x is peak vs the market cap at the call, where the King would have bought.",
  peak: "Highest market cap the rats saw after the call (sampled every few minutes, so the true top can be a bit higher).",
  fromcall: "Peak market cap divided by the market cap at the King's minute-5 call.",
  pnext: "Runner model: chance this coin reaches the next market cap milestone. Starts from base rates and learns from every coin the rats follow.",
  trail: "Trailing stop: sell what is left if price falls this far from its peak. Widens as the coin runs, scaled by COACH and the runner model.",
  insiders: "Bags of the dev, bundle wallets, snipers and top early buyers, watched every 4s. If they dump, the desk is out.",
  learn: "What the desk learned from its own trades: trail scale from exit reviews, which entry works best, and whether early entries are earned.",
  arms: "Every clean signal is followed in shadow four ways: buy now, or wait for a 20, 30 or 45% pullback. Mean result 30 minutes later.",
  historian: "Replays past pump.fun launches in time order and rebuilds what the rats would have seen at minute 1 and 5. Only past records are used for each launch, so nothing leaks from the future.",
  prequential: "Each past launch is scored by the model before it learns from it. Base = how many bonded within 2h (weighted sample).",
  early: "The minute-1 model. Its calls are shadowed until its record beats the minute-5 King over 50+ calls.",
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
