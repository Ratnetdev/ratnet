"use client";
import Link from "next/link";
import { usePoll } from "./usePoll";
import Feed, { FeedItem } from "./Feed";
import { Call, CallList } from "./Calls";
import { num } from "./fmt";

export type Stats = {
  dug: number;
  dugToday: number;
  tracking: number;
  resolved: number;
  bonded: number;
  baseRate: number | null;
  calls: number;
  callsToday: number;
  bond: { n: number; res: number; hit: number; rate: number | null };
  watch: { n: number; res: number; bonded: number; rate: number | null };
  dust: { n: number; res: number; hit: number; rate: number | null };
  burnedRat: number;
  sniffs: number;
};
type Live = { stats: Stats; feed: FeedItem[]; calls: Call[]; live: { mint: string; litter: { n: number; size: number; open: boolean } } };

export default function LiveBoard() {
  const { data, error } = usePoll<Live>("/api/live", 4000);
  const s = data?.stats;
  const lift = s?.bond.rate != null && s?.baseRate ? Math.round((s.bond.rate / s.baseRate) * 10) / 10 : null;

  return (
    <>
      <section className="grid g4">
        <div className="panel glow">
          <div className="pb stat">
            <div className="k">Launches dug</div>
            <div className="big rat">{num(s?.dug ?? 0)}</div>
            <div className="s">+{num(s?.dugToday ?? 0)} today · {num(s?.tracking ?? 0)} sniffs queued</div>
          </div>
        </div>
        <div className="panel">
          <div className="pb stat">
            <div className="k">King hit rate (BOND calls)</div>
            <div className="big" style={{ color: "var(--bond)" }}>{s?.bond.rate != null ? `${s.bond.rate}%` : "–"}</div>
            <div className="s">
              {s ? `${num(s.bond.hit)} of ${num(s.bond.res)} resolved` : "warming up"}
              {lift ? ` · ${lift}x base rate` : ""}
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="pb stat">
            <div className="k">Trench base rate</div>
            <div className="big">{s?.baseRate != null ? `${s.baseRate}%` : "–"}</div>
            <div className="s">of dug launches bond in 24h ({num(s?.bonded ?? 0)} bonded)</div>
          </div>
        </div>
        <div className="panel">
          <div className="pb stat">
            <div className="k">DUST calls right</div>
            <div className="big" style={{ color: "var(--dust)" }}>{s?.dust.rate != null ? `${s.dust.rate}%` : "–"}</div>
            <div className="s">{s ? `${num(s.calls)} calls made · ${num(s.callsToday)} today` : "–"}</div>
          </div>
        </div>
      </section>

      <section className="grid g-main mt">
        <div className="panel">
          <div className="ph">
            <span>
              <b>live</b> · rat feed · pump.fun
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className={`dot ${error ? "off" : ""}`} />
              {error ? "reconnecting" : "digging"}
            </span>
          </div>
          <Feed items={data?.feed || []} />
        </div>

        <div className="grid" style={{ alignContent: "start" }}>
          <div className="panel">
            <div className="ph">
              <span>
                <b>rat king v0</b> · latest calls
              </span>
              <Link href="/king">all calls →</Link>
            </div>
            <CallList calls={(data?.calls || []).slice(0, 8)} compact />
          </div>
          <div className="panel">
            <div className="pb">
              <div className="row between">
                <div>
                  <div className="crt" style={{ fontSize: 26, color: "var(--rat)" }}>Spawn a rat</div>
                  <div className="muted small">
                    Burn $RAT, own a rat, earn from 40% of fees every 12h.
                    {data?.live.litter ? ` Litter ${data.live.litter.n} is ${data.live.litter.open ? "open" : "closed"}.` : ""}
                  </div>
                </div>
                <Link href="/rats" className="btn">Spawn</Link>
              </div>
            </div>
          </div>
          <div className="panel">
            <div className="pb">
              <div className="row between">
                <div>
                  <div className="crt" style={{ fontSize: 26, color: "var(--rat)" }}>Sniff a CA</div>
                  <div className="muted small">Burn $RAT, get a Rat King score and report on any coin.</div>
                </div>
                <Link href="/sniff" className="btn ghost">Sniff</Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
