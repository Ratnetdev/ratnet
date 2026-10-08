// v0.1.46: Telegram alerts for every trade the desk opens and closes, in three books that never look alike:
//   👻 GHOST  not counted, the desk was blocked (grey, italic header)
//   📄 PAPER  counted in the exam, no real money
//   💰 LIVE   real money, with the Solscan link of the transaction
// The open alert says what was bought, by which strategy and why. The close alert has the whole result: P&L in SOL and
// %, in and out, entry and exit market cap, the peak while held, how long, and why it sold. Partial sells (initials,
// ladder) get a short alert of their own. Every alert links the coin's page and the desk on RATNET.
// Chat: TELEGRAM_TRADES_CHAT_ID, else the private ideas chat. Each book can be switched off in Admin (desk.tgTrades).
import { SITE } from "@/config/site";
import { esc, ideasChat, tgSend } from "./tgbot";

export type Book = "ghost" | "paper" | "live";

const BOOK: Record<Book, { icon: string; label: string; note: string }> = {
  ghost: { icon: "👻", label: "GHOST", note: "not counted · the real desk was blocked" },
  paper: { icon: "📄", label: "PAPER", note: "counted in the exam · no real money" },
  live: { icon: "💰", label: "LIVE", note: "REAL MONEY" },
};

const STRAT: Record<string, string> = { direct: "King", stalk: "King pullback", early: "King early read", wire: "WIRE tweet", mind: "MIND", momo: "MOMO", catch: "CATCH", flash: "FLASH" };
export const stratName = (how?: string | null) => STRAT[how || "direct"] || String(how || "King");

const chat = () => process.env.TELEGRAM_TRADES_CHAT_ID || ideasChat();
const usd = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "?" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
const sol = (n: number) => `${n.toFixed(n >= 1 ? 3 : 4)} SOL`;
const pctS = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const held = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
};
const LINE = "━━━━━━━━━━━━━━━";

function links(mint: string, sig?: string) {
  const parts = [`<a href="${SITE.url}/c/${mint}">Coin on RATNET</a>`, `<a href="${SITE.url}/desk">Desk</a>`];
  if (sig) parts.push(`<a href="https://solscan.io/tx/${sig}">Solscan</a>`);
  return `${parts.join(" · ")}\n<code>${mint}</code>`;
}

/** v0.1.47: why a ghost trade is not a real one, in plain words (it said "the real desk was blocked" for every case,
 *  also when the desk simply follows its rule that nano has to agree). */
export function ghostWhy(blocked?: string) {
  const b = String(blocked || "");
  const nano = /nano agrees\s+(\w+)\s*(\d+)?/i.exec(b);
  if (nano) return { note: "not counted · nano did not back the King's call", line: `nano says ${nano[1]}${nano[2] ? ` ${nano[2]}` : ""}, the desk needs BOND` };
  if (/still learning/i.test(b)) return { note: "not counted · nano is still learning", line: "nano makes calls after 200 live lessons; until then King calls are tracked here" };
  if (/paused by PM/i.test(b)) return { note: "not counted · this strategy is paused after a bad run", line: b };
  if (/daily loss/i.test(b)) return { note: "not counted · the daily loss limit is hit", line: b };
  if (/open slots|slots/i.test(b)) return { note: "not counted · every slot is full", line: b };
  if (/paper balance/i.test(b)) return { note: "not counted · no paper balance free", line: b };
  if (/starting score|earned/i.test(b)) return { note: "not counted · this strategy has not earned real trades yet", line: b };
  return { note: BOOK.ghost.note, line: b };
}

function head(book: Book, action: string, symbol: string, note?: string) {
  const b = BOOK[book];
  const title = `${b.icon} <b>${b.label} · ${action}</b>  $${esc(symbol.slice(0, 20))}`;
  return book === "live" ? `${title}\n<b>${b.note}</b>` : `${title}\n<i>${esc(note || b.note)}</i>`;
}

export type OpenAlert = { book: Book; mint: string; symbol: string; how?: string | null; sol: number; mcUsd: number | null; curve?: number | null; ageMs?: number | null; why: string; king?: number | null; nano?: number | null; blocked?: string; sig?: string };
export type CloseAlert = { book: Book; mint: string; symbol: string; how?: string | null; costSol: number; backSol: number; entryMc: number | null; exitMc: number | null; peakX: number; openedAt: number; reason: string; sig?: string; partial?: { frac: number; sol: number } };

export function openText(a: OpenAlert) {
  const rows = [
    head(a.book, "BUY", a.symbol, a.book === "ghost" ? ghostWhy(a.blocked).note : undefined),
    LINE,
    `<b>Strategy</b>  ${stratName(a.how)}${a.king ? ` · King ${a.king}` : ""}${a.nano != null ? ` · nano ${a.nano}` : ""}`,
    `<b>Size</b>  ${sol(a.sol)}`,
    `<b>Entry</b>  ${usd(a.mcUsd)} mcap${a.curve != null ? ` · curve ${Math.round(a.curve)}%` : " · migrated"}${a.ageMs != null ? ` · coin ${held(a.ageMs)} old` : ""}`,
    `<b>Why</b>  ${esc(a.why.slice(0, 160))}`,
    ...(a.blocked ? [`<b>Not real because</b>  ${esc(ghostWhy(a.blocked).line.slice(0, 160))}`] : []),
    LINE,
    links(a.mint, a.sig),
  ];
  return rows.join("\n");
}

export function closeText(a: CloseAlert) {
  if (a.partial) {
    return [
      head(a.book, `SOLD ${Math.round(a.partial.frac * 100)}%`, a.symbol),
      LINE,
      `<b>Back</b>  ${sol(a.partial.sol)} · rest still held`,
      `<b>Exit</b>  ${esc(a.reason.slice(0, 160))}`,
      LINE,
      links(a.mint, a.sig),
    ].join("\n");
  }
  const pnl = a.backSol - a.costSol;
  const pct = a.costSol > 0 ? (pnl / a.costSol) * 100 : 0;
  const win = pnl >= 0;
  const mcCh = a.entryMc && a.exitMc ? ((a.exitMc / a.entryMc - 1) * 100) : null;
  return [
    head(a.book, win ? "WIN" : "LOSS", a.symbol),
    LINE,
    `${win ? "✅" : "🔻"} <b>${pctS(pct)}</b>  (${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL)`,
    `<b>In → out</b>  ${sol(a.costSol)} → ${sol(a.backSol)}`,
    `<b>Mcap</b>  ${usd(a.entryMc)} → ${usd(a.exitMc)}${mcCh != null ? ` (${pctS(mcCh)})` : ""}`,
    `<b>Peak held</b>  ${pctS((a.peakX - 1) * 100)}${a.entryMc ? ` · ${usd(a.entryMc * a.peakX)}` : ""}`,
    `<b>Held</b>  ${held(Date.now() - a.openedAt)}`,
    `<b>Strategy</b>  ${stratName(a.how)}`,
    `<b>Exit</b>  ${esc(a.reason.slice(0, 160))}`,
    LINE,
    links(a.mint, a.sig),
  ].join("\n");
}

// one message at a time, 1.1s apart (Telegram allows about 20 a minute in a group); at most 60 waiting, oldest first
const Q: string[] = [];
let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (Q.length) {
      const c = chat();
      const text = Q.shift()!;
      if (c) await tgSend(c, text).catch(() => false);
      await new Promise((r) => setTimeout(r, 1100));
    }
  } finally {
    pumping = false;
  }
}
function enabled(book: Book, cfg: any) {
  if (!chat() || !process.env.TELEGRAM_BOT_TOKEN) return false;
  const on = cfg?.tgTrades;
  return on?.[book] !== false;
}
function push(text: string) {
  if (Q.length >= 60) Q.shift();
  Q.push(text);
  pump().catch(() => null);
}

export function alertOpen(a: OpenAlert, cfg?: any) {
  if (enabled(a.book, cfg)) push(openText(a));
}
export function alertClose(a: CloseAlert, cfg?: any) {
  if (enabled(a.book, cfg)) push(closeText(a));
}
/** Wait until the queue is sent (end of a desk session on Vercel, where the process may stop right after). */
export async function alertsFlush(maxMs = 8000) {
  const t0 = Date.now();
  while ((Q.length || pumping) && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 200));
}
