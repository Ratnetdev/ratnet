"use client";
import { useState } from "react";
import { useLive } from "./Live";

type Live = { live: { mint: string; links: { x: string; tg: string; pump: string; dex: string } }; stats: { dug: number } };

export default function CaBar() {
  const data = useLive().data as Live | null;
  const [copied, setCopied] = useState(false);
  const mint = data?.live?.mint;
  const l = data?.live?.links;
  return (
    <div className="cabar">
      <div className="wrap">
        {mint ? (
          <span>
            CA <code className="ca-full">{mint}</code><code className="ca-short" title={mint}>{mint.slice(0, 4)}…{mint.slice(-4)}</code>{" "}
            <button
              type="button"
              aria-label="copy the contract address"
              onClick={() => {
                navigator.clipboard?.writeText(mint);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              [{copied ? "copied" : "copy"}]
            </button>
          </span>
        ) : (
          <span className="ca-wait">
            $RAT is not live. The CA will only be posted on <a href="https://x.com/Ratnetdev" target="_blank" rel="noreferrer">@Ratnetdev</a>. Anything else is a scam.
          </span>
        )}
        <span style={{ flex: 1 }} />
        {l?.pump && <a href={l.pump} target="_blank" rel="noreferrer">pump.fun</a>}
        {l?.dex && <a href={l.dex} target="_blank" rel="noreferrer">chart</a>}
        {l?.x && <a href={l.x} target="_blank" rel="noreferrer">X</a>}
        {l?.tg && <a href={l.tg} target="_blank" rel="noreferrer">TG</a>}
      </div>
    </div>
  );
}
