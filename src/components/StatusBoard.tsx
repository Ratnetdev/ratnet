"use client";
// The health overview: one tile per area (systems, speed, data, learning, desk), green / amber / red, with the
// number behind it. Built only from public endpoints.
import { useAdmin } from "./useAdmin";
import { usePoll } from "./usePoll";

type Lat = { p50: number; n: number } | null;
type Tile = { k: string; v: string; s: string; level: "ok" | "warn" | "bad" | "idle" };

const lvl = (ok: boolean, warn: boolean): Tile["level"] => (ok ? "ok" : warn ? "warn" : "bad");

export default function StatusBoard() {
  const admin = useAdmin(); // v0.1.47: setup hints (env var names) only for the admin
  const alive = usePoll<{ parts: { name: string; age: number | null; ok: boolean; stalled: boolean }[]; rpc?: { at: number; plan: number; capNow: number; perSec: number; throttled1m: number; methods?: { hour: string; top: [string, number][] }; lanes: { lane: string; perSec: number; waitMs: number; queued: number }[] } | null; x?: { budget: number; thisHour: number; lastHour: number; rules: number; paidAccounts: number; paused?: boolean; est?: number | null } | null; rpcDay?: { today: number; perMonth: number; perSecLive: number; budget: number; pace: number; histCap: number; byLane: Record<string, number> } | null; worker?: { boots: number; bootAt: number | null; exits: { at: number; why: string }[]; takeovers: number; takeoverAt: number | null; streamReconnects: number; streamNote?: { at: number; text: string } | null; xHookRejected?: number } | null; bw?: { at: number; hourMB: number; gov: { level: number; dayMB: number; paceMB: number; allowMB: number; hourMB?: number; hourRate?: number } | null } | null }>("/api/alive", 5000).data;
  const bw = alive?.bw?.gov || null;
  const gb = (mb: number) => `${(mb / 1000).toFixed(mb >= 10_000 ? 0 : 2)}GB`;
  const day = alive?.rpcDay || null;
  const wk = alive?.worker || null;
  const ago = (t: number | null | undefined) => (!t ? "never" : (() => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; })());
  const M = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n));
  const lastExit = wk?.exits?.[0];
  const xc = alive?.x || null;
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n));
  const rpc = alive?.rpc && Date.now() - alive.rpc.at < 120_000 ? alive.rpc : null;
  const slowest = rpc ? [...rpc.lanes].sort((a, b) => b.waitMs - a.waitMs)[0] : null;
  const desk = usePoll<any>("/api/desk", 5000).data;
  const hist = usePoll<any>("/api/history", 20000).data;
  const boards = usePoll<any>("/api/boards", 15000).data;
  const catcher = boards?.catch;
  const flash = boards?.flash;
  const king = usePoll<any>("/api/king", 20000).data;
  const now = desk?.now;
  const sp: { call?: Lat; early?: Lat; flash?: Lat; chain?: Lat; fill?: Lat; stream?: Lat } = now?.speed || {};
  const parts = alive?.parts || [];
  const down = parts.filter((p) => p.stalled).length;
  const warn = parts.filter((p) => !p.stalled && !p.ok).length;
  const beatAge = now?.beatAt ? Math.round((Date.now() - now.beatAt) / 1000) : null;
  const ex = desk?.exam;
  const passed = (ex?.checks || []).filter((c: any) => c.ok).length;
  // v0.1.49: one placeholder style. "…" only while the data loads; once it is in and a value is missing: "–" and a
  // plain reason, grey (it showed "…" forever, and "–" in one tile)
  const nil = (loaded: unknown) => (loaded ? "–" : "…");
  const deskIn = !!desk;
  const aliveIn = !!alive;

  const groups: { title: string; tiles: Tile[] }[] = [
    {
      title: "Systems",
      tiles: [
        { k: "Loops", v: parts.length ? `${parts.length - down - warn}/${parts.length}` : nil(aliveIn), s: `${down ? `${down} stalled${warn ? `, ${warn} with errors` : ""}` : warn ? `${warn} reported an error` : "all running"} · they run the 25 agents`, level: parts.length ? lvl(!down && !warn, !down) : "idle" },
        { k: "X reads (credits)", v: xc ? `${k(xc.thisHour)}` : nil(aliveIn), s: xc ? `this hour, budget ${k(xc.budget)}/h${xc.paused ? " · BUDGET REACHED: paid rules off until the next hour" : ""} · last hour ${k(xc.lastHour)} · ${xc.paidAccounts} accounts watched live (${xc.rules} rules${xc.est ? `, ~${k(xc.est)}/h expected` : ""}), the rest through J7 (free)${wk?.xHookRejected ? ` · ${wk.xHookRejected} webhook calls refused${admin ? " (set X_HOOK_SECRET, see the README)" : ""}` : ""}` : aliveIn ? "no X report yet" : "", level: !xc || (!xc.thisHour && !xc.lastHour) ? "idle" : lvl(xc.thisHour <= xc.budget && !xc.paused, xc.thisHour <= xc.budget * 1.5) },
        { k: "Chain reads (RPC)", v: rpc ? `${rpc.perSec}/s` : nil(aliveIn), s: rpc ? `plan ${rpc.plan}/s · ${rpc.throttled1m ? `${rpc.throttled1m} rate-limited in the last minute` : "never rate-limited this minute"}${slowest && slowest.waitMs > 500 ? ` · ${slowest.lane} wait ${(slowest.waitMs / 1000).toFixed(1)}s` : ""}${rpc.methods?.top?.length ? ` · this hour: ${rpc.methods.top.slice(0, 4).map(([k, n]) => `${k.replace(":", " ")} ${M(n)}`).join(", ")}` : ""}` : "worker report pending", level: rpc ? lvl(!rpc.throttled1m && (slowest?.waitMs ?? 0) <= 2000, rpc.throttled1m < 20) : "idle" },
        { k: "Chain budget (today)", v: day ? M(day.today) : nil(aliveIn), s: day ? `${day.budget ? `of ${M(day.budget)} a day, on pace ${M(day.pace)} by now${day.today > day.pace * 1.05 ? " · OVER PACE: rats, agents and historian wait (resets 00:00 UTC), the desk keeps running" : ""}` : "no daily cap set"} · at this minute's rate ~${M(day.perMonth)} a month · historian ${M(Number(day.byLane?.historian || 0))} of ${M(day.histCap)}` : aliveIn ? "no budget report yet" : "", level: day && day.today ? (day.budget ? lvl(day.today <= day.pace * 1.05, day.today <= day.budget * 1.15) : lvl(day.perMonth <= 10_000_000, day.perMonth <= 15_000_000)) : "idle" },
        // v0.1.40: the database plan's bandwidth, paced through the day (lib/bwgov.ts). v0.1.41: the hour's rate too,
        // and an old report (worker silent for 10+ minutes) shows as old, not green
        (() => {
          const old = !!alive?.bw && Date.now() - alive.bw.at > 10 * 60_000;
          const g2 = bw as any;
          return { k: "Redis bandwidth (today)", v: bw ? gb(bw.dayMB) : nil(aliveIn), s: bw ? `of ${gb(bw.allowMB)} a day, on pace ${gb(bw.paceMB)} by now${g2?.hourMB != null ? ` · this hour ${g2.hourMB}MB (${g2.hourRate}x the hourly allowance)` : ""}${bw.level ? ` · SAVING MODE ${bw.level}: pages cache ${[1, 3, 6, 10][bw.level]}x longer, background learning slows, the desk keeps running` : ""}${old ? ` · report is ${ago(alive!.bw!.at)} old` : ""}` : "shown when you are logged in as admin (or the worker report is pending)", level: !bw ? "idle" : old ? "warn" : lvl(bw.level === 0, bw.level < 2) } as Tile;
        })(),
        { k: "Worker", v: wk?.bootAt ? `up ${ago(wk.bootAt).replace(" ago", "")}` : nil(aliveIn), s: wk ? `${wk.boots} starts${lastExit ? ` · last restart ${ago(lastExit.at)}: ${lastExit.why}` : ""}${wk.takeovers ? ` · minute ping took over ${wk.takeovers}x, last ${ago(wk.takeoverAt)}` : ""}${wk.streamReconnects ? ` · stream reconnected ${wk.streamReconnects}x` : ""}` : aliveIn ? "no worker report yet" : "", level: wk?.bootAt ? lvl(!lastExit || Date.now() - lastExit.at > 3600_000, true) : "idle" },
        { k: "Desk heartbeat", v: beatAge != null ? `${beatAge}s` : nil(deskIn), s: "open positions priced from the live feed, checked on the chain at most every 2s", level: beatAge == null ? "idle" : lvl(beatAge <= 5, beatAge <= 30) },
        (() => {
          const st = parts.find((p) => p.name === "stream");
          const m = /lastTradeSec:(\d+|never)/.exec((st as any)?.note || "");
          const tr = m ? (m[1] === "never" ? null : Number(m[1])) : undefined;
          const tradesOk = tr != null && tr <= 60;
          const fd = /feed:([^,]+)/.exec((st as any)?.note || "")?.[1];
          // v0.1.53: the live curve stream (every launch's first 7 minutes) and how often the rats answer from it
          const cv = /curves:([^,]+)/.exec((st as any)?.note || "")?.[1];
          const keyed = /ppKey:1/.test((st as any)?.note || "");
          // without a PumpPortal key no trade stream is expected (v0.1.34): the Helius feed prices open positions,
          // tapes come from the chain and FLASH waits. That is the plan, not a fault
          // v0.1.54: with a key, the trade stream follows a shortlist under a daily cap
          const pp = /pp:([^,]+)/.exec((st as any)?.note || "")?.[1];
          const ppCoins = Number(/^(\d+) coins/.exec(pp || "")?.[1] || 0);
          const ppStuck = keyed && ppCoins > 0 && (tr === null || (tr ?? 0) > 120);
          const tradeLine = keyed ? ` · trade stream (shortlist): ${pp || "starting"}${tr != null ? `, last trade ${tr}s ago` : ""}${ppStuck ? " · NO TRADES arriving" : ""}` : " · trade stream off (needs a PumpPortal key): tapes from the chain, FLASH paused";
          const feedLine = `${fd ? ` · Helius price feed ${fd.replace(/ accts /, " accounts (open positions), ").replace(/ px /, " prices, ")}` : ""}${cv && cv !== "off" ? ` · live curves ${cv.replace(/ coins /, " launches followed, ").replace(/ hit (\d+)%/, ", $1% of reads on followed coins answered from the stream")}` : ""}`;
          return { k: "Live stream", v: st?.age != null ? `${st.age}s` : nil(aliveIn), s: `PumpPortal: launches, migrations${feedLine}${tradeLine}${wk?.streamNote && Date.now() - wk.streamNote.at < 3600_000 && !/successfully subscribed/i.test(wk.streamNote.text) ? ` · PumpPortal says: ${wk.streamNote.text}` : ""}`, level: st?.age == null ? "idle" : ppStuck || (pp && / REACHED/.test(pp)) ? "warn" : (fd && /^down/.test(fd)) || (cv && /^down/.test(cv)) ? "warn" : lvl(st.age <= 30, st.age <= 90) } as Tile;
        })(),
      ],
    },
    {
      title: "Speed (seconds after a launch is born)",
      tiles: [
        { k: "Launch dug", v: sp.stream ? `${sp.stream.p50}s` : sp.chain ? "~1s" : nil(deskIn), s: `${sp.stream ? `stream delivers launches ${sp.stream.p50}s after their block (sampled)` : "stream lag being sampled"}${sp.chain ? ` · chain backfill catches misses in ${sp.chain.p50}s` : ""}`, level: sp.stream ? lvl(sp.stream.p50 <= 3, sp.stream.p50 <= 10) : sp.chain ? lvl(sp.chain.p50 <= 30, sp.chain.p50 <= 120) : "idle" },
        { k: "First read (FLASH)", v: sp.flash ? `${sp.flash.p50}s` : nil(deskIn), s: sp.flash || !deskIn ? "target 15s" : "target 15s · no FLASH reads measured yet", level: sp.flash ? lvl(sp.flash.p50 <= 20, sp.flash.p50 <= 60) : "idle" },
        { k: "Minute-1 read", v: sp.early ? `${sp.early.p50}s` : nil(deskIn), s: sp.early || !deskIn ? "target 60s" : "target 60s · none measured yet", level: sp.early ? lvl(sp.early.p50 <= 75, sp.early.p50 <= 150) : "idle" },
        { k: "King call", v: sp.call ? `${sp.call.p50}s` : nil(deskIn), s: sp.call || !deskIn ? "target 300s" : "target 300s · none measured yet", level: sp.call ? lvl(sp.call.p50 <= 330, sp.call.p50 <= 600) : "idle" },
        { k: "Signal to fill", v: sp.fill ? `${sp.fill.p50}s` : nil(deskIn), s: sp.fill || !deskIn ? "FLASH entries" : "FLASH entries · no FLASH fills yet", level: sp.fill ? lvl(sp.fill.p50 <= 3, sp.fill.p50 <= 8) : "idle" },
      ],
    },
    {
      title: "Learning",
      tiles: [
        { k: "Historian", v: hist ? `${(hist.lessons ?? 0).toLocaleString()} lessons` : "…", s: hist ? `${(hist.bondsFound ?? 0).toLocaleString()} bonds found${hist.lastError ? ` · last error: ${String(hist.lastError).slice(0, 40)}` : ""}` : "", level: !hist || !hist.lessons ? "idle" : lvl(!hist.lastError, true) },
        { k: "King v1", v: king?.v1 ? (king.v1.ready ? "live" : "not calibrated yet") : "…", s: king?.v1 ? `${(king.v1.lessons ?? 0).toLocaleString()} lessons, ${king.v1.bonds ?? 0} bonds` : "", level: king?.v1?.ready ? "ok" : "idle" },
        { k: "CATCH model", v: catcher?.model ? (catcher.model.ready ? "live" : `${catcher.model.n}/${catcher.model.need}`) : "…", s: catcher?.fast ? `2h model ${catcher.fast.ready ? "live" : `${catcher.fast.n} labels`}` : "", level: catcher?.model?.ready ? "ok" : "idle" },
        { k: "FLASH model", v: flash?.model ? (flash.model.ready ? "live" : `${flash.model.n}/${flash.model.need}`) : "…", s: flash?.stages ? `${flash.stages.filter((x: any) => x.cut).length} of 3 look times trading` : "", level: flash?.model?.ready ? "ok" : "idle" },
      ],
    },
    {
      title: "Desk",
      tiles: [
        { k: "Exam", v: ex ? `${passed}/${ex.checks?.length ?? 6}` : nil(deskIn), s: desk?.live ? "live wallet" : "paper until every check passes", level: ex ? lvl(passed === (ex.checks?.length ?? 6), true) : "idle" },
        { k: "Open positions", v: desk ? String((desk.positions || []).length) : "…", s: desk?.state ? `${desk.state.closed} closed, ${desk.state.wins} won${now && !now.running ? " · desk paused" : ""}` : "", level: now?.running ? "ok" : "idle" },
      ],
    },
  ];

  return (
    <div className="grid" style={{ gap: 16 }}>
      {groups.map((g) => (
        <section key={g.title} className="panel">
          <div className="ph"><span><b>{g.title}</b></span></div>
          <div className="pb status-grid">
            {g.tiles.map((t) => (
              <div key={t.k} className={`status-t is-${t.level}`}>
                <div className="status-k"><i />{t.k}</div>
                <div className="status-v">{t.v}</div>
                <div className="status-s">{t.s}</div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
