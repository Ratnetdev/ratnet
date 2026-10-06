// Unit check of OVERSEER: explore (stubbed sources), think (stand-in model), Telegram commands.
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
process.env.ANTHROPIC_API_KEY = "sim";
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.TELEGRAM_IDEAS_CHAT_ID = "-100";
const sent: string[] = [];
(globalThis as any).fetch = async (url: string, init?: any) => {
  const u = String(url);
  if (u.includes("telegram")) { sent.push(JSON.parse(init.body).text); return { ok: true, json: async () => ({ ok: true }) }; }
  if (u.includes("anthropic")) return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ ideas: [{ title: "Tighten tweet-coin trail", problem: "wire sleeve avg -12% over 20 trades", proposal: "trail 0.8x for wire", impact: "less giveback", risk: "cut runners", effort: "small", kind: "tune", sources: [] }] }) }] }) };
  if (u.includes("reddit")) return { ok: true, text: async () => JSON.stringify({ data: { children: [{ data: { title: "How I catch runners on pump.fun", permalink: "/r/solana/x", selftext: "volume first" } }] } }) };
  return { ok: false, text: async () => "", json: async () => ({}) };
};
async function main() {
  const o = await import("../src/lib/overseer");
  const t = await import("../src/lib/tgbot");
  await R.set("rn:ov:src", 3); // next source = reddit (index 0)
  console.log("session", JSON.stringify(await o.overseerSession(5000)));
  console.log("think", JSON.stringify(await o.think(true)));
  await t.handleUpdate({ message: { chat: { id: -100 }, from: { id: 1 }, text: "/no 1 too risky now" } });
  await t.handleUpdate({ message: { chat: { id: 555 }, from: { id: 2 }, text: "/yes 1" } }); // not allowed
  await t.handleUpdate({ message: { chat: { id: 555 }, text: "/id" } });
  console.log("ideas", JSON.stringify((await o.ideasList()).map((i) => [i.id, i.status, i.note])));
  console.log("telegram sent:\n" + sent.map((s) => "  " + s.split("\n")[0]).join("\n"));
  console.log("trail", JSON.stringify(((R.kv.get("rn:ov:trail") || []) as any[]).map((x) => x.text).slice(0, 4)));
}
main();
