import { json } from "@/lib/http";
import { K, redis } from "@/lib/redis";
import { conn, safeErr } from "@/lib/solana";

export const dynamic = "force-dynamic";

export async function GET() {
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
  out.blob = !!process.env.BLOB_READ_WRITE_TOKEN;
  out.admin = !!process.env.ADMIN_PASSWORD;
  out.cron = !!process.env.CRON_SECRET;
  out.payouts = !!process.env.PAYOUT_WALLET_SECRET;
  return json(out);
}
