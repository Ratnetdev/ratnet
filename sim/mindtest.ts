// Unit check of MIND's post-mortem, school and teach paths with a stand-in model.
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
process.env.ANTHROPIC_API_KEY = "sim";
let calls = 0;
(globalThis as any).fetch = async (url: string, init?: any) => {
  calls++;
  const b = JSON.parse(init.body);
  let out: any = {};
  if (b.system.includes("reviewing your own call")) out = { lesson: "When a coin is tied to a 1M+ account post and buyers keep coming after migration, hold the runner.", helped: ["s0"], hurt: ["s4"] };
  else out = { lessons: [{ text: "Enter in the first two minutes after a big account posts; after ten minutes the copies have taken the flow.", src: "@trader" }, { text: "short" }] };
  return { ok: true, json: async () => ({ content: [{ type: "text", text: "here: " + JSON.stringify(out) }] }) };
};
async function main() {
  const m = await import("../src/lib/mind");
  const mint = "So11111111111111111111111111111111111111112";
  await R.set(`rn:mind:d:${mint}`, { mint, symbol: "TEST", name: "Test", at: Date.now(), why: "bond", verdict: "SEND", conviction: 80, thesis: "t", reasons: ["a"], risks: ["b"], narrative: "n", meme: "m", copy: "original", horizon: "hours", lessons: ["s0", "s4"], mc: 10000, grad: false, model: "x" });
  await m.lessons();
  await R.lpush("rn:mind:pmq", { id: "x", mint, symbol: "TEST", at: Date.now(), verdict: "SEND", conviction: 80, px0: 1, mc0: 1, grad0: false, r: { "15m": 0.1, "1h": 0.5, "6h": 1.2, "24h": 0.9 }, max: 1.2 });
  for (let i = 0; i < 12; i++) m.noteStudy(R as any, "trader", `post number ${i} about how to trade memecoins well with timing and narratives`, Date.now());
  const s = await m.mindSession(20_000);
  const added = await m.teach("A long thread about trading memecoins: enter early on big posts, never chase copies after ten minutes, take initials at 2x.", "@teacher");
  const book = await m.lessonBook();
  console.log("session", JSON.stringify(s), "calls", calls, "teach added", added.length);
  console.log(book.map((l: any) => `${l.id} ${l.wins}-${l.losses} ${l.src}: ${l.text.slice(0, 60)}`).join("\n"));
}
main();
