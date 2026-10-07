import { checkHook, onSwaps } from "@/lib/hound";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Helius pushes every swap of a tracked wallet here (HOUND keeps the webhook in sync with its book).
export async function POST(req: Request) {
  if (!checkHook(req)) return json({ ok: false }, 401);
  const body = await req.json().catch(() => []);
  const res = await onSwaps(body).catch((e) => ({ error: String(e?.message || e) }));
  return json({ ok: true, ...res });
}
