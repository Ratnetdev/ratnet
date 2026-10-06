"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLive } from "./Live";
import AlertCard, { AlertT, Kind as CardKind, Term, TERMS } from "./AlertCard";

type FeedItem = { kind: string; rat: string; mint: string; symbol: string; name: string; at: number; text: string };
type Settings = { on: boolean; king: boolean; nano: boolean; agree: boolean; near: boolean; grad: boolean; desk: boolean; sound: boolean; vol: number; push: boolean; term: Term };
type Kind = CardKind;
type Toast = AlertT & { exp: number; pinned?: boolean; hover?: boolean };
const LIFE: Record<Kind, number> = { bond: 25_000, near: 18_000, grad: 18_000, desk: 18_000 };

const DEF: Settings = { on: false, king: true, nano: true, agree: false, near: true, grad: true, desk: true, sound: true, vol: 0.5, push: false, term: "gmgn" };

function load(): Settings {
  try {
    const raw = localStorage.getItem("rn_alerts");
    if (raw) return { ...DEF, ...JSON.parse(raw) };
  } catch {}
  return DEF;
}

// ---------- sounds, synthesized so there are no files to load
let ac: AudioContext | null = null;
function audio() {
  if (typeof window === "undefined") return null;
  if (!ac) {
    const C = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!C) return null;
    ac = new C();
  }
  if (ac!.state === "suspended") ac!.resume().catch(() => {});
  return ac;
}
function tone(freq: number, start: number, dur: number, vol: number, type: OscillatorType = "square", slide?: number) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + start;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol * 0.25, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
export function playSound(kind: Kind, vol: number) {
  if (kind === "bond") {
    // the rat squeak: two quick upward chirps
    tone(1400, 0, 0.09, vol, "square", 2600);
    tone(1700, 0.12, 0.11, vol, "square", 3200);
  } else if (kind === "near" || kind === "desk") {
    [0, 0.1, 0.2].forEach((s, i) => tone(880 + i * 220, s, 0.07, vol * 0.8, "triangle"));
  } else {
    // graduation: arpeggio
    [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.09, i === 3 ? 0.35 : 0.12, vol, "square"));
  }
}

function parseCall(text: string) {
  const v = text.match(/^(BOND|WATCH|DUST) (\d+)/);
  const n = text.match(/nano (BOND|WATCH|DUST) (\d+)/);
  return { v: v?.[1] || "", vs: Number(v?.[2] || 0), n: n?.[1] || "", ns: Number(n?.[2] || 0), late: /late/.test(text) };
}


export default function Alerts() {
  const live = useLive();
  const [s, setS] = useState<Settings>(DEF);
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [unread, setUnread] = useState(0);
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const baseTitle = useRef("");
  const hiddenCount = useRef(0);

  useEffect(() => setS(load()), []);
  useEffect(() => {
    (window as any).__rnAlerts = s.on;
    try {
      localStorage.setItem("rn_alerts", JSON.stringify(s));
    } catch {}
  }, [s]);
  const set = (p: Partial<Settings>) => setS((x) => ({ ...x, ...p }));

  // restore the tab title when the viewer comes back
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && baseTitle.current) {
        document.title = baseTitle.current;
        hiddenCount.current = 0;
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const fire = useCallback(
    (t: Toast) => {
      setToasts((x) => [t, ...x.filter((y) => y.id !== t.id)].slice(0, 8));
      setUnread((u) => u + 1);
      if (s.sound) playSound(t.kind, s.vol);
      if (document.visibilityState !== "visible") {
        if (!baseTitle.current || !document.title.startsWith("(")) baseTitle.current = document.title;
        hiddenCount.current++;
        document.title = `(${hiddenCount.current}) ${t.title}`;
        if (s.push && "Notification" in window && Notification.permission === "granted") {
          try {
            const n = new Notification(t.title, { body: t.sub, tag: t.id, icon: "/icon.svg" });
            n.onclick = () => {
              window.focus();
              window.location.href = `/c/${t.mint}`;
            };
          } catch {}
        }
      }
    },
    [s.sound, s.vol, s.push]
  );

  // expire cards; a hovered or pinned card stays
  useEffect(() => {
    const iv = setInterval(() => {
      const now = Date.now();
      setToasts((x) => {
        const next = x.map((y) => (y.hover ? { ...y, exp: Math.max(y.exp, now + 4000) } : y)).filter((y) => y.pinned || y.exp > now);
        return next.length === x.length && next.every((y, i) => y === x[i]) ? x : next;
      });
    }, 500);
    return () => clearInterval(iv);
  }, []);
  const patch = (id: string, p: Partial<Toast>) => setToasts((x) => x.map((y) => (y.id === id ? { ...y, ...p } : y)));
  const close = (id: string) => setToasts((x) => x.filter((y) => y.id !== id));

  useEffect(() => {
    const feed = (live.data?.feed || []) as FeedItem[];
    if (!feed.length) return;
    const fresh: FeedItem[] = [];
    for (const f of feed) {
      const k = `${f.at}-${f.mint}-${f.kind}`;
      if (seen.current.has(k)) continue;
      seen.current.add(k);
      fresh.push(f);
    }
    if (!primed.current) {
      primed.current = true; // never alert on what was already there when the page opened
      return;
    }
    if (!s.on) return;
    for (const f of fresh.reverse()) {
      const id = `${f.at}-${f.mint}-${f.kind}`;
      if (f.kind === "call") {
        const c = parseCall(f.text);
        if (c.late) continue;
        const kingBond = c.v === "BOND";
        const nanoBond = c.n === "BOND";
        const hit = s.agree ? kingBond && nanoBond : (s.king && kingBond) || (s.nano && nanoBond);
        if (!hit) continue;
        const who = kingBond && nanoBond ? "King + nano agree" : kingBond ? "King" : "Nano";
        fire({ id, kind: "bond", title: `${who} BOND · $${f.symbol}`, sub: `King ${c.v} ${c.vs}${c.n ? ` · nano ${c.n} ${c.ns}` : ""}`, mint: f.mint, symbol: f.symbol, at: f.at, king: c.vs, nano: c.n ? c.ns : null, who, exp: Date.now() + LIFE.bond });
      } else if (f.kind === "near" && s.near) {
        fire({ id, kind: "near", title: `About to bond · $${f.symbol}`, sub: f.text.replace(/^about to graduate · /, ""), mint: f.mint, symbol: f.symbol, at: f.at, exp: Date.now() + LIFE.near });
      } else if (f.kind === "grad" && s.grad) {
        fire({ id, kind: "grad", title: `Graduated · $${f.symbol}`, sub: f.text.replace(/^GRADUATED /, ""), mint: f.mint, symbol: f.symbol, at: f.at, who: f.text.match(/in [\dhm s]+/)?.[0]?.trim(), exp: Date.now() + LIFE.grad });
      } else if (f.kind === "desk" && s.desk && f.rat === "DESK·EXEC" && /^bought/.test(f.text) && f.mint) {
        fire({ id, kind: "desk", title: `Desk bought $${f.symbol}`, sub: f.text, mint: f.mint, symbol: f.symbol, at: f.at, who: /paper/.test(f.text) ? "paper" : "live", exp: Date.now() + LIFE.desk });
      }
    }
  }, [live.tick, live.data, s.on, s.king, s.nano, s.agree, s.near, s.grad, s.desk, fire]);

  const enable = async () => {
    audio();
    set({ on: true });
    playSound("bond", s.vol);
  };
  const askPush = async () => {
    if (!("Notification" in window)) return;
    const res = await Notification.requestPermission();
    set({ push: res === "granted" });
  };

  return (
    <>
      <span style={{ position: "relative" }}>
        <button
          className={`bell ${s.on ? "on" : ""}`}
          aria-label="Alerts"
          onClick={() => {
            setOpen(!open);
            setUnread(0);
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden shapeRendering="crispEdges" fill="currentColor">
            <rect x="6" y="1" width="4" height="1" />
            <rect x="4" y="2" width="8" height="1" />
            <rect x="3" y="3" width="10" height="6" />
            <rect x="2" y="9" width="12" height="2" />
            <rect x="1" y="11" width="14" height="1" />
            <rect x="6" y="13" width="4" height="2" />
          </svg>
          {unread > 0 && <span className="bell-n">{unread > 9 ? "9+" : unread}</span>}
        </button>
        {open && (
          <div className="panel alerts-pop">
            <div className="ph"><span><b>alerts</b> · sound + popups</span><button className="x" onClick={() => setOpen(false)}>×</button></div>
            <div className="pb small">
              {!s.on ? (
                <>
                  <p className="muted" style={{ marginTop: 0 }}>Get a sound and a popup the moment the King calls BOND, a coin is about to graduate, or one graduates. Keep this tab open.</p>
                  <button className="btn" onClick={enable}>Turn on alerts</button>
                </>
              ) : (
                <>
                  <div className="row between"><span className="green">ALERTS ON</span><button className="btn dim" style={{ padding: "3px 10px" }} onClick={() => set({ on: false })}>turn off</button></div>
                  <div className="alerts-opts">
                    {(
                      [
                        ["king", "King calls BOND"],
                        ["nano", "Nano calls BOND"],
                        ["agree", "Only when King + nano agree"],
                        ["near", "Coin about to graduate (85%+)"],
                        ["grad", "Coin graduated"],
                        ["desk", "The desk buys a coin"],
                        ["sound", "Sound"],
                      ] as [keyof Settings, string][]
                    ).map(([k, l]) => (
                      <label key={k} className="row" style={{ gap: 8, cursor: "pointer" }}>
                        <input type="checkbox" checked={!!s[k]} onChange={(e) => set({ [k]: e.target.checked } as Partial<Settings>)} style={{ accentColor: "var(--rat)" }} />
                        {l}
                      </label>
                    ))}
                  </div>
                  <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                    <span className="muted tiny">buy button opens</span>
                    <select className="input" style={{ padding: "4px 8px", fontSize: 12, flex: 1, margin: 0 }} value={s.term} onChange={(e) => set({ term: e.target.value as Term })}>
                      {(Object.keys(TERMS) as Term[]).map((k) => (
                        <option key={k} value={k}>{TERMS[k].label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="muted tiny">volume</span>
                    <input type="range" min={0} max={1} step={0.05} value={s.vol} onChange={(e) => set({ vol: Number(e.target.value) })} style={{ accentColor: "var(--rat)", flex: 1 }} />
                  </div>
                  <div className="row wrapx mt" style={{ gap: 6 }}>
                    <button className="btn dim" style={{ padding: "3px 10px" }} onClick={() => playSound("bond", s.vol)}>test BOND</button>
                    <button className="btn dim" style={{ padding: "3px 10px" }} onClick={() => playSound("near", s.vol)}>test near</button>
                    <button className="btn dim" style={{ padding: "3px 10px" }} onClick={() => playSound("grad", s.vol)}>test grad</button>
                  </div>
                  <div className="mt">
                    {s.push ? (
                      <span className="tiny green">Desktop notifications on when this tab is in the background.</span>
                    ) : (
                      <button className="btn ghost" style={{ padding: "5px 12px" }} onClick={askPush}>Also notify me in the background</button>
                    )}
                  </div>
                  <p className="tiny muted">Shortcuts on the newest alert: <kbd>B</kbd> buy · <kbd>C</kbd> copy CA · <kbd>O</kbd> open · <kbd>P</kbd> pin · <kbd>Esc</kbd> close. Hover keeps an alert open.</p>
                  <p className="tiny muted" style={{ marginBottom: 0 }}>Browsers slow down background tabs, so alerts there can arrive up to a minute late. Not financial advice.</p>
                </>
              )}
            </div>
          </div>
        )}
      </span>

      <div className="toasts" aria-live="polite">
        {toasts.slice(0, 3).map((t, i) => (
          <AlertCard
            key={t.id}
            t={t}
            term={s.term}
            top={i === 0}
            pinned={!!t.pinned}
            life={LIFE[t.kind]}
            onClose={() => close(t.id)}
            onPin={() => patch(t.id, { pinned: !t.pinned })}
            onHover={(h) => patch(t.id, { hover: h })}
          />
        ))}
        {toasts.length > 3 && (
          <button className="ac-more" onClick={() => setToasts((x) => x.slice(0, 3))}>
            +{toasts.length - 3} more · clear
          </button>
        )}
      </div>
    </>
  );
}
