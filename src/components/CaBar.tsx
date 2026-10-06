"use client";
import { useState } from "react";
import { usePoll } from "./usePoll";

type Live = { live: { mint: string; links: { x: string; tg: string; pump: string; dex: string } }; stats: { dug: number } };

export default function CaBar() {
  const { data } = usePoll<Live>("/api/live", 15000);
  const [copied, setCopied] = useState(false);
  const mint = data?.live.mint;
  const l = data?.live.links;
  return (
    <div className="cabar">
      <div className="wrap">
        {mint ? (
          <span>
            CA <code>{mint}</code>{" "}
            <button
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
          <span>
            $RAT CA <code>drops at launch</code>
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
