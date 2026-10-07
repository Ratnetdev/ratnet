"use client";
import Link from "next/link";
import { clock } from "./fmt";
import CoinImg from "./CoinImg";

export type FeedItem = { kind: string; rat: string; mint: string; symbol: string; name: string; at: number; text: string };

export default function Feed({ items, max = 40 }: { items: FeedItem[]; max?: number }) {
  if (!items.length)
    return (
      <div className="pb muted small">
        Rats are waking up. The first launches land here within seconds<span className="caret" />
      </div>
    );
  return (
    <div className="feed">
      {items.slice(0, max).map((f, i) => (
        <div className="ln" key={`${f.at}-${f.mint}-${f.kind}-${i}`}>
          <span className="t">{clock(f.at)}</span>
          <span className={`who ${f.rat === "RAT KING" ? "king" : f.rat === "LEDGER" ? "ledger" : ""}`}>{f.rat}</span>
          <span className="msg" style={f.kind === "grad" ? { color: "var(--bond)" } : f.kind === "near" ? { color: "var(--watch)" } : undefined}>
            {f.kind === "dig" && f.mint ? "dug " : f.kind === "call" ? "calls " : f.kind === "resolve" ? "" : ""}
            {f.symbol && (
              <Link href={`/c/${f.mint}`}>
                <CoinImg mint={f.mint} sym={f.symbol} size={14} /><b>${f.symbol}</b>
              </Link>
            )}{" "}
            {f.text}
          </span>
        </div>
      ))}
    </div>
  );
}
