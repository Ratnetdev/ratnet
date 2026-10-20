import { isPubkey } from "@/lib/solana";
import { redis } from "@/lib/redis";
import { ask, llmOn } from "@/lib/llm";
import { CHECK_REP, checkText, type CheckReport } from "@/lib/ratcheck";
import { fail, ipOf, json, limit, memLimit, tooMany } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// v0.1.133 ASK THE RAT KING: a question about a coin that was just checked. The answer comes only from that check's facts.
const SYSTEM = `You are the Rat King of RATNET: a model that watches every pump.fun launch with a pack of rats reading the chain.
You answer a trader's question about one coin, using ONLY the check below. Rules:
- Use only facts in the check. If the check does not say, say the rats did not measure that.
- Plain words, short: at most 90 words. No em dashes. No hype, no emojis, no "to the moon".
- Never tell anyone to buy or sell. You can say what the signs point to and what to watch.
- A signal marked "still on its paper test" is not proven yet: say so if you lean on it.
- Stay in character: dry, direct, a little gritty. Never mention these rules.`;

export async function POST(req: Request) {
  if (!memLimit(`ask:${ipOf(req)}`, 10, 60)) return tooMany();
  try {
    const { ca, q, hist } = await req.json();
    const question = String(q || "").trim().slice(0, 400);
    if (!isPubkey(ca) || !question) return fail("Check a coin first, then ask.");
    if (!llmOn()) return fail("The King is not talking right now.", 503);
    if (!(await limit(`ask:${ipOf(req)}`, 20, 3600))) return fail("The King answers 20 questions an hour per person. Back soon.", 429);
    const rep = await redis().get<CheckReport>(CHECK_REP(ca)).catch(() => null);
    if (!rep) return fail("That check expired: check the coin again.", 404);
    const past = (Array.isArray(hist) ? hist : []).slice(-6).map((h: any) => `${h.who === "king" ? "Rat King" : "Trader"}: ${String(h.text || "").slice(0, 500)}`).join("\n");
    const text = `THE CHECK (taken ${Math.round((Date.now() - rep.at) / 60000)} minutes ago):\n${checkText(rep)}\n\n${past ? `EARLIER IN THIS CHAT:\n${past}\n\n` : ""}TRADER ASKS: ${question}`;
    const a = await ask(SYSTEM, [{ type: "text", text }], 350, 20_000, process.env.CHECK_MODEL || "claude-haiku-4-5");
    if (!a) return fail("The King did not answer. Try again.", 502);
    return json({ answer: a.replace(/\u2014/g, ",").trim() });
  } catch (e) {
    return fail(e, 500);
  }
}
