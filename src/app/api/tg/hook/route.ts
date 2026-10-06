import { handleUpdate, hookSecret } from "@/lib/tgbot";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Telegram updates for the ideas chat (set up once with /api/tg/setup?key=CRON_SECRET).
export async function POST(req: Request) {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== hookSecret()) return json({ ok: false }, 401);
  const u = await req.json().catch(() => null);
  await handleUpdate(u).catch(() => null);
  return json({ ok: true });
}
