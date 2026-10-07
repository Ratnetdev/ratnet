// The Telegram side of the protocol: OVERSEER posts its ideas to a private chat, and you answer from your phone.
// Uses your existing bot (TELEGRAM_BOT_TOKEN). Set TELEGRAM_IDEAS_CHAT_ID to the private group or channel the bot is in.
//   /yes 12 [note]   approve idea 12        /no 12 why   reject it        /later 12   park it
//   /ideas           open ideas             /think       ask OVERSEER for ideas now
//   /status          protocol in one look   /teach text  teach MIND a lesson
//   /wallet ADDRESS Name [@handle] [proof url]   add a wallet to HOUND's book
//   /id              this chat's id (works anywhere, for setup)
// Replying to an idea message with plain text saves it as your note on that idea.
import { secretFor } from "./admin";
import { SITE } from "@/config/site";

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || "";
export const ideasChat = () => process.env.TELEGRAM_IDEAS_CHAT_ID || null;
/** Telegram sends this back on every update. Empty when CRON_SECRET/TG_HOOK_SECRET is missing: the hook then refuses everything. */
export const hookSecret = () => secretFor("tg-hook");
export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function tgSend(chat: string | number, html: string) {
  if (!TOKEN()) return false;
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: html.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
  }).catch(() => null);
  return !!res?.ok;
}

export async function setupHook() {
  if (!TOKEN()) return { ok: false, error: "no TELEGRAM_BOT_TOKEN" };
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${SITE.url}/api/tg/hook`, secret_token: hookSecret(), allowed_updates: ["message", "channel_post"] }),
  }).catch(() => null);
  return (await res?.json().catch(() => null)) || { ok: false };
}

// Who may command the bot. With TELEGRAM_ADMIN_IDS set, only those users (anywhere), plus posts in the ideas chat
// when it is a channel (only channel admins can post there). Without it, anyone in the ideas chat (set it!).
const allowed = (m: any) => {
  const admins = (process.env.TELEGRAM_ADMIN_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const inIdeas = ideasChat() != null && String(m.chat?.id) === String(ideasChat());
  // v0.1.33: without TELEGRAM_ADMIN_IDS nobody may command the bot (it used to accept anyone in the ideas chat)
  if (!admins.length) return false;
  return (m.from?.id != null && admins.includes(String(m.from.id))) || (inIdeas && m.chat?.type === "channel");
};

export async function handleUpdate(u: any) {
  const m = u?.message || u?.channel_post;
  if (!m?.text) return;
  const chat = m.chat.id;
  const text = String(m.text).trim();
  const [cmd0, ...rest] = text.split(/\s+/);
  const cmd = cmd0.toLowerCase().replace(/@\w+$/, "");
  if (cmd === "/id") return tgSend(chat, `chat id: <code>${chat}</code>${m.from?.id ? `\nyour user id: <code>${m.from.id}</code>` : ""}`);
  if (!allowed(m)) return;
  const { decide, ideasList, ideaText, think } = await import("./overseer");
  if (cmd === "/yes" || cmd === "/no" || cmd === "/later") {
    const id = Number(rest[0]);
    const note = rest.slice(1).join(" ");
    const i = await decide(id, cmd === "/yes" ? "yes" : cmd === "/no" ? "no" : "later", note || undefined);
    return tgSend(chat, i ? `#${id} ${i.status === "yes" ? "approved" : i.status === "no" ? "rejected" : "parked"}${note ? `: ${esc(note)}` : ""}` : `no idea #${esc(rest[0])}`);
  }
  if (cmd === "/ideas") {
    const open = (await ideasList()).filter((i) => i.status === "new" || i.status === "later").slice(0, 8);
    if (!open.length) return tgSend(chat, "No open ideas.");
    for (const i of open) await tgSend(chat, ideaText(i));
    return;
  }
  if (cmd === "/think") {
    await tgSend(chat, "Thinking. Ideas follow in a minute.");
    const r = await think(true);
    if (!r || (r as any).think === 0) return tgSend(chat, "Nothing worth proposing right now.");
    return;
  }
  if (cmd === "/status") {
    const { getDesk } = await import("./desk");
    const { mindRecord } = await import("./mind");
    const d: any = await getDesk();
    const mr = await mindRecord();
    const send = mr.find((x) => x.verdict === "SEND");
    return tgSend(chat, [`<b>RATNET</b> · ${d.live ? "live" : "paper"}`, `equity ${Number(d.state.equity).toFixed(3)} SOL (start ${d.state.start}) · ${d.state.closed} closed, ${d.state.wins} won`, `open: ${d.positions.length} · exam ${d.exam.passed ? "passed" : `${d.exam.checks.filter((c: any) => c.ok).length}/${d.exam.checks.length}`}`, `MIND SEND: ${send?.n ?? 0} calls, 6h avg ${send?.h[2]?.avg ?? "-"}%`, `${SITE.url}/desk`].join("\n"));
  }
  if (cmd === "/teach") {
    const { teach } = await import("./mind");
    const added = await teach(rest.join(" "), "telegram");
    return tgSend(chat, added.length ? `MIND learned:\n${added.map((l) => `- ${esc(l.text)}`).join("\n")}` : "Nothing new to add (or MIND is off).");
  }
  if (cmd === "/wallet") {
    const { addWallet } = await import("./hound");
    const [w, ...more] = rest;
    const handle = more.find((x) => x.startsWith("@"))?.slice(1) || null;
    const url = more.find((x) => /^https?:\/\//.test(x)) || null;
    const name = more.filter((x) => !x.startsWith("@") && !/^https?:\/\//.test(x)).join(" ") || handle || "wallet";
    try {
      const x = await addWallet(w, name, handle, url, "kol");
      return tgSend(chat, `added ${esc(x.name)} · ${x.conf}\n${x.proof.map((p) => `- ${esc(p)}`).join("\n")}`);
    } catch (e: any) {
      return tgSend(chat, `could not add: ${esc(e?.message || e)}`);
    }
  }
  if (cmd === "/help" || cmd === "/start") return tgSend(chat, "/yes N · /no N why · /later N · /ideas · /think · /status · /teach text · /wallet ADDRESS Name @handle proof-url · /id");
  // a plain reply to an idea message: your note on that idea
  const ref = m.reply_to_message?.text ? /#(\d+)/.exec(String(m.reply_to_message.text)) : null;
  if (ref && !text.startsWith("/")) {
    const { decide: d2, ideasList: il } = await import("./overseer");
    const cur = (await il()).find((i) => i.id === Number(ref[1]));
    if (cur) {
      await d2(cur.id, cur.status, text);
      return tgSend(chat, `note saved on #${cur.id}`);
    }
  }
}
