import { checkBurn, claimBurn } from "@/lib/burns";
import { getSettings } from "@/lib/settings";
import { isPubkey, ratPriceSol } from "@/lib/solana";
import { redis } from "@/lib/redis";
import { allPups, allRats, isActive, Pup, pupName, PUP_SEQ, PUPS_KEY } from "@/lib/rats";
import { fail, ipOf, json, limit, tooMany } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// A pup rides with an adult rat. The owner may pick the rat; otherwise it joins the active rat with the fewest pups.
export async function POST(req: Request) {
  if (!(await limit(`burn:${ipOf(req)}`, 10, 60))) return tooMany();
  try {
    const { wallet, signature, parent } = await req.json();
    if (!isPubkey(wallet) || typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return fail("Missing wallet or signature");
    const s = await getSettings();
    const check = await checkBurn(signature, wallet, "pup", s);
    if (!check.ok) return json({ pending: !!check.pending, error: check.error }, check.pending ? 202 : 400);
    const [rats, pups] = await Promise.all([allRats(), allPups()]);
    const active = rats.filter((r) => isActive(r, s));
    if (!active.length) return fail("No adult rats yet");
    if (pups.length >= s.pupMax) return fail("All pups are taken");
    if (!(await claimBurn(signature, { kind: "pup", wallet, amount: check.amount }))) return fail("This burn was already used");
    const count: Record<string, number> = {};
    for (const p of pups) count[p.parent] = (count[p.parent] || 0) + 1;
    const pick = (typeof parent === "string" && active.find((r) => r.name === parent)) || [...active].sort((a, b) => (count[a.name] || 0) - (count[b.name] || 0) || a.id - b.id)[0];
    const r = redis();
    const id = await r.incr(PUP_SEQ);
    const price = await ratPriceSol(s.mint);
    const pup: Pup = { id, name: pupName(id), owner: wallet, parent: pick.name, sig: signature, spawnedAt: Date.now(), costSol: price ? Math.round(price * check.amount * 1e6) / 1e6 : null, costRat: check.amount, earnedSol: 0 };
    const p = r.pipeline();
    p.hset(PUPS_KEY, { [String(id)]: pup });
    p.lpush("rn:feed", { kind: "dig", rat: pup.name, mint: "", symbol: "", name: "", at: Date.now(), text: `born, riding with ${pick.name}` });
    await p.exec();
    return json({ pup });
  } catch (e) {
    return fail(e);
  }
}
