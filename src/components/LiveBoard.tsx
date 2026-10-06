"use client";
import Link from "next/link";
import { useState } from "react";
import { useLive } from "./Live";
import Feed, { FeedItem } from "./Feed";
import { Call, CallList } from "./Calls";
import { num } from "./fmt";
import Info from "./Info";
import CountUp from "./CountUp";
import RadarTable, { RadarRow } from "./Radar";
import GradList, { Grad } from "./Grads";

export type Stats = {
  callsMissed?: number;
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
  nano?: {
    bond: { n: number; res: number; hit: number; rate: number | null };
    watch: { n: number; res: number; bonded: number; rate: number | null };
    dust: { n: number; res: number; hit: number; rate: number | null };
  };
  burnedRat: number;
  sniffs: number;
};
type Live = { stats: Stats; feed: FeedItem[]; calls: Call[]; radar: RadarRow[]; grads: Grad[]; live: { mint: string; litter: { n: number; size: number; open: boolean } } };

export default function LiveBoard() {
  const { data: d, error } = useLive();
  const data = d as Live | null;
  const [callTab, setCallTab] = useState<"bond" | "all">("bond");
  const s = data?.stats;
  const lift = s?.bond.rate != null && s?.baseRate ? Math.round((s.bond.rate / s.baseRate) * 10) / 10 : null;

  return (
    <>
      <section className="grid g4">
        <div className="panel glow">
          <div className="pb stat">
            <div className="k"><Info k="dug">Launches dug</Info></div>
            <div className="big rat"><CountUp value={s?.dug ?? 0} /></div>
            <div className="s">+{num(s?.dugToday ?? 0)} today · {num(s?.tracking ?? 0)} checkpoints queued</div>
          </div>
        </div>
        <div className="panel">
          <div className="pb stat">
            <div className="k"><Info k="hit">King hit rate (BOND calls)</Info></div>
            <div className="big" style={{ color: "var(--bond)" }}>{s?.bond.rate != null ? `${s.bond.rate}%` : "–"}</div>
            <div className="s">
              {s ? `${num(s.bond.hit)} of ${num(s.bond.n)} BOND calls bonded${s.callsMissed ? ` · ${num(s.callsMissed)} missed (rats behind)` : ""}` : "warming up"}
              {lift ? ` · ${lift}x base rate` : ""}
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="pb stat">
            <div className="k"><Info k="base">Trench base rate</Info></div>
            <div className="big">{s?.baseRate != null ? `${s.baseRate}%` : "–"}</div>
            <div className="s">of all dug launches graduated</div>
          </div>
        </div>
        <div className="panel">
          <div className="pb stat">
            <div className="k"><Info k="bond">Graduated</Info></div>
            <div className="big" style={{ color: "var(--bond)" }}><CountUp value={s?.bonded ?? 0} /></div>
            <div className="s">{s ? `DUST calls right ${s.dust.rate != null ? s.dust.rate + "%" : "–"} · ${num(s.calls)} calls` : "–"}</div>
          </div>
        </div>
      </section>

      <section className="grid g-main mt">
        <div className="panel">
          <div className="ph">
            <span>
              <b>live</b> · <Info k="feed">rat feed · pump.fun</Info>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className={`dot ${error ? "off" : ""}`} />
              {error ? "reconnecting" : "digging"}
            </span>
          </div>
          <Feed items={data?.feed || []} />
        </div>

        <div className="grid" style={{ alignContent: "start" }}>
          <div className="panel glow">
            <div className="ph">
              <span>
                <b>radar</b> · <Info k="radar">curves filling now</Info>
              </span>
              <Link href="/radar">full radar →</Link>
            </div>
            <RadarTable rows={(data?.radar || []).slice(0, 8)} />
          </div>
          <div className="panel">
            <div className="ph">
              <span>
                <b style={{ color: "var(--bond)" }}>graduations</b> · <Info k="grads">bonded live</Info>
              </span>
              <Link href="/king?tab=grads">all →</Link>
            </div>
            <GradList grads={(data?.grads || []).slice(0, 6)} />
          </div>
        </div>
      </section>

      <section className="grid g-main mt">
        <div className="panel">
          <div className="ph">
            <span className="row" style={{ gap: 10 }}>
              <Info k="t_king"><b>rat king</b></Info>
              <span className="rec-tabs">
                <button className={callTab === "bond" ? "on" : ""} onClick={() => setCallTab("bond")}>BOND calls{(data as any)?.bondCalls?.length ? ` ${(data as any).bondCalls.length}` : ""}</button>
                <button className={callTab === "all" ? "on" : ""} onClick={() => setCallTab("all")}>all calls</button>
              </span>
            </span>
            <Link href="/king">all calls →</Link>
          </div>
          {callTab === "bond" && !((data as any)?.bondCalls || []).length ? (
            <div className="pb small muted">No BOND calls since the reset yet. The King calls BOND on roughly 1 in 60 launches at minute 5; the newest shows here the second it lands.</div>
          ) : (
            <CallList calls={(callTab === "bond" ? (data as any)?.bondCalls || [] : data?.calls || []).slice(0, 8)} />
          )}
        </div>
        <div className="grid" style={{ alignContent: "start" }}>
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
                  <div className="muted small">Burn $RAT, get a Rat King score, dev history and a report on any coin.</div>
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
