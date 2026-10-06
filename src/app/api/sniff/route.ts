import { checkBurn, claimBurn } from "@/lib/burns";
import { getSettings } from "@/lib/settings";
import { isPubkey } from "@/lib/solana";
import { sniff, saveSniff } from "@/lib/sniff";
import { K, redis } from "@/lib/redis";
import { fail, ipOf, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    return json({ sniffs: (await redis().lrange(K.sniffs, 0, 29)) || [] });
  } catch (e) {
    return fail(e, 500);
  }
}

export async function POST(req: Request) {
  try {
    const { ca, wallet, signature } = await req.json();
    if (!isPubkey(ca)) return fail("Paste a valid CA");
    const s = await getSettings();
    const free = !s.mint && s.freeSniff;

    if (free) {
      const k = K.sniffRate(ipOf(req));
      const used = await redis().incr(k);
      if (used === 1) await redis().expire(k, 3600);
      if (used > 5) return fail("Free preview: 5 sniffs per hour. Burns open at launch.", 429);
      const rep = await sniff(ca, isPubkey(wallet) ? wallet : "", "", true);
      await saveSniff(rep);
      return json({ report: rep });
    }

    if (!s.mint) return fail("Sniff orders open at launch");
    if (!isPubkey(wallet) || typeof signature !== "string") return fail("Burn first");
    const check = await checkBurn(signature, wallet, "sniff", s);
    if (!check.ok) return json({ pending: !!check.pending, error: check.error }, check.pending ? 202 : 400);
    if (!(await claimBurn(signature, { kind: "sniff", wallet, amount: check.amount, ca }))) return fail("This burn was already used");
    const rep = await sniff(ca, wallet, signature, false);
    await saveSniff(rep);
    return json({ report: rep });
  } catch (e) {
    return fail(e);
  }
}
