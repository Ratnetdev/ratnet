import { isAdmin } from "@/lib/admin";
import { cached, json } from "@/lib/http";
import { K, redis } from "@/lib/redis";
import { conn, safeErr } from "@/lib/solana";

export const dynamic = "force-dynamic";

// Public: one ok/fail line, CDN-cached 15s (a monitor can poll it freely). Admin (?full=1): the details.
export async function GET(req: Request) {
  const out: Record<string, unknown> = {};
  try {
    out.redis = (await redis().ping()) === "PONG";
    out.cursor = !!(await redis().get(K.cursor));
  } catch (e) {
    out.redis = safeErr(e);
  }
  try {
    out.rpcSlot = await conn().getSlot();
  } catch (e) {
    out.rpc = safeErr(e);
  }
  const ok = out.redis === true && typeof out.rpcSlot === "number";
  if (!(new URL(req.url).searchParams.get("full") === "1" && isAdmin())) return cached({ ok }, 15);
  out.ok = ok;
  out.blob = !!process.env.BLOB_READ_WRITE_TOKEN;
  out.admin = !!process.env.ADMIN_PASSWORD;
  out.cron = !!process.env.CRON_SECRET;
  out.payouts = !!process.env.PAYOUT_WALLET_SECRET;
  return json(out);
}
