"use client";
// The health overview: one tile per area (systems, speed, data, learning, desk), green / amber / red, with the
// number behind it. Built only from public endpoints.
import { usePoll } from "./usePoll";

type Lat = { p50: number; n: number } | null;
type Tile = { k: string; v: string; s: string; level: "ok" | "warn" | "bad" | "idle" };

const lvl = (ok: boolean, warn: boolean): Tile["level"] => (ok ? "ok" : warn ? "warn" : "bad");

export default function StatusBoard() {
  const alive = usePoll<{ parts: { name: string; age: number | null; ok: boolean; stalled: boolean }[] }>("/api/alive", 5000).data;
  const desk = usePoll<any>("/api/desk", 5000).data;
  const hist = usePoll<any>("/api/history", 20000).data;
  const catcher = usePoll<any>("/api/catch", 15000).data;
  const flash = usePoll<any>("/api/flash", 15000).data;
  const king = usePoll<any>("/api/king", 20000).data;
  const now = desk?.now;
  const sp: { call?: Lat; early?: Lat; flash?: Lat; chain?: Lat; fill?: Lat } = now?.speed || {};
  const parts = alive?.parts || [];
  const down = parts.filter((p) => p.stalled).length;
  const warn = parts.filter((p) => !p.stalled && !p.ok).length;
  const beatAge = now?.beatAt ? Math.round((Date.now() - now.beatAt) / 1000) : null;
  const ex = desk?.exam;
  const passed = (ex?.checks || []).filter((c: any) => c.ok).length;

  const groups: { title: string; tiles: Tile[] }[] = [
    {
      title: "Systems",
      tiles: [
        { k: "Loops and agents", v: parts.length ? `${parts.length - down - warn}/${parts.length}` : "…", s: down ? `${down} stalled${warn ? `, ${warn} with errors` : ""}` : warn ? `${warn} reported an error` : "all running", level: parts.length ? lvl(!down && !warn, !down) : "idle" },
        { k: "Desk heartbeat", v: beatAge != null ? `${beatAge}s` : "…", s: "positions re-read twice a second", level: beatAge == null ? "idle" : lvl(beatAge <= 5, beatAge <= 30) },
        { k: "Live stream", v: parts.find((p) => p.name === "stream")?.age != null ? `${parts.find((p) => p.name === "stream")!.age}s` : "…", s: "PumpPortal: launches, trades, migrations", level: (() => { const a = parts.find((p) => p.name === "stream")?.age; return a == null ? "idle" : lvl(a <= 30, a <= 90); })() },
      ],
    },
    {
      title: "Speed (seconds after a launch is born)",
      tiles: [
        { k: "Launch dug", v: sp.chain ? "~1s" : "…", s: sp.chain ? `chain backfill catches misses in ${sp.chain.p50}s` : "", level: sp.chain ? lvl(sp.chain.p50 <= 30, sp.chain.p50 <= 120) : "idle" },
        { k: "First read (FLASH)", v: sp.flash ? `${sp.flash.p50}s` : "…", s: "target 15s", level: sp.flash ? lvl(sp.flash.p50 <= 20, sp.flash.p50 <= 60) : "idle" },
        { k: "Minute-1 read", v: sp.early ? `${sp.early.p50}s` : "…", s: "target 60s", level: sp.early ? lvl(sp.early.p50 <= 75, sp.early.p50 <= 150) : "idle" },
        { k: "King call", v: sp.call ? `${sp.call.p50}s` : "…", s: "target 300s", level: sp.call ? lvl(sp.call.p50 <= 330, sp.call.p50 <= 600) : "idle" },
        { k: "Signal to fill", v: sp.fill ? `${sp.fill.p50}s` : "–", s: "FLASH entries", level: sp.fill ? lvl(sp.fill.p50 <= 3, sp.fill.p50 <= 8) : "idle" },
      ],
    },
    {
      title: "Learning",
      tiles: [
        { k: "Historian", v: hist ? `${(hist.lessons ?? 0).toLocaleString()} lessons` : "…", s: hist ? `${(hist.bondsFound ?? 0).toLocaleString()} bonds found${hist.lastError ? ` · last error: ${String(hist.lastError).slice(0, 40)}` : ""}` : "", level: hist ? lvl(!hist.lastError, true) : "idle" },
        { k: "King v1", v: king?.v1 ? (king.v1.ready ? "live" : "warming up") : "…", s: king?.v1 ? `${(king.v1.lessons ?? 0).toLocaleString()} lessons, ${king.v1.bonds ?? 0} bonds` : "", level: king?.v1 ? lvl(!!king.v1.ready, true) : "idle" },
        { k: "CATCH model", v: catcher?.model ? (catcher.model.ready ? "live" : `${catcher.model.n}/${catcher.model.need}`) : "…", s: catcher?.fast ? `2h model ${catcher.fast.ready ? "live" : `${catcher.fast.n} labels`}` : "", level: catcher?.model ? lvl(!!catcher.model.ready, true) : "idle" },
        { k: "FLASH model", v: flash?.model ? (flash.model.ready ? "live" : `${flash.model.n}/${flash.model.need}`) : "…", s: flash?.stages ? `${flash.stages.filter((x: any) => x.cut).length} of 3 look times trading` : "", level: flash?.model ? lvl(!!flash.model.ready, true) : "idle" },
      ],
    },
    {
      title: "Desk",
      tiles: [
        { k: "Exam", v: ex ? `${passed}/${ex.checks?.length ?? 5}` : "…", s: desk?.live ? "live wallet" : "paper until every check passes", level: ex ? lvl(passed === (ex.checks?.length ?? 5), true) : "idle" },
        { k: "Open positions", v: desk ? String((desk.positions || []).length) : "…", s: desk?.state ? `${desk.state.closed} closed, ${desk.state.wins} won` : "", level: desk ? "ok" : "idle" },
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
