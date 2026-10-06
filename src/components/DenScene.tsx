"use client";
import { useEffect, useRef } from "react";

// The Rat Den: eight agent rats at their desks. When an agent acts, its rat hops, its screen flashes
// and a speech bubble shows what it did. A coin token walks the pipeline when the desk buys.

type Ev = { agent: string; at: number; symbol?: string; text: string; tone: string };
const ORDER = ["SCOUT", "KING", "VET", "FLOW", "SIZE", "EXEC", "RISK", "LEDGER"];
export const AGENT_COLOR: Record<string, string> = {
  SCOUT: "#8cff5a",
  KING: "#ffb547",
  VET: "#7fd1ff",
  FLOW: "#c08bff",
  SIZE: "#5ee6c8",
  EXEC: "#ff7ab6",
  RISK: "#ff5c5c",
  LEDGER: "#e8e8e8",
};
const TONE: Record<string, string> = { ok: "#8cff5a", bad: "#ff5c5c", info: "#c8d3cc", win: "#ffb547", loss: "#ff5c5c" };
const RAT = [
  "...........##....",
  "..........#..#...",
  ".....#######..#..",
  "...###########.#.",
  "..############..#",
  "..#############.#",
  "..##############.",
  ".#.###########...",
  "#...#..#...#..#..",
];
const CROWN = ["#.#.#", "#####"];

export default function DenScene({ agents, events }: { agents: Record<string, Ev>; events: Ev[] }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const state = useRef({ agents, events, seen: new Set<string>(), bubbles: {} as Record<string, { text: string; tone: string; until: number; hop: number }>, tokens: [] as { path: number[]; t0: number; label: string; color: string }[] });
  state.current.agents = agents;
  state.current.events = events;

  // turn new events into bubbles and travelling tokens
  useEffect(() => {
    const st = state.current;
    const fresh = [...events].reverse().filter((e) => {
      const k = `${e.at}-${e.agent}-${e.text}`;
      if (st.seen.has(k)) return false;
      st.seen.add(k);
      return true;
    });
    const firstLoad = st.seen.size === fresh.length;
    fresh.slice(firstLoad ? -4 : 0).forEach((e, i) => {
      const delay = i * 900;
      setTimeout(() => {
        st.bubbles[e.agent] = { text: e.text, tone: e.tone, until: performance.now() + 4200, hop: performance.now() };
        if (e.agent === "EXEC" && /bought/.test(e.text)) st.tokens.push({ path: [0, 1, 2, 3, 4, 5], t0: performance.now(), label: e.symbol ? `$${e.symbol}` : "$", color: "#ffb547" });
        if (e.agent === "RISK" && /sold/.test(e.text)) st.tokens.push({ path: [6, 7], t0: performance.now(), label: e.tone === "win" ? "+◎" : "-◎", color: TONE[e.tone] || "#fff" });
      }, delay);
    });
  }, [events]);

  useEffect(() => {
    const c = cv.current;
    const el = wrap.current;
    if (!c || !el) return;
    const ctx = c.getContext("2d")!;
    let W = 0;
    const H = 340;
    const resize = () => {
      W = el.clientWidth;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = W * dpr;
      c.height = H * dpr;
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    let raf = 0;
    const charts = ORDER.map(() => Array.from({ length: 16 }, () => Math.random()));

    const deskPos = (i: number) => {
      const cols = W < 640 ? 2 : 4;
      const row = Math.floor(i / cols);
      const col = i % cols;
      const cw = (W - 40) / cols;
      return { x: 20 + col * cw + cw / 2, y: (cols === 2 ? 70 : 120) + row * (cols === 2 ? 66 : 120) };
    };

    const sprite = (rows: string[], x: number, y: number, px: number, color: string) => {
      ctx.fillStyle = color;
      rows.forEach((r, j) => r.split("").forEach((ch, k) => ch === "#" && ctx.fillRect(x + k * px, y + j * px, px, px)));
    };

    const draw = (ts: number) => {
      raf = requestAnimationFrame(draw);
      const st = state.current;
      ctx.clearRect(0, 0, W, H);
      // back wall: tunnel bricks
      ctx.fillStyle = "#070a08";
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(140,255,90,0.05)";
      for (let y = 0; y < H; y += 16) {
        for (let x = (y / 16) % 2 ? -16 : 0; x < W; x += 32) ctx.strokeRect(x, y, 32, 16);
      }
      // floor
      ctx.fillStyle = "#0b100d";
      ctx.fillRect(0, H - 40, W, 40);
      ctx.fillStyle = "rgba(140,255,90,0.08)";
      ctx.fillRect(0, H - 40, W, 1);
      // props: server rack (right), graduation rocket (left)
      if (W > 640) {
        ctx.fillStyle = "#111a15";
        ctx.fillRect(W - 46, H - 150, 30, 110);
        for (let i = 0; i < 9; i++) {
          ctx.fillStyle = Math.sin(ts / 200 + i) > 0.3 ? "#8cff5a" : "#1d2b23";
          ctx.fillRect(W - 40, H - 144 + i * 11, 4, 3);
          ctx.fillStyle = "#1a2620";
          ctx.fillRect(W - 32, H - 144 + i * 11, 12, 3);
        }
        ctx.fillStyle = "#c8d3cc";
        ctx.fillRect(22, H - 92, 8, 30);
        ctx.fillStyle = "#ffb547";
        ctx.fillRect(20, H - 64, 12, 6);
        ctx.fillStyle = Math.sin(ts / 90) > 0 ? "#ff5c5c" : "#ffb547";
        ctx.fillRect(23, H - 58, 6, 4 + Math.abs(Math.sin(ts / 120)) * 6);
        ctx.fillStyle = "#6c7b73";
        ctx.font = "9px monospace";
        ctx.fillText("GRAD", 14, H - 22);
        ctx.fillText("RACK", W - 46, H - 22);
      }

      // pipeline lines
      ctx.strokeStyle = "rgba(140,255,90,0.12)";
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ORDER.forEach((_, i) => {
        const p = deskPos(i);
        if (i === 0) ctx.moveTo(p.x, p.y - 30);
        else ctx.lineTo(p.x, p.y - 30);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      ORDER.forEach((a, i) => {
        const { x, y } = deskPos(i);
        const col = AGENT_COLOR[a];
        const b = st.bubbles[a];
        const active = b && ts < b.until;
        const hop = b ? Math.max(0, 1 - (ts - b.hop) / 400) : 0;
        // desk
        ctx.fillStyle = "#111914";
        ctx.fillRect(x - 46, y + 10, 92, 8);
        ctx.fillStyle = "#0d1410";
        ctx.fillRect(x - 40, y + 18, 6, 20);
        ctx.fillRect(x + 34, y + 18, 6, 20);
        // monitor with mini chart
        ctx.fillStyle = active ? "rgba(140,255,90,0.12)" : "#0a0f0c";
        ctx.strokeStyle = active ? col : "#1d2b23";
        ctx.fillRect(x + 2, y - 30, 40, 26);
        ctx.strokeRect(x + 2.5, y - 29.5, 39, 25);
        const ch = charts[i];
        if (Math.random() < 0.02) {
          ch.shift();
          ch.push(Math.random());
        }
        ctx.strokeStyle = col;
        ctx.beginPath();
        ch.forEach((v, k) => {
          const px = x + 5 + k * 2.2;
          const py = y - 8 - v * 18;
          k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        });
        ctx.stroke();
        ctx.fillStyle = "#1d2b23";
        ctx.fillRect(x + 20, y - 4, 4, 14);
        // rat
        const ry = y - 8 - Math.sin(hop * Math.PI) * 10;
        ctx.shadowColor = col;
        ctx.shadowBlur = active ? 10 : 0;
        const px = W < 640 ? 2 : 3;
        sprite(RAT, x - 18 * px, ry - (px - 2) * 9, px, col);
        if (a === "KING") sprite(CROWN, x - 13 * px, ry - (px - 2) * 9 - 3 * px, px, "#ffb547");
        ctx.shadowBlur = 0;
        // name plate
        ctx.font = "10px monospace";
        ctx.fillStyle = active ? col : "#6c7b73";
        ctx.fillText(a, x - 46, y + 32);
        // bubble
        if (active && b) {
          const text = b.text.length > 46 ? b.text.slice(0, 45) + "…" : b.text;
          ctx.font = "10px monospace";
          const w = Math.min(ctx.measureText(text).width + 14, W - 20);
          const bx = Math.max(6, Math.min(W - w - 6, x - w / 2));
          const by = y - 70;
          const fade = Math.min(1, (b.until - ts) / 500);
          ctx.globalAlpha = fade;
          ctx.fillStyle = "rgba(6,8,7,0.95)";
          ctx.strokeStyle = TONE[b.tone] || col;
          ctx.fillRect(bx, by, w, 20);
          ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, 19);
          ctx.fillStyle = TONE[b.tone] || col;
          ctx.fillText(text, bx + 7, by + 14);
          ctx.globalAlpha = 1;
        }
      });

      // travelling tokens
      st.tokens = st.tokens.filter((tk) => ts - tk.t0 < tk.path.length * 450 + 400);
      for (const tk of st.tokens) {
        const k = Math.min(tk.path.length - 1, (ts - tk.t0) / 450);
        const i0 = Math.floor(k);
        const i1 = Math.min(tk.path.length - 1, i0 + 1);
        const f = k - i0;
        const a = deskPos(tk.path[i0]);
        const bb = deskPos(tk.path[i1]);
        const x = a.x + (bb.x - a.x) * f;
        const y = a.y - 40 + (bb.y - a.y) * f - Math.sin(f * Math.PI) * 14;
        ctx.fillStyle = tk.color;
        ctx.shadowColor = tk.color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.font = "10px monospace";
        ctx.fillText(tk.label, x + 9, y + 3);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={wrap} style={{ width: "100%" }}>
      <canvas ref={cv} style={{ display: "block", imageRendering: "pixelated" }} />
    </div>
  );
}
