// v0.1.87: how late the worker's event loop runs. The firehose decodes ~400 messages a second in the same process as
// the desk and the rats; if the loop falls behind, every timer and every read waits (the fast lane hung 5 times on the
// night of 15 Oct). Measured over the last minute: median, p99 and worst delay in ms. Worker only.
import { monitorEventLoopDelay, type IntervalHistogram } from "perf_hooks";

let h: IntervalHistogram | null = null;
let last: { p50: number; p99: number; max: number; at: number } | null = null;
let at = 0;
const RES = 10; // ms between samples; an idle loop reads about this much, so it is taken off (lateness only)

export function startLoopLag() {
  if (h) return;
  h = monitorEventLoopDelay({ resolution: RES });
  h.enable();
  at = Date.now();
}

/** The last full minute (and the one in progress until the first minute is over). */
export function loopLag(now = Date.now()) {
  if (!h) return null;
  const ms = (ns: number) => Math.max(0, Math.round(ns / 1e6 - RES));
  const cur = { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max), at: now };
  if (now - at >= 60_000) {
    last = cur;
    h.reset();
    at = now;
  }
  return last ?? cur;
}
