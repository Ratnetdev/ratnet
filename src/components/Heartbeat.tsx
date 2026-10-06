"use client";
import { useEffect } from "react";

// Every open page nudges the rats to dig. The server lock makes sure only one dig runs at a time.
export default function Heartbeat() {
  useEffect(() => {
    let stop = false;
    const beat = () => {
      if (stop || document.visibilityState !== "visible") return;
      fetch("/api/dig", { method: "POST", keepalive: true }).catch(() => {});
    };
    const first = setTimeout(beat, 1500);
    const t = setInterval(beat, 12000);
    return () => {
      stop = true;
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  return null;
}
