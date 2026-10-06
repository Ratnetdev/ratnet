import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { BAG_TIERS, CAP_FREE_BAG, EARN_CAP_X, FEE_SPLIT, ROUND_MS } from "@/config/site";
import { K, redis } from "./redis";
import { allRats, isActive, Rat, roundStart } from "./rats";
import { getSettings } from "./settings";
import { ratBalance } from "./burns";
import { conn, pmap, safeErr } from "./solana";

export type Payout = { owner: string; rats: string[]; work: number; mult: number; sol: number; capped: number; sig?: string; error?: string };
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

export function multFor(perRatBag: number) {
  for (const t of BAG_TIERS) if (perRatBag >= t.min) return t.mult;
  return 1;
}

export async function getRounds(): Promise<Round[]> {
  return ((await redis().lrange<Round>(K.rounds, 0, 99)) || []) as Round[];
}

export async function computeRound(id: number, feesSol: number): Promise<Round> {
  const r = redis();
  const existing = (await getRounds()).find((x) => x.id === id);
  if (existing?.status === "paid") throw new Error("Round already paid");
  if (Date.now() < roundStart(id) + ROUND_MS) throw new Error("Round is still running");

  const s = await getSettings();
  const work = (await r.hgetall<Record<string, number>>(K.work(id))) || {};
  const rats = (await allRats()).filter((x) => isActive(x, s) && Number(work[x.name] || 0) >= s.minWork);

  const byOwner: Record<string, Rat[]> = {};
  for (const rat of rats) (byOwner[rat.owner] ||= []).push(rat);
  const owners = Object.keys(byOwner);
  const bags = await pmap(owners, 6, async (o) => {
    try {
      return await ratBalance(o, s);
    } catch {
      return 0;
    }
  });

  const ownersSol = round6(feesSol * FEE_SPLIT.owners);
  const computeSol = round6(feesSol - ownersSol);
  const weights: { rat: Rat; owner: string; w: number; mult: number; perRat: number }[] = [];
  owners.forEach((o, i) => {
    const perRat = bags[i] / byOwner[o].length;
    const mult = multFor(perRat);
    for (const rat of byOwner[o]) weights.push({ rat, owner: o, w: Number(work[rat.name]) * mult, mult, perRat });
  });
  const total = weights.reduce((a, b) => a + b.w, 0);

  const payouts: Record<string, Payout> = {};
  let cappedSol = 0;
  for (const x of weights) {
    let share = total > 0 ? (ownersSol * x.w) / total : 0;
    let capped = 0;
    if (x.perRat < CAP_FREE_BAG && x.rat.costSol) {
      const room = Math.max(0, x.rat.costSol * EARN_CAP_X - x.rat.earnedSol);
      if (share > room) {
        capped = share - room;
        share = room;
      }
    }
    cappedSol += capped;
    const p = (payouts[x.owner] ||= { owner: x.owner, rats: [], work: 0, mult: x.mult, sol: 0, capped: 0 });
    p.rats.push(x.rat.name);
    p.work += Number(work[x.rat.name]);
    p.sol += share;
    p.capped += capped;
  }

  const round: Round = {
    id,
    startsAt: roundStart(id),
    endsAt: roundStart(id) + ROUND_MS,
    feesSol: round6(feesSol),
    computeSol,
    ownersSol,
    cappedSol: round6(cappedSol),
    eligible: rats.length,
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

  const todo = round.payouts.filter((p) => !p.sig && p.sol >= 0.000005);
  for (let i = 0; i < todo.length; i += 8) {
    const chunk = todo.slice(i, i + 8);
    const tx = new Transaction();
    for (const p of chunk) {
      tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(p.owner), lamports: Math.floor(p.sol * LAMPORTS_PER_SOL) }));
    }
    try {
      const sig = await sendAndConfirmTransaction(conn(), tx, [kp], { commitment: "confirmed" });
      chunk.forEach((p) => {
        p.sig = sig;
        delete p.error;
      });
    } catch (e) {
      chunk.forEach((p) => (p.error = safeErr(e)));
      break;
    }
  }

  // Credit rats with what they earned (used for the 2x cap).
  const paidOwners = new Set(round.payouts.filter((p) => p.sig).map((p) => p.owner));
  const rats = await allRats();
  const updates: Record<string, Rat> = {};
  for (const p of round.payouts) {
    if (!paidOwners.has(p.owner) || (p as any).credited) continue;
    const per = p.sol / p.rats.length;
    for (const name of p.rats) {
      const rat = rats.find((r) => r.name === name);
      if (rat) updates[String(rat.id)] = { ...rat, earnedSol: round6((rat.earnedSol || 0) + per) };
    }
    (p as any).credited = true;
  }
  if (Object.keys(updates).length) await redis().hset(K.rats, updates);

  round.status = round.payouts.every((p) => p.sig || p.sol < 0.000005) ? "paid" : "partial";
  await saveRound(round);
  return round;
}
