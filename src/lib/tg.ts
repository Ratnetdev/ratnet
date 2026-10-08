// Telegram call channel. Every counted King BOND call is posted the moment it lands, and posted again when it bonds.
// Set TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_CHAT_ID (the channel, e.g. @ratnetcalls) to switch it on.
import { redis } from "./redis";
import { SITE } from "@/config/site";
import { tgCut } from "./tgbot";

const Q = "rn:tg:q";
export const tgOn = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const k$ = (n: number | null | undefined) => (!n ? "–" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);

type CallMsg = { mint: string; symbol: string; name: string; score: number; nano: { score: number; verdict: string } | null; progress: number; mc: number | null; plus: string[]; minus: string[] };

/** Queue on a pipeline (digger) so a call never waits on Telegram. */
export function queueCall(p: { lpush: Function; ltrim: Function }, c: CallMsg) {
  if (!tgOn()) return;
  const lines = [
    `<b>BOND ${c.score}</b> · $${esc(c.symbol)}${c.nano ? ` · nano ${c.nano.verdict} ${c.nano.score}` : ""}`,
    esc(c.name.slice(0, 40)),
    `Minute 5 · curve ${c.progress}% · mc ${k$(c.mc)}`,
    c.plus.length ? `\n+ ${c.plus.map(esc).join("\n+ ")}` : "",
    c.minus.length ? `− ${c.minus.map(esc).join("\n− ")}` : "",
    `\n<code>${c.mint}</code>`,
    `${SITE.url.replace(/^https?:\/\//, "")}/c/${c.mint}`,
  ].filter(Boolean);
  p.lpush(Q, lines.join("\n"));
  p.ltrim(Q, 0, 199);
}

export function queueBonded(p: { lpush: Function; ltrim: Function }, b: { mint: string; symbol: string; score: number; bondSecs: number; leadSecs: number | null }) {
  if (!tgOn()) return;
  const text = [
    `<b>BONDED</b> · $${esc(b.symbol)}`,
    `Called BOND ${b.score} at minute 5. Graduated ${Math.round(b.bondSecs / 60)}m after launch${b.leadSecs ? `, ${Math.round(b.leadSecs / 60)}m after the call` : ""}.`,
    `${SITE.url.replace(/^https?:\/\//, "")}/c/${b.mint}`,
  ].join("\n");
  p.lpush(Q, text);
  p.ltrim(Q, 0, 199);
}

/** Send what is queued, oldest first (a few per minute run; Telegram allows ~20 messages a minute per channel). */
export async function tgFlush(max = 12) {
  if (!tgOn()) return { sent: 0 };
  const r = redis();
  let sent = 0;
  for (let i = 0; i < max; i++) {
    const text = await r.rpop<string>(Q);
    if (!text) break;
    try {
      const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: tgCut(String(text)), parse_mode: "HTML", disable_web_page_preview: true }),
      });
      if (res.status === 429) {
        await r.rpush(Q, text); // back at the front of the line
        break;
      }
      sent++;
    } catch {
      await r.rpush(Q, text);
      break;
    }
    await new Promise((res) => setTimeout(res, 1100));
  }
  return { sent };
}
