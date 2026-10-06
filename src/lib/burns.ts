import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createBurnCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { conn } from "./solana";
import { K, redis } from "./redis";
import { ROUND_MS, Settings } from "@/config/site";
import { priceFor } from "./rats";

const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export type BurnKind = "spawn" | "sniff" | "pup";
/** Burns per wallet per round: a burn is not a sale, so the bag snapshot adds it back (see lib/bags.ts). */
export const BURNW = (round: number) => `rn:burnw:${round}`;

async function tokenProgramOf(mint: PublicKey) {
  const info = await conn().getAccountInfo(mint);
  if (!info) throw new Error("Token mint not found");
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export async function ratBalance(wallet: string, s: Settings): Promise<number> {
  if (!s.mint) return 0;
  const res = await conn().getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: new PublicKey(s.mint) });
  return res.value.reduce((a, acc: any) => a + Number(acc.account.data.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
}

/** Unsigned burn tx for the wallet to sign and send. */
export async function buildBurnTx(wallet: string, kind: BurnKind, s: Settings, note = "") {
  if (!s.mint) throw new Error("$RAT is not live yet");
  const owner = new PublicKey(wallet);
  const mint = new PublicKey(s.mint);
  const program = await tokenProgramOf(mint);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, program);
  const amount = await priceFor(kind, wallet, s);
  const bal = await ratBalance(wallet, s);
  if (bal < amount) throw new Error(`You hold ${Math.floor(bal).toLocaleString()} $RAT, you need ${amount.toLocaleString()}`);
  const raw = BigInt(amount) * 10n ** BigInt(s.decimals);
  const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }));
  tx.add(createBurnCheckedInstruction(ata, mint, owner, raw, s.decimals, [], program));
  tx.add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(`ratnet:${kind}${note ? ":" + note : ""}`.slice(0, 120)) }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

export type BurnCheck =
  | { ok: true; amount: number; wallet: string; at: number }
  | { ok: false; pending?: boolean; error: string };

/** Verify a confirmed tx burned at least `kind` cost of $RAT from `wallet`. Does not mark it used. */
export async function checkBurn(sig: string, wallet: string, kind: BurnKind, s: Settings): Promise<BurnCheck> {
  if (!s.mint) return { ok: false, error: "$RAT is not live yet" };
  if (await redis().sismember(K.burnsUsed, sig)) return { ok: false, error: "This burn was already used" };
  const tx = await conn().getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) return { ok: false, pending: true, error: "Waiting for confirmation" };
  if (tx.meta?.err) return { ok: false, error: "Transaction failed on chain" };
  if (tx.blockTime && Date.now() / 1000 - tx.blockTime > 60 * 60 * 3) return { ok: false, error: "Burn is older than 3 hours" };

  const ixs: any[] = [...tx.transaction.message.instructions];
  for (const inner of tx.meta?.innerInstructions || []) ixs.push(...inner.instructions);
  let raw = 0n;
  for (const ix of ixs) {
    const t = ix?.parsed?.type;
    if (!t || (t !== "burn" && t !== "burnChecked")) continue;
    if (ix.program !== "spl-token" && ix.program !== "spl-token-2022") continue;
    const info = ix.parsed.info || {};
    if (info.mint !== s.mint) continue;
    const auth = info.authority || info.multisigAuthority;
    if (auth !== wallet) continue;
    raw += BigInt(info.amount ?? info.tokenAmount?.amount ?? 0);
  }
  const price = await priceFor(kind, wallet, s);
  const need = BigInt(price) * 10n ** BigInt(s.decimals);
  if (raw < need) return { ok: false, error: `Burn too small: needs ${price.toLocaleString()} $RAT` };
  return { ok: true, amount: Number(raw / 10n ** BigInt(s.decimals)), wallet, at: (tx.blockTime || 0) * 1000 };
}

/** Atomically claim a burn signature. Returns false if someone else claimed it first. */
export async function claimBurn(sig: string, entry: Record<string, unknown>) {
  const added = await redis().sadd(K.burnsUsed, sig);
  if (!added) return false;
  const p = redis().pipeline();
  p.lpush(K.burns, { sig, ...entry, at: Date.now() });
  p.ltrim(K.burns, 0, 999);
  p.hincrby(K.stat, "burned", Number(entry.amount || 0));
  if (entry.wallet) {
    const k = BURNW(Math.floor(Date.now() / ROUND_MS));
    p.hincrby(k, String(entry.wallet), Number(entry.amount || 0));
    p.expire(k, 3 * 86400);
  }
  await p.exec();
  return true;
}
