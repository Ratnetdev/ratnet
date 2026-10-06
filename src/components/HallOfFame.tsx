"use client";
import Link from "next/link";
import { usePoll } from "./usePoll";
import Info from "./Info";
import { usdK } from "./Grads";
import { ago } from "./fmt";

type View = { mint: string; symbol: string; pk: number; pkAt?: number; cUsd?: number | null; x: number | null; verdict?: string | null; bondedAt: number | null; createdAt: number };

function tweet(v: View, site: string) {
  const text = `The Rat King called $${v.symbol} BOND at minute 5, at a ${usdK(v.cUsd)} market cap.\n\nIt peaked at ${usdK(v.pk)}. ${v.x}x from the call.\n\nThe call was sealed on-chain before it ran.`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(`${site}/c/${v.mint}`)}`;
}

/** Best BOND calls of the last 7 days, by how far they ran from the market cap at the call. */
export default function HallOfFame({ limit = 6, full = false }: { limit?: number; full?: boolean }) {
  const d = usePoll<{ fame: View[] }>("/api/runners?fame=1", 30000).data;
  const fame = (d?.fame || []).slice(0, limit);
  const site = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <section className="panel mt">
      <div className="ph">
        <span><Info k="fame"><b>hall of fame</b></Info> · best BOND calls, 7 days</span>
        {!full && <Link href="/king?tab=fame">all →</Link>}
      </div>
      {fame.length ? (
        <div className="fame">
          {fame.map((v, i) => (
            <div key={v.mint} className="fame-c">
              <div className="fame-top">
                <span className="fame-n">#{i + 1}</span>
                <Link href={`/c/${v.mint}`} className="fame-sym">${v.symbol}</Link>
                <span className="fame-x">{v.x}x</span>
              </div>
              <div className="fame-path">
                <span><em>at the call</em>{usdK(v.cUsd)}</span>
                <span className="fame-arrow">→</span>
                <span><em>peak</em>{usdK(v.pk)}</span>
              </div>
              <div className="fame-foot">
                <span className="muted">{ago(v.createdAt)} ago{v.bondedAt ? " · bonded" : ""}</span>
                <a href={tweet(v, site)} target="_blank" rel="noreferrer">share</a>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="pb small muted">{d ? "No BOND call has doubled from its call yet in the last 7 days. The first one lands here." : "loading…"}</div>
      )}
      <div className="pb tiny muted">Peak market cap after the call, read from the chain. These are the King&apos;s calls, not the desk&apos;s trades: the desk&apos;s own results are in the track record.</div>
    </section>
  );
}
