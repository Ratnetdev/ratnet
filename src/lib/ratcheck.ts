// v0.1.133 RAT KING CHECK, the site half. One check of any coin, used by the Sniff page, /api/check, the MCP server
// (/api/mcp) and the Telegram bot: the King's score and report (lib/sniff.ts) plus what the worker sees live (lib/ratlive.ts).
import { redis } from "./redis";
import { sniff, saveSniff, type SniffReport } from "./sniff";
import { SITE } from "@/config/site";

export const CHECK_Q = "rn:check:q";
export const CHECK_R = (m: string) => `rn:check:r:${m}`;
export const CHECK_REP = (m: string) => `rn:check:rep:${m}`;

export type LiveRead = {
  at: number;
  who: { since: number; buys: number; buyers: number; buyersCapped: boolean; sol: number; fomo: number; earners: number; proven: number; bots: number; front: number; crews: number; smart: number } | null;
  copy: number | null;
  devWeek: number | null;
  story: number;
  cls: string | null;
  classOn: boolean | null;
  mcSol: number | null;
  books: number;
  followed: number;
  regime: number | null;
  good: string[];
  bad: string[];
  info: string[];
};
export type CheckReport = SniffReport & { live: LiveRead | null; read: string };

/** Ask the worker for its live read (it answers within a second or two); null when it does not answer in time. */
export async function askWorker(mint: string, waitMs = 5000): Promise<LiveRead | null> {
  const r = redis();
  const t0 = Date.now();
  const have = await r.get<LiveRead>(CHECK_R(mint)).catch(() => null);
  if (have && t0 - have.at < 15_000) return have;
  await r.lpush(CHECK_Q, { m: mint, at: t0 }).catch(() => null);
  await r.ltrim(CHECK_Q, 0, 199).catch(() => null);
  while (Date.now() - t0 < waitMs) {
    await new Promise((res) => setTimeout(res, 350));
    const v = await r.get<LiveRead>(CHECK_R(mint)).catch(() => null);
    if (v && v.at >= t0 - 1000) return v;
  }
  return null;
}

/** The King's read in a few words, from the counts of good and bad signs. */
export function readOf(rep: SniffReport, live: LiveRead | null): string {
  if (rep.verdict === "NO CURVE" && !live?.who) return "Not a coin the rats can read";
  const bad = (live?.bad.length ?? 0) + (rep.minus.length >= 3 ? 1 : 0);
  const good = (live?.good.length ?? 0) + (rep.verdict === "BOND" || rep.verdict === "BONDED" ? 1 : 0);
  if (bad >= 2 && bad > good) return "Careful: more red flags than good signs";
  if (good >= 2 && bad === 0) return "Smart money is in and nothing is wrong yet";
  if (good > bad) return "More good signs than bad";
  if (bad > good) return "More bad signs than good";
  return "Nothing that stands out either way";
}

export async function kingCheck(ca: string, o: { wallet?: string; sig?: string; free: boolean; save?: boolean }): Promise<CheckReport> {
  const [rep, live] = await Promise.all([sniff(ca, o.wallet || "", o.sig || "", o.free), askWorker(ca).catch(() => null)]);
  const out: CheckReport = { ...rep, live, read: readOf(rep, live) };
  if (out.verdict === "NO CURVE" && live?.who) out.note = "Not on a pump.fun curve right now (migrated or another venue): the King's score is off, the live read below still counts.";
  if (o.save !== false) await saveSniff(out).catch(() => null);
  await redis().set(CHECK_REP(ca), out, { ex: 3600 }).catch(() => null);
  return out;
}

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(Math.round(n)));
/** Plain text (MCP, the chat's context, logs). */
export function checkText(r: CheckReport): string {
  const L = r.live;
  const w = L?.who;
  return [
    `RAT KING CHECK · $${r.symbol || "?"} (${r.name || "unknown"}) · ${r.ca}`,
    `Read: ${r.read}`,
    `King score: ${r.score ?? "-"} (${r.verdict})${r.nano ? ` · nano ${r.nano.verdict} ${r.nano.score}` : ""}${r.progress != null ? ` · curve ${r.progress}%` : ""}${r.mcapSol != null ? ` · mcap ${k(r.mcapSol)} SOL` : L?.mcSol ? ` · mcap ${k(L.mcSol)} SOL` : ""}`,
    r.dev ? `Dev: ${r.dev.n} earlier launches, ${r.dev.b} bonded` : "",
    w ? `Who bought since the rats first saw it: ${w.buyersCapped ? "300+" : w.buyers} buyers, ${w.buys} buys, ${w.sol} SOL · FOMO traders ${w.fomo} · earners ${w.earners} · proven wallets ${w.proven} · callout front-runners ${w.front} · bots ${w.bots}` : L ? "Who bought: no buys seen by the rats (older coin or not traded since the worker started)" : "Who bought: the live read did not answer in time",
    ...r.plus.map((x) => `+ ${x}`),
    ...(L?.good || []).map((x) => `+ ${x}`),
    ...r.minus.map((x) => `- ${x}`),
    ...(L?.bad || []).map((x) => `- ${x}`),
    ...(L?.info || []).map((x) => `· ${x}`),
    r.note,
    `${SITE.url}/c/${r.ca}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Telegram HTML. */
export function checkHtml(r: CheckReport): string {
  const L = r.live;
  const w = L?.who;
  const good = [...r.plus, ...(L?.good || [])].slice(0, 6);
  const bad = [...r.minus, ...(L?.bad || [])].slice(0, 6);
  return [
    `🐀 <b>$${esc(r.symbol || "?")}</b> · King ${r.score ?? "-"} <b>${esc(r.verdict)}</b>${r.progress != null ? ` · curve ${r.progress}%` : ""}`,
    `<i>${esc(r.read)}</i>`,
    w ? `\nWho is in: ${w.fomo} FOMO · ${w.earners} earners · ${w.proven} proven · ${w.front} front-runners · ${w.bots} bots (${w.buyersCapped ? "300+" : w.buyers} buyers)` : "",
    good.length ? `\n${good.map((x) => `✅ ${esc(x)}`).join("\n")}` : "",
    bad.length ? `${good.length ? "" : "\n"}${bad.map((x) => `⚠️ ${esc(x)}`).join("\n")}` : "",
    `\n<code>${esc(r.ca)}</code>`,
    `${SITE.url.replace(/^https?:\/\//, "")}/c/${r.ca}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Free checks (API, MCP, Telegram) run while the token is not launched, rate limited per caller. After launch a check
 *  is a sniff order: burn $RAT on the site. Returns null when the check may run, else the reason. */
export async function checkGate(who: string, perHour = 10): Promise<string | null> {
  const { getSettings } = await import("./settings");
  const { limit } = await import("./http");
  const s = await getSettings();
  if (s.mint || !s.freeSniff) return `Checks are sniff orders now: burn $RAT at ${SITE.url}/sniff`;
  if (!(await limit(`check:${who}`, perHour, 3600))) return `Free preview: ${perHour} checks an hour. Try again later.`;
  return null;
}

/** The King's recent BOND calls with what happened since (MCP, Telegram /calls). */
export async function recentCalls(n = 8) {
  const { getCalls } = await import("./stats");
  // v0.1.134: BOND is a few % of calls, so read the last 300 (like /api/king?verdict=BOND); v1's nano verdict counts too
  const cs = (await getCalls(300)).filter((c) => (c.verdict === "BOND" || c.nano?.verdict === "BOND") && c.counted !== false).slice(0, n);
  return cs.map((c) => ({ mint: c.mint, symbol: c.symbol, score: c.score, at: c.at, outcome: c.outcome ?? "LIVE" }));
}
