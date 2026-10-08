"use client";
// One poller per URL for the whole page (v0.1.38). Before, every component fetched on its own timer: the desk page
// alone asked /api/desk, /api/rats or /api/king two or three times over, every 1.5 to 5 seconds.
//  - components asking for the same URL share one request and one cached answer
//  - nothing polls faster than every 5 seconds
//  - a component can pass the element it draws into: while that element is off-screen it does not poll
//  - every request has a 10s timeout and is cancelled when nothing listens any more
//  - a URL change never shows the previous URL's data
//  - when answers stop coming, the page shows a small "stale" chip (see StaleChip)
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

const MIN_MS = 5_000;
const TIMEOUT_MS = 10_000;

type Entry = { data: unknown; error: string; at: number; okAt: number; fails: number; inflight: Promise<void> | null; ctrl: AbortController | null; subs: Set<() => void> };
const STORE = new Map<string, Entry>();
const entry = (url: string) => {
  let e = STORE.get(url);
  if (!e) STORE.set(url, (e = { data: null, error: "", at: 0, okAt: 0, fails: 0, inflight: null, ctrl: null, subs: new Set() }));
  return e;
};

// page-wide health for the stale chip: how many URLs failed their last two loads in a row
const health = { failing: new Set<string>(), subs: new Set<() => void>() };
const notifyHealth = () => health.subs.forEach((f) => f());
export const useStale = () =>
  useSyncExternalStore(
    (f) => (health.subs.add(f), () => health.subs.delete(f)),
    () => health.failing.size,
    () => 0,
  );

async function fetchInto(url: string, force = false) {
  const e = entry(url);
  if (e.inflight) return e.inflight;
  // another component loaded this URL a moment ago: share its answer
  if (!force && Date.now() - e.at < 1_500) return;
  const ctrl = new AbortController();
  e.ctrl = ctrl;
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  e.inflight = (async () => {
    try {
      const r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `error ${r.status}`);
      e.data = j;
      e.error = "";
      e.okAt = Date.now();
      e.fails = 0;
      if (health.failing.delete(url)) notifyHealth();
    } catch (err: any) {
      if (err?.name === "AbortError" && !e.subs.size) return; // nobody listens any more
      e.error = err?.name === "AbortError" ? "timeout" : String(err?.message || "offline");
      e.fails++;
      if (e.fails >= 2 && !health.failing.has(url)) (health.failing.add(url), notifyHealth());
    } finally {
      clearTimeout(timer);
      e.at = Date.now();
      e.inflight = null;
      e.ctrl = null;
      e.subs.forEach((f) => f());
    }
  })();
  return e.inflight;
}

/** Is the element on screen (or within 400px of it)? Always true without an element. */
function useOnScreen(ref?: RefObject<Element | null>) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref?.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([x]) => setOn(!!x?.isIntersecting), { rootMargin: "400px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}

/** Poll a URL (null = paused). Loads again the moment a background tab becomes visible. */
export function usePoll<T>(url: string | null, ms = 5000, opts: { ref?: RefObject<Element | null> } = {}) {
  const every = Math.max(MIN_MS, ms);
  const onScreen = useOnScreen(opts.ref);
  const [, bump] = useState(0);
  const urlRef = useRef(url);
  urlRef.current = url;

  useEffect(() => {
    if (!url) return;
    const e = entry(url);
    const sub = () => bump((n) => n + 1);
    e.subs.add(sub);
    return () => {
      e.subs.delete(sub);
      if (!e.subs.size) e.ctrl?.abort();
    };
  }, [url]);

  const load = useCallback(async () => {
    const u = urlRef.current;
    if (u) await fetchInto(u, true);
  }, []);

  useEffect(() => {
    if (!url) return;
    const e = entry(url);
    // first look: right away unless another component just loaded it
    if (Date.now() - e.at > every / 2) fetchInto(url);
    if (!onScreen) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - entry(url).at >= every - 250) fetchInto(url);
    };
    const t = setInterval(tick, every);
    const vis = () => document.visibilityState === "visible" && Date.now() - entry(url).at > 2_000 && fetchInto(url);
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [url, every, onScreen]);

  const e = url ? STORE.get(url) : undefined;
  const stale = !!e && e.okAt > 0 && Date.now() - e.okAt > every * 3 + TIMEOUT_MS;
  return { data: (e?.data ?? null) as T | null, error: e?.error ?? "", stale, reload: load };
}
