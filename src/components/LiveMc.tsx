"use client";
// A market cap that moves with every trade: live from the trade stream when there is one, the server's number until
// then. Flashes green on a buy, red on a sell; a small dot marks it as live.
import { useEffect, useRef, useState } from "react";
import { useLivePx } from "./livepx";
import { useLive } from "./Live";

const fmt = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);

export default function LiveMc({ mint, usd, className = "" }: { mint?: string | null; usd?: number | null; className?: string }) {
  const lp = useLivePx(mint);
  const sol = Number((useLive().data as any)?.sol) || 0;
  const live = lp && sol ? lp.mcSol * sol : null;
  const val = live ?? usd ?? null;
  const [flash, setFlash] = useState<"" | "up" | "down">("");
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (live == null) return;
    if (last.current != null && live !== last.current) {
      setFlash(live > last.current ? "up" : "down");
      const t = setTimeout(() => setFlash(""), 450);
      last.current = live;
      return () => clearTimeout(t);
    }
    last.current = live;
  }, [live]);
  if (val == null) return <span className={className}>–</span>;
  return (
    <span className={`livemc ${flash} ${className}`} title={live != null ? "live from the trade stream" : "last reading"}>
      {live != null ? <i className="livemc-dot" /> : null}
      {fmt(val)}
    </span>
  );
}
