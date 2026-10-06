"use client";
import { clock } from "./fmt";

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
          <span className="msg">
            {f.kind === "dig" && f.mint ? "dug " : f.kind === "call" ? "calls " : f.kind === "resolve" ? "" : ""}
            {f.symbol && (
              <a href={`https://pump.fun/coin/${f.mint}`} target="_blank" rel="noreferrer">
                <b>${f.symbol}</b>
              </a>
            )}{" "}
            {f.text}
          </span>
        </div>
      ))}
    </div>
  );
}
