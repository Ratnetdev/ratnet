import { isPubkey } from "@/lib/solana";
import { checkGate, kingCheck } from "@/lib/ratcheck";
import { memo } from "@/lib/memo";
import { fail, ipOf, json, memLimit, tooMany } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// v0.1.133 RAT KING CHECK: GET /api/check?ca=<mint>. The King's score plus who is buying (FOMO traders, earners, proven
// wallets, bots, callout front-runners), copies, the dev's week and the desk's own record in the coin's class.
export async function GET(req: Request) {
  const ca = (new URL(req.url).searchParams.get("ca") || "").trim();
  if (!isPubkey(ca)) return fail("Pass ?ca=<a Solana token address>");
  if (!memLimit(`check:${ipOf(req)}`, 20, 60)) return tooMany();
  try {
    const no = await checkGate(ipOf(req));
    if (no) return fail(no, 429);
    const rep = await memo(`api:check:${ca}`, 15_000, () => kingCheck(ca, { free: true }));
    return json({ report: rep });
  } catch (e) {
    return fail(e, 500);
  }
}
