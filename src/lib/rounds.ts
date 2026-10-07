import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { acquire, release } from "./lock";
import bs58 from "bs58";
import { BAG_TIERS, CAP_FREE_BAG, EARN_CAP_X, FEE_SPLIT, PUP_ROYALTY, PUP_WEIGHT, ROUND_MS } from "@/config/site";
import { K, redis } from "./redis";
import { allPups, allRats, isActive, Pup, PUPS_KEY, Rat, roundStart } from "./rats";
import { bagFor } from "./bags";
import { getSettings } from "./settings";
import { ratBalance } from "./burns";
import { conn, pmap, safeErr } from "./solana";

export type Payout = { owner: string; rats: string[]; work: number; mult: number; sol: number; capped: number; sig?: string; error?: string; units?: Record<string, number>; royalty?: number };
export type Round = {
  id: number;
  startsAt: number;
  endsAt: number;
  feesSol: number;
  computeSol: number;
  ownersSol: number;
  cappedSol: number;
  eligible: number;
  payouts: Payout[];
  status: "computed" | "paid" | "partial";
  closedAt: number;
};

/** Bag multiplier per rat, linear between the tiers so there is no cliff to game (100K ×1 ... 2.5M ×2). */
export function multFor(perRatBag: number) {
  const t = [...BAG_TIERS].sort((a, b) => a.min - b.min);
  if (perRatBag <= t[0].min) return t[0].mult;
  for (let i = 1; i < t.length; i++) {
    if (perRatBag <= t[i].min) {
      const f = (perRatBag - t[i - 1].min) / (t[i].min - t[i - 1].min);
      return Math.round((t[i - 1].mult + f * (t[i].mult - t[i - 1].mult)) * 100) / 100;
    }
  }
  return t[t.length - 1].mult;
}

export async function getRounds(): Promise<Round[]> {
  return ((await redis().lrange<Round>(K.rounds, 0, 99)) || []) as Round[];
}

export async function computeRound(id: number, feesSol: number): Promise<Round> {
  const r = redis();
  const existing = (await getRounds()).find((x) => x.id === id);
  if (existing?.status === "paid") throw new Error("Round already paid");
  // a partly paid round is frozen: recomputing would rebuild payouts without their signatures and pay owners twice
  if (existing?.payouts.some((p: any) => p.sig || p.pending)) throw new Error("Round is partly paid: finish it with Pay, don't recompute");
  if (Date.now() < roundStart(id) + ROUND_MS) throw new Error("Round is still running");

  const s = await getSettings();
  const work = (await r.hgetall<Record<string, number>>(K.work(id))) || {};
  const rats = (await allRats()).filter((x) => isActive(x, s) && Number(work[x.name] || 0) >= s.minWork);
  const ratBy = Object.fromEntries(rats.map((x) => [x.name, x]));
  // pups count only in rounds where the rat they ride with did its digs
  const pups = (await allPups()).filter((x) => ratBy[x.parent]);

  const byOwner: Record<string, Rat[]> = {};
  const pupsOf: Record<string, Pup[]> = {};
  for (const rat of rats) (byOwner[rat.owner] ||= []).push(rat);
  for (const pup of pups) (pupsOf[pup.owner] ||= []).push(pup);
  const owners = Array.from(new Set([...Object.keys(byOwner), ...Object.keys(pupsOf)]));
  // the bag that counts: the lowest held during the round, burns added back (lib/bags.ts)
  const bags = await pmap(owners, 6, async (o) => {
    try {
      return await bagFor(id, o, await ratBalance(o, s));
    } catch {
      return 0;
    }
  });

  const ownersSol = round6(feesSol * FEE_SPLIT.owners);
  const computeSol = round6(feesSol - ownersSol);
  type W = { unit: Rat | Pup; owner: string; w: number; mult: number; perRat: number; parentOwner?: string };
  const weights: W[] = [];
  owners.forEach((o, i) => {
    const units = (byOwner[o]?.length || 0) + (pupsOf[o]?.length || 0); // the bag is split over rats and pups, one each
    const perRat = units ? bags[i] / units : 0;
    const mult = multFor(perRat);
    for (const rat of byOwner[o] || []) weights.push({ unit: rat, owner: o, w: Number(work[rat.name]) * mult, mult, perRat });
    for (const pup of pupsOf[o] || []) weights.push({ unit: pup, owner: o, w: Number(work[pup.parent]) * mult * PUP_WEIGHT, mult, perRat, parentOwner: ratBy[pup.parent].owner });
  });
  const total = weights.reduce((a, b) => a + b.w, 0);

  const payouts: Record<string, Payout> = {};
  let cappedSol = 0;
  const payTo = (owner: string, mult: number) => (payouts[owner] ||= { owner, rats: [], work: 0, mult, sol: 0, capped: 0, units: {}, royalty: 0 });
  for (const x of weights) {
    let share = total > 0 ? (ownersSol * x.w) / total : 0;
    let capped = 0;
    if (x.perRat < CAP_FREE_BAG && x.unit.costSol) {
      const room = Math.max(0, x.unit.costSol * EARN_CAP_X - x.unit.earnedSol);
      if (share > room) {
        capped = share - room;
        share = room;
      }
    }
    cappedSol += capped;
    const isPup = "parent" in x.unit;
    // a pup's share: 80% to its owner, 20% to the owner of the rat it rides with
    const royalty = isPup ? share * PUP_ROYALTY : 0;
    const p = payTo(x.owner, x.mult);
    p.rats.push(x.unit.name);
    p.work += isPup ? 0 : Number(work[x.unit.name]);
    p.sol += share - royalty;
    p.capped += capped;
    p.units![x.unit.name] = round6(share - royalty);
    if (royalty > 0 && x.parentOwner) {
      const q = payTo(x.parentOwner, 1);
      q.sol += royalty;
      q.royalty = (q.royalty || 0) + royalty;
    }
  }

  const round: Round = {
    id,
    startsAt: roundStart(id),
    endsAt: roundStart(id) + ROUND_MS,
    feesSol: round6(feesSol),
    computeSol,
    ownersSol,
    cappedSol: round6(cappedSol),
    eligible: rats.length + pups.length,
    payouts: Object.values(payouts)
      .map((p) => ({ ...p, sol: round6(p.sol), capped: round6(p.capped) }))
      .sort((a, b) => b.sol - a.sol),
    status: "computed",
    closedAt: Date.now(),
  };
  await saveRound(round);
  return round;
}

async function saveRound(round: Round) {
  const rounds = (await getRounds()).filter((x) => x.id !== round.id);
  rounds.unshift(round);
  rounds.sort((a, b) => b.id - a.id);
  const p = redis().pipeline();
  p.del(K.rounds);
  p.rpush(K.rounds, ...rounds.slice(0, 100));
  await p.exec();
}

function round6(n: number) {
  return Math.floor(n * 1e6) / 1e6;
}

/** Sends SOL from PAYOUT_WALLET_SECRET to every unpaid owner in the round. */
export async function payRound(id: number): Promise<Round> {
  const secret = process.env.PAYOUT_WALLET_SECRET;
  if (!secret) throw new Error("PAYOUT_WALLET_SECRET is not set in Vercel");
  const round = (await getRounds()).find((x) => x.id === id);
  if (!round) throw new Error("Round not computed yet");
  let kp: Keypair;
  try {
    kp = Keypair.fromSecretKey(secret.trim().startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret.trim()));
  } catch {
    throw new Error("PAYOUT_WALLET_SECRET is not a valid secret key");
  }

  // one payer per round at a time (double clicks, two tabs, a retry while the first call still runs)
  const lock = await acquire(`rn:lock:pay:${id}`, 10 * 60_000);
  if (!lock) throw new Error("This round is already being paid. Wait a minute and refresh.");
  try {
    const c = conn();
    // 1) settle anything sent before but not confirmed: it may have landed after a timeout. Resend only when its
    //    blockhash has expired and the chain has no trace of it.
    const height = await c.getBlockHeight("confirmed");
    const pend = round.payouts.filter((p: any) => !p.sig && p.pending);
    if (pend.length) {
      const sigs = Array.from(new Set(pend.map((p: any) => p.pending.sig as string)));
      const st = await c.getSignatureStatuses(sigs, { searchTransactionHistory: true });
      sigs.forEach((sig, i) => {
        const v = st.value[i];
        for (const p of pend.filter((x: any) => x.pending.sig === sig) as any[]) {
          if (v && !v.err && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) {
            p.sig = sig;
            delete p.pending;
            delete p.error;
          } else if (v?.err || (!v && height > p.pending.lastValid)) {
            delete p.pending; // failed or provably never landed: safe to send again
          }
        }
      });
      await saveRound(round);
    }
    // 2) pay whoever is still unpaid and not in flight. The signature is saved *before* sending.
    const todo = round.payouts.filter((p: any) => !p.sig && !p.pending && p.sol >= 0.000005);
    for (let i = 0; i < todo.length; i += 8) {
      const chunk = todo.slice(i, i + 8) as any[];
      const tx = new Transaction();
      for (const p of chunk) tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(p.owner), lamports: Math.floor(p.sol * LAMPORTS_PER_SOL) }));
      const bh = await c.getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
      tx.feePayer = kp.publicKey;
      tx.sign(kp);
      const sig = bs58.encode(tx.signature!);
      chunk.forEach((p) => (p.pending = { sig, lastValid: bh.lastValidBlockHeight }));
      await saveRound(round);
      try {
        await c.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
        await c.confirmTransaction({ signature: sig, ...bh }, "confirmed");
        chunk.forEach((p) => {
          p.sig = sig;
          delete p.pending;
          delete p.error;
        });
      } catch (e) {
        // keep `pending`: the next Pay checks the chain before deciding to resend
        chunk.forEach((p) => (p.error = safeErr(e)));
        break;
      } finally {
        await saveRound(round);
      }
    }
  } finally {
    await release(lock);
  }

  // Credit every rat and pup with exactly what it earned (used for the 2x cap).
  const paidOwners = new Set(round.payouts.filter((p) => p.sig).map((p) => p.owner));
  const [rats, pups] = await Promise.all([allRats(), allPups()]);
  const updates: Record<string, Rat> = {};
  const pupUpd: Record<string, Pup> = {};
  for (const p of round.payouts) {
    if (!paidOwners.has(p.owner) || (p as any).credited) continue;
    const fallback = p.rats.length ? (p.sol - (p.royalty || 0)) / p.rats.length : 0;
    for (const name of p.rats) {
      const got = p.units?.[name] ?? fallback;
      const rat = rats.find((x) => x.name === name);
      if (rat) updates[String(rat.id)] = { ...(updates[String(rat.id)] || rat), earnedSol: round6((rat.earnedSol || 0) + got) };
      const pup = pups.find((x) => x.name === name);
      if (pup) pupUpd[String(pup.id)] = { ...pup, earnedSol: round6((pup.earnedSol || 0) + got) };
    }
    (p as any).credited = true;
  }
  if (Object.keys(updates).length) await redis().hset(K.rats, updates);
  if (Object.keys(pupUpd).length) await redis().hset(PUPS_KEY, pupUpd);

  round.status = round.payouts.every((p) => p.sig || p.sol < 0.000005) ? "paid" : "partial";
  await saveRound(round);
  return round;
}
