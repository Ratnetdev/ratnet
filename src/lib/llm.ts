// The language model behind MIND. Plain HTTPS to the Anthropic Messages API, no SDK.
// ANTHROPIC_API_KEY turns it on; MIND_MODEL picks the model (default claude-sonnet-5-5).
const URL_ = "https://api.anthropic.com/v1/messages";
export const llmOn = () => !!process.env.ANTHROPIC_API_KEY;
export const llmModel = () => process.env.MIND_MODEL || "claude-sonnet-5-5";

export type Block = { type: "text"; text: string } | { type: "image"; source: { type: "url"; url: string } };

/** One call. Returns the text of the answer, or null on any failure (MIND then just skips that coin). */
export async function ask(system: string, content: Block[], maxTokens = 900, timeoutMs = 40_000): Promise<string | null> {
  if (!llmOn()) return null;
  const go = async (blocks: Block[]) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(URL_, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: llmModel(), max_tokens: maxTokens, system, messages: [{ role: "user", content: blocks }] }),
        signal: ctl.signal,
      });
      const j: any = await r.json().catch(() => null);
      if (!r.ok) return { err: String(j?.error?.message || r.status) };
      return { text: (j?.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("") as string };
    } catch (e: any) {
      return { err: String(e?.message || e) };
    } finally {
      clearTimeout(t);
    }
  };
  let res = await go(content);
  // an image the API cannot fetch (dead IPFS gateway) should not cost the judgement: retry without images
  if (res.err && content.some((b) => b.type === "image")) res = await go(content.filter((b) => b.type !== "image"));
  return res.text ?? null;
}

/** Pull the first JSON object out of an answer. */
export function json<T = any>(text: string | null): T | null {
  if (!text) return null;
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1)) as T;
  } catch {
    return null;
  }
}
