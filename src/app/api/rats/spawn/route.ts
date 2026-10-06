import { checkBurn, claimBurn } from "@/lib/burns";
import { getSettings } from "@/lib/settings";
import { isPubkey, ratPriceSol } from "@/lib/solana";
import { K, redis } from "@/lib/redis";
import { Rat, ratName } from "@/lib/rats";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const { wallet, signature } = await req.json();
    if (!isPubkey(wallet) || typeof signature !== "string" || signature.length < 60) return fail("Missing wallet or signature");
    const s = await getSettings();
    const check = await checkBurn(signature, wallet, "spawn", s);
    if (!check.ok) return json({ pending: !!check.pending, error: check.error }, check.pending ? 202 : 400);
    if (!(await claimBurn(signature, { kind: "spawn", wallet, amount: check.amount }))) return fail("This burn was already used");

    const r = redis();
    const id = await r.incr(K.ratSeq);
    const inLitter = await r.incr(K.litterCount(s.litter.n));
    const litter = inLitter <= s.litter.size ? s.litter.n : s.litter.n + 1;
    if (litter !== s.litter.n) await r.incr(K.litterCount(litter));
    const price = await ratPriceSol(s.mint);
    const rat: Rat = {
      id,
      name: ratName(id),
      owner: wallet,
      litter,
      sig: signature,
      spawnedAt: Date.now(),
      costSol: price ? Math.round(price * check.amount * 1e6) / 1e6 : null,
      costRat: check.amount,
      earnedSol: 0,
    };
    const p = r.pipeline();
    p.hset(K.rats, { [String(id)]: rat });
    p.sadd(K.ratsOf(wallet), id);
    p.lpush(K.feed, {
      kind: "dig",
      rat: rat.name,
      mint: "",
      symbol: "",
      name: "",
      at: Date.now(),
      text: litter === s.litter.n ? `spawned in litter ${litter}` : `queued for litter ${litter}`,
    });
    await p.exec();
    return json({ rat, queued: litter !== s.litter.n });
  } catch (e) {
    return fail(e);
  }
}
