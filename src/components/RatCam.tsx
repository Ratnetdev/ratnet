"use client";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import Info from "./Info";
import { useLive } from "./Live";
import CoinImg from "./CoinImg";

type FeedItem = { kind: string; rat: string; mint: string; symbol: string; name: string; at: number; text: string };
type Line = { t: string; c?: string; href?: string };
type Mode = "open" | "min";

// ---------- tunnel scene
type Dims = { W: number; H: number; CELL: number; PX: number; FONT: number };
const FLOAT: Dims = { W: 320, H: 96, CELL: 3, PX: 2.2, FONT: 9 };
const RAT = [
  "...........##....",
  "..........#..#...",
  ".....#######..#..",
  "...###########.#.",
  "..############..#",
  "..#############.#",
  "..##############.",
  ".#.###########...",
];
const LEGS = ["#...#..#...#..#..", "#..#..#...#..#..."];

type Nugget = { col: number; row: number; color: string; label: string; big: boolean; hit: boolean };

function colorFor(f: FeedItem) {
  if (f.kind === "grad") return "#ffb547";
  if (f.kind === "near") return "#7fd1ff";
  if (f.kind === "call") return f.text.startsWith("BOND") ? "#ffb547" : f.text.startsWith("WATCH") ? "#7fd1ff" : "#ff5c5c";
  if (f.kind === "resolve") return f.text.startsWith("DIED") ? "#ff5c5c" : "#6c7b73";
  return "#c8ffb0";
}

function linesFor(f: FeedItem): Line[] {
  const sym = f.symbol ? `$${f.symbol}` : "";
  const parts = f.text.split(" · ").filter(Boolean);
  const href = f.mint ? `/c/${f.mint}` : undefined;
  switch (f.kind) {
    case "dig":
      if (!f.mint) return [{ t: `${f.rat} ${f.text}`, c: "#8cff5a" }];
      return [{ t: `> dig ${sym} ${f.mint.slice(0, 4)}…${f.mint.slice(-4)}`, c: "#8cff5a", href }, ...parts.slice(0, 3).map((p) => ({ t: `  ${p}` }))];
    case "call":
      return [{ t: `> king call ${sym}`, c: "#ffb547", href }, { t: `  ${parts[0]}`, c: colorFor(f) }, ...parts.slice(1, 3).map((p) => ({ t: `  ${p}` }))];
    case "grad":
      return [{ t: `!! ${sym} ${parts[0]}`, c: "#ffb547", href }, ...parts.slice(1, 3).map((p) => ({ t: `  ${p}`, c: "#ffb547" }))];
    case "near":
      return [{ t: `>> ${sym} ${parts[0]}`, c: "#7fd1ff", href }, ...parts.slice(1, 3).map((p) => ({ t: `  ${p}` }))];
    case "desk":
      return [{ t: `$ ${f.rat.toLowerCase()} ${f.text}`, c: /bought/.test(f.text) ? "#ff7ab6" : /closed|sold/.test(f.text) ? "#ffb547" : "#c8d3cc", href }];
    case "h1":
      return [{ t: `> recheck ${sym} at 1h`, c: "#8cff5a", href }, { t: `  ${parts.slice(1).join(" · ")}` }];
    case "resolve":
      return [{ t: `> settle ${sym} ${parts[0]}`, c: colorFor(f), href }, ...parts.slice(1, 2).map((p) => ({ t: `  ${p}` }))];
    default:
      return [{ t: `> ${f.rat.toLowerCase()} ${sym}`, c: "#8cff5a", href }, { t: `  ${parts.join(" · ")}` }];
  }
}

function useTunnel(canvas: React.RefObject<HTMLCanvasElement>, active: boolean, nuggets: React.MutableRefObject<Nugget[]>, dims: Dims) {
  useEffect(() => {
    if (!active) return;
    const { W, H, CELL, PX, FONT } = dims;
    const COLS = Math.ceil(W / CELL) + 2;
    const ROWS_N = Math.floor(H / CELL);
    const NOSE = Math.round((17 * PX) / CELL); // sprite width in cells
    const HALF = Math.ceil((4.5 * PX) / CELL); // half sprite height in cells
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr;
    cv.height = H * dpr;
    ctx.scale(dpr, dpr);
    // world: columns of cells. 0 = dirt, 1 = tunnel, 2 = rock
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const world: Uint8Array[] = [];
    const shade: Float32Array[] = [];
    const newCol = () => {
      const c = new Uint8Array(ROWS_N);
      const s = new Float32Array(ROWS_N);
      for (let i = 0; i < ROWS_N; i++) {
        c[i] = rnd() < 0.04 ? 2 : 0;
        s[i] = rnd();
      }
      world.push(c);
      shade.push(s);
    };
    for (let i = 0; i < COLS + 40; i++) newCol();
    let base = 0; // world col index at screen x=0
    let ratCol = 18;
    let ratRow = Math.floor(ROWS_N / 2);
    let targetRow = ratRow;
    let frame = 0;
    let last = 0;
    let raf = 0;
    let flash = 0;

    // reduced motion: two frames a second instead of ~16
    const minGap = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 500 : 60;
    // off-screen (scrolled past, or a background tab): no drawing at all (v0.1.38)
    let onScreen = true;
    const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(([x]) => (onScreen = !!x?.isIntersecting)) : null;
    io?.observe(cv);
    const draw = (ts: number) => {
      raf = requestAnimationFrame(draw);
      if (!onScreen || document.visibilityState !== "visible") return;
      if (ts - last < minGap) return;
      last = ts;
      frame++;
      // move rat forward one cell every other frame, wander vertically toward a target
      if (frame % 2 === 0) {
        const next = nuggets.current.find((n) => !n.hit);
        if (next) targetRow = next.row;
        else if (frame % 40 === 0) targetRow = 4 + Math.floor(rnd() * (ROWS_N - 10));
        if (ratRow < targetRow) ratRow++;
        else if (ratRow > targetRow) ratRow--;
        else ratCol++;
        while (world.length - base < COLS + 40) newCol();
        // carve tunnel around the rat's nose
        for (let dy = -HALF; dy <= HALF; dy++) {
          const r = ratRow + dy;
          const col = world[ratCol + NOSE];
          if (col && r >= 0 && r < ROWS_N) col[r] = 1;
        }
        // keep the rat at ~35% of the screen
        if (ratCol - base > Math.floor(COLS * 0.35)) base++;
        // reached a nugget?
        for (const n of nuggets.current) {
          if (!n.hit && ratCol + NOSE >= n.col && Math.abs(ratRow - n.row) <= HALF) {
            n.hit = true;
            flash = n.big ? 10 : 4;
          }
        }
        nuggets.current = nuggets.current.filter((n) => n.col > base - 5);
      }

      ctx.fillStyle = "#060807";
      ctx.fillRect(0, 0, W, H);
      for (let x = 0; x < COLS; x++) {
        const col = world[base + x];
        const sh = shade[base + x];
        if (!col) continue;
        for (let y = 0; y < ROWS_N; y++) {
          const v = col[y];
          if (v === 1) continue;
          const k = sh[y];
          const depth = y / ROWS_N;
          const band = Math.floor((y + Math.sin((base + x) / 9) * 2) / 6) % 2;
          ctx.fillStyle =
            v === 2
              ? `rgba(120,150,130,${0.28 + k * 0.2})`
              : `rgba(${22 + band * 8},${48 + Math.floor(k * 30) + band * 10 - depth * 18},${34 + band * 4},${0.55 + k * 0.3})`;
          ctx.fillRect(x * CELL, y * CELL, CELL - 0.5, CELL - 0.5);
        }
      }
      // nuggets
      ctx.font = `${FONT}px monospace`;
      for (const n of nuggets.current) {
        const sx = (n.col - base) * CELL;
        if (sx < -40 || sx > W + 10) continue;
        const sz = n.big ? 4 : 3;
        ctx.fillStyle = n.hit ? "rgba(255,255,255,0.15)" : n.color;
        for (let i = 0; i < sz; i++) for (let j = 0; j < sz; j++) if ((i + j) % 3 !== 2 || n.big) ctx.fillRect(sx + i * CELL, (n.row - 1 + j) * CELL, CELL - 0.5, CELL - 0.5);
        if (!n.hit) {
          ctx.fillStyle = n.color;
          ctx.fillText(n.label, sx - 2, Math.max(FONT, (n.row - 2) * CELL));
        }
      }
      // rat
      const rx = (ratCol - base) * CELL;
      const ry = ratRow * CELL - Math.round(4.5 * PX);
      const sprite = [...RAT, LEGS[frame % 4 < 2 ? 0 : 1]];
      ctx.fillStyle = "#8cff5a";
      ctx.shadowColor = "rgba(140,255,90,0.8)";
      ctx.shadowBlur = 6;
      const px = PX;
      sprite.forEach((row, y) => row.split("").forEach((c, x) => c === "#" && ctx.fillRect(rx + x * px, ry + y * px, px, px)));
      // dust kicked up behind the nose
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(140,255,90,0.5)";
      for (let i = 0; i < 4; i++) ctx.fillRect(rx + 17 * px + 2 + ((frame * 3 + i * 5) % 9), ry + 6 + ((frame + i * 7) % 12), 1.5, 1.5);
      ctx.shadowBlur = 0;
      if (flash > 0) {
        ctx.fillStyle = `rgba(255,181,71,${flash / 14})`;
        ctx.fillRect(0, 0, W, H);
        flash--;
      }
    };
    raf = requestAnimationFrame(draw);
    // expose a way to drop nuggets ahead of the rat
    (cv as any).__drop = (color: string, label: string, big: boolean) => {
      const ahead = nuggets.current.filter((n) => !n.hit).length;
      nuggets.current.push({ col: ratCol + 30 + ahead * 26, row: 5 + Math.floor(rnd() * (ROWS_N - 10)), color, label, big, hit: false });
    };
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, [active, canvas, nuggets, dims]);
}

function useRatStream(canvas: React.RefObject<HTMLCanvasElement>, keep: number) {
  const [lines, setLines] = useState<Line[]>([]);
  const [typing, setTyping] = useState<{ line: Line; n: number } | null>(null);
  const [rat, setRat] = useState("SCOUT-1");
  const seen = useRef<Set<string>>(new Set());
  const queue = useRef<FeedItem[]>([]);
  const first = useRef(true);
  const live = useLive();

  useEffect(() => {
    const j = live.data;
    if (!j?.feed) return;
    const fresh = (j.feed as FeedItem[]).filter((f) => {
      const k = `${f.at}-${f.mint}-${f.kind}`;
      if (seen.current.has(k)) return false;
      seen.current.add(k);
      return true;
    });
    const ordered = fresh.reverse();
    queue.current.push(...(first.current ? ordered.slice(-8) : ordered));
    first.current = false;
    if (queue.current.length > 30) queue.current = queue.current.slice(-30);
  }, [live.tick, live.data]);

  // play the queue: one event at a time, typed out
  useEffect(() => {
    let alive = true;
    let pending: Line[] = [];
    const tick = () => {
      if (!alive) return;
      if (!pending.length) {
        const f = queue.current.shift();
        if (f) {
          pending = linesFor(f);
          if (f.rat && !["RAT KING", "LEDGER"].includes(f.rat)) setRat(f.rat);
          const drop = (canvas.current as any)?.__drop;
          if (drop && f.symbol) drop(colorFor(f), `$${f.symbol}`.slice(0, 10), f.kind === "grad");
        }
      }
      const next = pending.shift();
      if (next) {
        let n = 0;
        const typeIt = () => {
          if (!alive) return;
          n = Math.min(next.t.length, n + 3);
          setTyping({ line: next, n });
          if (n < next.t.length) setTimeout(typeIt, 18);
          else {
            setTyping(null);
            setLines((l) => [...l, next].slice(-keep));
            setTimeout(tick, queue.current.length > 10 ? 90 : 260);
          }
        };
        typeIt();
      } else setTimeout(tick, 400);
    };
    tick();
    return () => {
      alive = false;
    };
  }, [canvas, keep]);

  return { lines, typing, rat, stats: live.data?.stats as { dug: number; bonded: number } | undefined };
}

function Terminal({ lines, typing }: { lines: Line[]; typing: { line: Line; n: number } | null }) {
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} style={{ color: l.c || "var(--dim)", opacity: 0.45 + (i / lines.length) * 0.55, whiteSpace: "pre" }}>
          {l.href ? <Link href={l.href} style={{ color: "inherit" }}>{l.t}</Link> : l.t}
        </div>
      ))}
      <div style={{ color: typing?.line.c || "var(--text)", whiteSpace: "pre" }}>
        {typing ? typing.line.t.slice(0, typing.n) : ""}
        <span className="caret" style={{ width: 6, height: "0.9em" }} />
      </div>
    </>
  );
}

const LEGEND = [
  { c: "#c8ffb0", l: "new launch", tip: "A rat just read a brand new pump.fun coin." },
  { c: "#ffb547", l: "BOND / graduated", tip: "The King thinks it will graduate, or it just did. Gold flash = graduation." },
  { c: "#7fd1ff", l: "WATCH / near", tip: "Could go either way, or the curve is past 85%." },
  { c: "#ff5c5c", l: "DUST / died", tip: "The King thinks it dies, or it did." },
];

/** Big embedded rat cam for the home hero. */
export function RatCamHero() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const nuggets = useRef<Nugget[]>([]);
  const [w, setW] = useState(560);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.round(el.clientWidth / 20) * 20)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const dims = useMemo<Dims>(() => (w < 500 ? { W: w, H: 160, CELL: 3, PX: 2.4, FONT: 9 } : { W: w, H: 240, CELL: 5, PX: 3.8, FONT: 11 }), [w]);
  const { lines, typing, rat, stats } = useRatStream(canvas, 10);
  useTunnel(canvas, true, nuggets, dims);
  return (
    <div className="ratcam-hero panel glow" ref={wrap} aria-label="Rat cam, live">
      <div className="ratcam-h">
        <span className="row" style={{ gap: 6 }}>
          <span className="dot" /> <b>RAT CAM</b> <span className="muted">· {rat} · live</span>
        </span>
        <span className="tiny muted cam-stats">
          <Info k="cam">{stats ? `${stats.dug.toLocaleString("en-US")} dug · ${stats.bonded.toLocaleString("en-US")} graduated` : "connecting…"}</Info>
        </span>
      </div>
      <canvas ref={canvas} style={{ width: dims.W, height: dims.H, display: "block", maxWidth: "100%" }} />
      <div className="ratcam-t" style={{ height: 196, fontSize: 12 }}>
        <Terminal lines={lines} typing={typing} />
      </div>
      <div className="ratcam-f">
        <span className="row wrapx" style={{ gap: 12 }}>
          {LEGEND.map((x) => (
            <span key={x.l} className="legend" title={x.tip}>
              <i style={{ background: x.c }} />
              {x.l}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

/** Small floating cam on every other page. */
export default function RatCam() {
  const path = usePathname();
  const [mode, setMode] = useState<Mode>("min");
  const nuggets = useRef<Nugget[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("rn_cam");
    } catch {}
    setMode(saved === "open" ? "open" : "min");
  }, [path]);
  const choose = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem("rn_cam", m);
    } catch {}
  };
  const { lines, typing, rat, stats } = useRatStream(canvas, 9);
  const home = path === "/";
  useTunnel(canvas, mode === "open" && !home, nuggets, FLOAT);

  if (home || path?.startsWith("/admin")) return null;

  if (mode === "min") return <LiveToasts onOpen={() => choose("open")} />;

  return (
    <aside className="ratcam" aria-label="Rat cam, live">
      <div className="ratcam-h">
        <span className="row" style={{ gap: 6 }}>
          <span className="dot" /> <b>RAT CAM</b> <span className="muted">· {rat} · live</span>
        </span>
        <button onClick={() => choose("min")} aria-label="Minimize">_</button>
      </div>
      <canvas ref={canvas} style={{ width: FLOAT.W, height: FLOAT.H, display: "block", maxWidth: "100%" }} />
      <div className="ratcam-t">
        <Terminal lines={lines} typing={typing} />
      </div>
      <div className="ratcam-f">
        <span>{stats ? `${stats.dug.toLocaleString("en-US")} dug · ${stats.bonded.toLocaleString("en-US")} graduated` : "connecting…"}</span>
        <Link href="/rats">rats →</Link>
      </div>
    </aside>
  );
}

// ---------- live toasts: the minimized cam on every page
type Toast = { id: string; tag: string; color: string; sym: string; mint?: string; text: string; href?: string; at: number; weight: number };
const TAG: Record<string, [string, string]> = {
  dig: ["NEW", "#8cff5a"],
  call: ["KING", "#ffb547"],
  grad: ["BONDED", "#ffb547"],
  near: ["NEAR BOND", "#7fd1ff"],
  desk: ["DESK", "#ff7ab6"],
  h1: ["1H CHECK", "#8cff5a"],
  resolve: ["SETTLED", "#9aa79f"],
};

function toastOf(f: FeedItem): Toast {
  const [tag, color0] = TAG[f.kind] || [f.rat?.split("-")[0] || "LIVE", "#8cff5a"];
  const color = f.kind === "call" || f.kind === "resolve" ? colorFor(f) : color0;
  // what matters most survives a busy minute: trades and graduations first, BOND calls next, fresh digs last
  const weight = f.kind === "desk" || f.kind === "grad" ? 3 : (f.kind === "call" && f.text.startsWith("BOND")) || f.kind === "near" ? 2 : f.kind === "dig" ? 0 : 1;
  return { id: `${f.at}-${f.mint}-${f.kind}`, tag, color, sym: f.symbol ? `$${f.symbol}` : "", mint: f.mint || undefined, text: f.text.split(" · ").slice(0, 2).join(" · "), href: f.mint ? `/c/${f.mint}` : undefined, at: f.at, weight };
}

const AG_COL: Record<string, string> = { EXEC: "#ff7ab6", RISK: "#ffb547", KING: "#ffb547", MOMO: "#ff9f5a", CATCH: "#ffe066", SHIELD: "#ff6b6b", FLASH: "#9ef0ff", MIND: "#c79bff", WIRE: "#7fd1ff", LEDGER: "#8cff5a", HOUND: "#ffd36b", PM: "#9ff0c8" };
const SHOW_MS = 2600; // one new card every 2.6s at most, so every line can be read
const MAX_BACKLOG = 14;

function LiveToasts({ onOpen }: { onOpen: () => void }) {
  const live = useLive();
  const [cards, setCards] = useState<Toast[]>([]);
  const [paused, setPaused] = useState(false);
  // v0.1.33: on screens without room beside the page (under 1880px) the feed starts folded into the small LIVE dot,
  // so it never sits on top of the page; on wide screens it docks in the empty right margin. The choice is remembered.
  const [hidden, setHidden0] = useState(false);
  const setHidden = (h: boolean) => {
    setHidden0(h);
    try {
      localStorage.setItem("rn:lt:hidden", h ? "1" : "0");
    } catch {}
  };
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("rn:lt:hidden");
    } catch {}
    const wide = typeof window !== "undefined" && window.matchMedia?.("(min-width: 1880px)").matches;
    setHidden0(saved != null ? saved === "1" : !wide);
  }, []);
  const [waiting, setWaiting] = useState(0);
  const queue = useRef<Toast[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const first = useRef(true);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    const feed = (live.data?.feed || []) as FeedItem[];
    const ag = ((live.data as any)?.agents || []) as { agent: string; at: number; mint: string; symbol: string; text: string; tone: string }[];
    const all = [
      ...feed.map(toastOf),
      ...ag.map((e) => ({ id: `a-${e.at}-${e.agent}-${e.mint}`, tag: e.agent, color: AG_COL[e.agent] || "#8cff5a", sym: e.symbol ? `$${e.symbol}` : "", mint: e.mint || undefined, text: e.text.replace(/^\$\S+\s*/, ""), href: e.mint ? `/c/${e.mint}` : undefined, at: e.at, weight: e.agent === "EXEC" || e.agent === "RISK" || e.tone === "win" ? 3 : 2 } as Toast)),
    ].sort((a, b) => b.at - a.at);
    const fresh = all.filter((t) => (seen.current.has(t.id) ? false : (seen.current.add(t.id), true))).reverse();
    queue.current.push(...(first.current ? fresh.slice(-3) : fresh));
    first.current = false;
    // too much at once: drop the least important (and oldest) first instead of speeding up
    while (queue.current.length > MAX_BACKLOG) {
      let k = 0;
      queue.current.forEach((t, i) => (t.weight < queue.current[k].weight ? (k = i) : null));
      queue.current.splice(k, 1);
    }
    // show something the moment data arrives instead of a placeholder for the first interval
    setCards((c) => {
      if (c.length || !queue.current.length) return c;
      const n = queue.current.shift()!;
      return [n];
    });
    setWaiting(queue.current.length);
  }, [live.tick, live.data]);

  useEffect(() => {
    const t = setInterval(() => {
      if (pausedRef.current) return;
      const next = queue.current.shift();
      setWaiting(queue.current.length);
      if (next) setCards((c) => [...c, next].slice(-3));
    }, SHOW_MS);
    return () => clearInterval(t);
  }, []);

  if (hidden)
    return (
      <button className="lt-dot" onClick={() => setHidden(false)} aria-label="Show live updates">
        <span className="dot" />
        {waiting ? <em>{waiting}</em> : null}
      </button>
    );

  return (
    <aside className={`lt ${paused ? "paused" : ""}`} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)} aria-label="Live updates" aria-live="polite">
      <div className="lt-h">
        <span className="lt-live"><span className="dot" /> LIVE</span>
        <span className="lt-state">{paused ? `paused${waiting ? ` · ${waiting} waiting` : ""}` : waiting > 2 ? `${waiting} queued` : "rats digging"}</span>
        <button onClick={onOpen} title="Open the rat cam">cam</button>
        <button onClick={() => setHidden(true)} title="Hide">×</button>
      </div>
      <div className="lt-stack">
        {cards.map((c, i) => {
          const body = (
            <>
              <i className="lt-bar" style={{ background: c.color }} />
              <div className="lt-top">
                <b style={{ color: c.color }}>{c.tag}</b>
                {c.mint ? <CoinImg mint={c.mint} sym={c.sym} size={22} className="lt-img" /> : null}
                {c.sym ? <span className="lt-sym">{c.sym}</span> : null}
                <span className="lt-ago">{Math.max(0, Math.round((Date.now() - c.at) / 1000)) < 60 ? `${Math.max(0, Math.round((Date.now() - c.at) / 1000))}s` : `${Math.round((Date.now() - c.at) / 60000)}m`}</span>
              </div>
              <div className="lt-text">{c.text}</div>
              {!paused && i === cards.length - 1 ? <i className="lt-timer" style={{ animationDuration: `${SHOW_MS}ms` }} key={c.id} /> : null}
            </>
          );
          const cls = `lt-card ${i === cards.length - 1 ? "new" : ""}`;
          return c.href ? (
            <Link key={c.id} href={c.href} className={cls} style={{ opacity: 0.55 + (i + 1) / (cards.length * 2.2) }}>{body}</Link>
          ) : (
            <div key={c.id} className={cls} style={{ opacity: 0.55 + (i + 1) / (cards.length * 2.2) }}>{body}</div>
          );
        })}
        {!cards.length && <div className="lt-card"><div className="lt-text">waking the rats…</div></div>}
      </div>
    </aside>
  );
}
