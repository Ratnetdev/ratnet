"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Poll a URL (null = paused). Loads again the moment a background tab becomes visible. */
export function usePoll<T>(url: string | null, ms = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string>("");
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!url) return;
    try {
      const r = await fetch(url, { cache: "no-store" });
      const j = await r.json();
      if (!alive.current) return;
      if (!r.ok) setError(j.error || "error");
      else {
        setData(j);
        setError("");
      }
    } catch {
      if (alive.current) setError("offline");
    }
  }, [url]);
  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), ms);
    const vis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", vis);
    return () => {
      alive.current = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [load, ms]);
  return { data, error, reload: load };
}
