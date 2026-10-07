import { addFeedback, feedbackSummary, FB_TAGS } from "@/lib/feedback";
import { isAdmin } from "@/lib/admin";
import { isPubkey } from "@/lib/solana";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isAdmin()) return fail("unauthorized", 401);
  return json({ options: FB_TAGS, ...(await feedbackSummary()) });
}

// Admin feedback on one trade, call or skip.
export async function POST(req: Request) {
  if (!isAdmin()) return fail("unauthorized", 401);
  try {
    const b = await req.json();
    if (!isPubkey(String(b.mint || ""))) return fail("bad mint");
    if (b.verdict !== "good" && b.verdict !== "bad") return fail("verdict must be good or bad");
    const tags = (Array.isArray(b.tags) ? b.tags : []).map((t: unknown) => String(t).slice(0, 32)).filter(Boolean).slice(0, 8);
    const fb = await addFeedback({
      mint: b.mint,
      symbol: String(b.symbol || "").slice(0, 16),
      kind: b.kind === "call" || b.kind === "skip" ? b.kind : "trade",
      ref: Number.isFinite(Number(b.ref)) ? Number(b.ref) : null,
      verdict: b.verdict,
      tags,
      note: String(b.note || "").slice(0, 500),
    });
    return json({ ok: true, fb });
  } catch (e) {
    return fail(e);
  }
}
