// Every outside call gets a deadline. A fetch with no signal waits forever when the other side hangs (Jupiter's price
// API, Telegram, DexScreener...), and in the always-on worker one such call froze a whole lane until the watchdog
// restarted the process. Calls that bring their own signal keep it; the rest get DEFAULT_MS.
const DEFAULT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20_000);

export function installFetchGuard() {
  const g = globalThis as any;
  if (g.__rnFetchGuard || typeof g.fetch !== "function") return;
  const orig = g.fetch.bind(globalThis);
  g.fetch = (input: any, init?: any) => {
    if (init?.signal) return orig(input, init);
    return orig(input, { ...(init || {}), signal: AbortSignal.timeout(DEFAULT_MS) });
  };
  g.__rnFetchGuard = true;
}
