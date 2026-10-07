"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";

// One poller for the whole app: the feed, the Rat Cam, alerts and the CA bar all read the same snapshot.
export type LiveSnap = any;
type Ctx = { data: LiveSnap | null; error: boolean; tick: number };
const LiveCtx = createContext<Ctx>({ data: null, error: false, tick: 0 });

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Ctx>({ data: null, error: false, tick: 0 });
  const busy = useRef(false);
  useEffect(() => {
    let stop = false;
    const load = async (first?: boolean) => {
      // background tabs keep polling only when the viewer turned alerts on (the first load always runs, so a page
      // opened in a background tab is ready when it is shown)
      if (busy.current || (!first && document.visibilityState !== "visible" && !(window as any).__rnAlerts)) return;
      busy.current = true;
      try {
        const r = await fetch("/api/live", { cache: "no-store" });
        const j = await r.json();
        if (!stop) setState((s) => (r.ok ? { data: j, error: false, tick: s.tick + 1 } : { ...s, error: true }));
      } catch {
        if (!stop) setState((s) => ({ ...s, error: true }));
      } finally {
        busy.current = false;
      }
    };
    load(true);
    const t = setInterval(() => load(), 4000);
    const vis = () => load();
    document.addEventListener("visibilitychange", vis);
    return () => {
      stop = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);
  return <LiveCtx.Provider value={state}>{children}</LiveCtx.Provider>;
}

export const useLive = () => useContext(LiveCtx);
