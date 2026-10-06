"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export function usePoll<T>(url: string, ms = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string>("");
  const alive = useRef(true);
  const load = useCallback(async () => {
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
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load, ms]);
  return { data, error, reload: load };
}
