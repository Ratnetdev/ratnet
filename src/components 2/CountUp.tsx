"use client";
import { useEffect, useRef, useState } from "react";

/** Number that rolls to its new value. */
export default function CountUp({ value, decimals = 0, suffix = "" }: { value: number | null | undefined; decimals?: number; suffix?: string }) {
  const [shown, setShown] = useState(value ?? 0);
  const from = useRef(value ?? 0);
  useEffect(() => {
    if (value == null) return;
    const start = performance.now();
    const a = from.current;
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
