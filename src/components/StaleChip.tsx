"use client";
// A small chip when the page stops getting fresh data (two failed loads in a row on any feed it shows), so numbers
// that stopped moving never pass for live ones.
import { useStale } from "./usePoll";
import { useLive } from "./Live";

export default function StaleChip() {
  const failing = useStale();
  const live = useLive();
  if (!failing && !live.error) return null;
  return (
    <div className="stale-chip" role="status" aria-live="polite">
      <i aria-hidden /> data paused · reconnecting
    </div>
  );
}
