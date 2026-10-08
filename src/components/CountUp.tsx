"use client";
import { useEffect, useRef, useState } from "react";

/** Number that rolls to its new value. */
export default function CountUp({ value, decimals = 0, suffix = "" }: { value: number | null | undefined; decimals?: number; suffix?: string }) {
  const [shown, setShown] = useState(value ?? 0);
  const from = useRef<number | null>(value ?? null);
  useEffect(() => {
    if (value == null) return;
    // the first number shows as it is (it used to roll up from 0 on every page load)
    if (from.current == null) {
      from.current = value;
      setShown(value);
      return;
    }
    // reduced motion: the new number, no roll
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current as number;
    const b = value;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 900);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(a + (b - a) * e);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = b;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  if (value == null) return <>–</>;
  return <>{shown.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{suffix}</>;
}
