export const short = (s: string, a = 4, b = 4) => (s && s.length > a + b + 2 ? `${s.slice(0, a)}…${s.slice(-b)}` : s || "");
export const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
export const num = (n: number | null | undefined) => (n == null ? "–" : n.toLocaleString("en-US"));
export function ago(ms: number) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
export const pct = (v: number | null | undefined) => (v == null ? "–" : `${v}%`);
export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
export const solscanAcc = (a: string) => `https://solscan.io/account/${a}`;
export const pumpCoin = (m: string) => `https://pump.fun/coin/${m}`;
export function countdown(to: number) {
  const s = Math.max(0, Math.floor((to - Date.now()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
