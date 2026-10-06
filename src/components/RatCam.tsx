"use client";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type FeedItem = { kind: string; rat: string; mint: string; symbol: string; name: string; at: number; text: string };
type Line = { t: string; c?: string; href?: string };
type Mode = "open" | "min";

// ---------- tunnel scene
const CELL = 3;
const W = 320;
const H = 96;
const COLS = Math.ceil(W / CELL) + 2;
const ROWS_N = Math.floor(H / CELL);
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
    case "h1":
      return [{ t: `> recheck ${sym} at 1h`, c: "#8cff5a", href }, { t: `  ${parts.slice(1).join(" · ")}` }];
    case "resolve":
      return [{ t: `> settle ${sym} ${parts[0]}`, c: colorFor(f), href }, ...parts.slice(1, 2).map((p) => ({ t: `  ${p}` }))];
    default:
      return [{ t: `> ${f.rat.toLowerCase()} ${sym}`, c: "#8cff5a", href }, { t: `  ${parts.join(" · ")}` }];
  }
}

function useTunnel(canvas: React.RefObject<HTMLCanvasElement>, active: boolean, nuggets: React.MutableRefObject<Nugget[]>) {
  useEffect(() => {
    if (!active) return;
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

    const draw = (ts: number) => {
      raf = requestAnimationFrame(draw);
      if (ts - last < 60) return;
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
        for (let dy = -3; dy <= 3; dy++) {
          const r = ratRow + dy;
          const col = world[ratCol + 12];
          if (col && r >= 0 && r < ROWS_N) col[r] = 1;
        }
        // keep the rat at ~35% of the screen
        if (ratCol - base > Math.floor(COLS * 0.35)) base++;
        // reached a nugget?
        for (const n of nuggets.current) {
          if (!n.hit && ratCol + 12 >= n.col && Math.abs(ratRow - n.row) <= 3) {
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
      ctx.font = "9px monospace";
      for (const n of nuggets.current) {
        const sx = (n.col - base) * CELL;
        if (sx < -40 || sx > W + 10) continue;
        const sz = n.big ? 4 : 3;
        ctx.fillStyle = n.hit ? "rgba(255,255,255,0.15)" : n.color;
        for (let i = 0; i < sz; i++) for (let j = 0; j < sz; j++) if ((i + j) % 3 !== 2 || n.big) ctx.fillRect(sx + i * CELL, (n.row - 1 + j) * CELL, CELL - 0.5, CELL - 0.5);
        if (!n.hit) {
          ctx.fillStyle = n.color;
          ctx.fillText(n.label, sx - 2, Math.max(9, (n.row - 2) * CELL));
        }
      }
      // rat
      const rx = (ratCol - base) * CELL;
      const ry = (ratRow - 3) * CELL - 1;
      const sprite = [...RAT, LEGS[frame % 4 < 2 ? 0 : 1]];
      ctx.fillStyle = "#8cff5a";
      ctx.shadowColor = "rgba(140,255,90,0.8)";
      ctx.shadowBlur = 6;
      const px = 2.2;
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
    return () => cancelAnimationFrame(raf);
  }, [active, canvas, nuggets]);
}

export default function RatCam() {
  const path = usePathname();
  const [mode, setMode] = useState<Mode>("min");
  const [lines, setLines] = useState<Line[]>([]);
  const [typing, setTyping] = useState<{ line: Line; n: number } | null>(null);
  const [rat, setRat] = useState("SCOUT-1");
  const [stats, setStats] = useState<{ dug: number; bonded: number } | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const queue = useRef<FeedItem[]>([]);
  const nuggets = useRef<Nugget[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const first = useRef(true);

  // default: open on the home page on wide screens, minimized elsewhere; the viewer's choice wins
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("rn_cam");
    } catch {}
    if (saved === "open" || saved === "min") setMode(saved);
    else setMode(path === "/" && window.innerWidth > 900 ? "open" : "min");
  }, [path]);
  const choose = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem("rn_cam", m);
    } catch {}
  };

  // poll the live feed (CDN cached, so cheap)
  useEffect(() => {
    let stop = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/live", { cache: "no-store" });
        const j = await r.json();
        if (stop || !j.feed) return;
        setStats({ dug: j.stats?.dug ?? 0, bonded: j.stats?.bonded ?? 0 });
        const fresh = (j.feed as FeedItem[]).filter((f) => {
          const k = `${f.at}-${f.mint}-${f.kind}`;
          if (seen.current.has(k)) return false;
          seen.current.add(k);
          return true;
        });
        const ordered = fresh.reverse(); // oldest first
        queue.current.push(...(first.current ? ordered.slice(-6) : ordered));
        first.current = false;
        if (queue.current.length > 30) queue.current = queue.current.slice(-30);
      } catch {}
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

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
            setLines((l) => [...l, next].slice(-9));
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
  }, []);

  useTunnel(canvas, mode === "open", nuggets);

  if (path?.startsWith("/admin")) return null;

  if (mode === "min")
    return (
      <button className="ratcam-pill" onClick={() => choose("open")} aria-label="Open rat cam">
        <span className="dot" /> RAT CAM <span className="muted">{rat}</span>
        <span className="pill-line">{typing ? typing.line.t.slice(0, typing.n) : lines[lines.length - 1]?.t || "waking up…"}</span>
      </button>
    );

  return (
    <aside className="ratcam" aria-label="Rat cam, live">
      <div className="ratcam-h">
        <span className="row" style={{ gap: 6 }}>
          <span className="dot" /> <b>RAT CAM</b> <span className="muted">· {rat} · live</span>
        </span>
        <button onClick={() => choose("min")} aria-label="Minimize">_</button>
      </div>
      <canvas ref={canvas} style={{ width: W, height: H, display: "block", maxWidth: "100%" }} />
      <div className="ratcam-t">
        {lines.map((l, i) => (
          <div key={i} style={{ color: l.c || "var(--dim)", opacity: 0.45 + (i / lines.length) * 0.55, whiteSpace: "pre" }}>
            {l.href ? <Link href={l.href} style={{ color: "inherit" }}>{l.t}</Link> : l.t}
          </div>
        ))}
        <div style={{ color: typing?.line.c || "var(--text)", whiteSpace: "pre" }}>
          {typing ? typing.line.t.slice(0, typing.n) : ""}
          <span className="caret" style={{ width: 6, height: "0.9em" }} />
        </div>
      </div>
      <div className="ratcam-f">
        <span>{stats ? `${stats.dug.toLocaleString("en-US")} dug · ${stats.bonded.toLocaleString("en-US")} graduated` : "connecting…"}</span>
        <Link href="/rats">rats →</Link>
      </div>
    </aside>
  );
}
