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
// ---- one format for every number on the site (v0.1.38) ----

/** USD amounts and market caps: $950, $12.4K, $1.25M, $2.10B. */
export function usd(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${Math.round(a)}`;
}
/** Same as usd(); kept for older call sites. */
export const usdK = (n: number | null | undefined) => (n ? usd(n) : "–");
/** A signed number: +1.2, -0.034. */
export const sgn = (n: number, d = 1) => `${n > 0 ? "+" : ""}${n.toFixed(d)}`;
/** SOL with its sign and symbol: +0.034 ◎. */
export const sol = (n: number | null | undefined, d = 3, signed = false) => (n == null || !Number.isFinite(n) ? "–" : `${signed ? sgn(n, d) : n.toFixed(d)} ◎`);
/** A signed percent: +12.5%, -3.0%. */
export const spct = (n: number | null | undefined, d = 1) => (n == null || !Number.isFinite(n) ? "–" : `${sgn(n, d)}%`);
/** A time in UTC, always labelled: 14:03:22 UTC. */
export const utc = (ms: number) => (Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(11, 19)} UTC` : "–");
/** Date and time in UTC, labelled: 10-08 14:03 UTC. */
export const utcStamp = (ms: number) => (Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(5, 16).replace("T", " ")} UTC` : "–");
export const chg = (n: number | null | undefined) => (n == null ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(n >= 100 || n <= -100 ? 0 : 1)}%`);
export type Mkt = { mc: number | null; v5: number; v1: number; v24: number; c5: number | null; c1: number | null; liq: number | null; b1: number; s1: number; dex: string; url: string };

/** Links that came from outside (token metadata, websites, X): only real http(s) URLs, anything else becomes "#". */
export const safeHref = (u?: string | null) => (typeof u === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : "#");
