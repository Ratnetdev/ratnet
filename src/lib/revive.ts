// v0.1.57: when a hung background loop may be restarted on its own (instead of the whole worker). Two restarts of the
// same loop within 30 minutes are allowed; a third means something a fresh loop does not fix, so the process restarts.
export const REVIVE_WINDOW_MS = 30 * 60_000;
export const REVIVE_MAX = 2;
export function reviveAllowed(times: number[], now = Date.now()) {
  const recent = times.filter((t) => now - t < REVIVE_WINDOW_MS);
  return { ok: recent.length < REVIVE_MAX, recent: recent.length < REVIVE_MAX ? [...recent, now] : recent };
}
