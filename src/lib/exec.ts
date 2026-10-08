// EXEC, fast path. A trade is only as good as how fast it lands. This path:
//  1. asks Jupiter for the swap INSTRUCTIONS (not a finished tx), the priority fee estimate (Helius) and a cached
//     blockhash all at the same time,
//  2. builds the transaction itself: compute limit from Jupiter's estimate, a priority fee from Helius's live estimate
//     (capped), a small Jito tip, and the swap,
//  3. submits through Helius Sender (sends to validators and Jito at once, no preflight) and the normal RPC in
//     parallel, rebroadcasts every 700ms and checks confirmation every 400ms.
// Any failure building the fast tx falls back to Jupiter's own finished tx on the normal RPC, so a trade is never lost
// to the fast path. Everything is tunable in the desk JSON (fastExec, maxPriorityLamports, jitoTipMinSol/MaxSol).
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { conn } from "./solana";

const JUP = process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
const jupHeaders = (): Record<string, string> => (process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {});
const SENDER = () => process.env.SENDER_URL || "https://sender.helius-rpc.com/fast";
// Jito's public tip accounts (any one; picked at random so tips spread out)
const TIP = (process.env.JITO_TIP_ACCOUNTS || "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5,HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe,Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY,ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49,DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh,ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt,DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL,3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT").split(",").map((x) => x.trim()).filter(Boolean);

// Programs a desk transaction may touch. Anything else in a transaction Jupiter hands back is refused before signing.
const ALLOWED = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111", // System (wSOL wrap, Jito tip)
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
]);

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROG = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** The wallet's associated token account for a mint, under the classic token program and under Token-2022. */
export function ownAtas(owner: PublicKey, mint: string) {
  const m = new PublicKey(mint);
  const ata = (prog: string) => PublicKey.findProgramAddressSync([owner.toBuffer(), new PublicKey(prog).toBuffer(), m.toBuffer()], new PublicKey(ATA_PROG))[0].toBase58();
  return new Set([ata(TOKEN), ata(TOKEN22)]);
}

/**
 * Refuse to sign anything that could send value anywhere but back to the desk wallet (v0.1.33, stricter):
 *  - paid by the desk wallet; every program on the allowlist
 *  - a top-level SOL transfer only to a Jito tip account or the wallet's own wSOL account
 *  - top-level token instructions only to sync, open or close the wallet's own accounts (the rent back to the wallet),
 *    never a transfer, an approval or an authority change
 *  - associated-account creation only for the wallet itself
 *  - the swap's output must land in the wallet's own account for the output mint
 * Every address is resolved through the lookup tables, so nothing hides behind a table index.
 */
export function vetTx(tx: VersionedTransaction, payer: PublicKey, lookups: AddressLookupTableAccount[] = [], outputMint?: string) {
  const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: lookups });
  if (!keys.get(0)?.equals(payer)) throw new Error("tx payer is not the desk wallet");
  // v0.1.46: the desk wallet is the only signer (a second signer could be an account created for someone else)
  if (tx.message.header.numRequiredSignatures !== 1) throw new Error(`tx needs ${tx.message.header.numRequiredSignatures} signers, refused`);
  const me = payer.toBase58();
  const wsolAtas = ownAtas(payer, WSOL_MINT);
  const tips = new Set(TIP);
  const outAtas = outputMint ? ownAtas(payer, outputMint) : null;
  let outSeen = !outAtas || (outputMint === WSOL_MINT); // selling to SOL: the proceeds arrive as lamports on the wallet itself
  for (const ix of tx.message.compiledInstructions) {
    const pid = keys.get(ix.programIdIndex)?.toBase58();
    if (!pid || !ALLOWED.has(pid)) throw new Error(`tx touches an unexpected program ${pid?.slice(0, 6)}`);
    const acc = (i: number) => keys.get(ix.accountKeyIndexes[i])?.toBase58() || "";
    const data = Buffer.from(ix.data);
    if (outAtas && ix.accountKeyIndexes.some((k) => outAtas.has(keys.get(k)?.toBase58() || ""))) outSeen = true;
    if (pid === SYSTEM) {
      const kind = data.length >= 4 ? data.readUInt32LE(0) : -1;
      if (kind === 2) {
        if (acc(0) !== me || !(tips.has(acc(1)) || wsolAtas.has(acc(1)))) throw new Error("SOL transfer to an address that is not a tip or the wallet's own wSOL account");
      } else if (kind === 0 || kind === 3) {
        if (acc(0) !== me) throw new Error("account creation not paid by the desk wallet");
      } else throw new Error(`unexpected system instruction ${kind}`);
    } else if (pid === TOKEN || pid === TOKEN22) {
      const t = data[0];
      if (t === 17) continue; // sync native
      if (t === 1 || t === 16 || t === 18) continue; // initialize account (temporary wSOL accounts)
      if (t === 9) {
        if (acc(1) !== me || acc(2) !== me) throw new Error("token account closed to someone other than the desk wallet");
        continue;
      }
      throw new Error(`top-level token instruction ${t} refused (transfer, approval or authority change)`);
    } else if (pid === ATA_PROG) {
      if (acc(0) !== me || acc(2) !== me) throw new Error("associated account created for someone other than the desk wallet");
    }
  }
  if (!outSeen) throw new Error("the swap's output does not go to the desk wallet's own account");
}

/**
 * v0.1.46: the quote has to be for what we asked (mints, amount) and its minimum output has to match our slippage
 * limit. A quote whose minimum output is far below its expected output (a broken or tampered answer) would let a
 * sandwich take almost everything; it is refused before anything is built or signed.
 */
export function vetQuote(q: any, inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number) {
  if (q.inputMint !== inputMint || q.outputMint !== outputMint) throw new Error("quote refused: wrong mints");
  if (String(q.inAmount) !== String(amountRaw)) throw new Error("quote refused: wrong input amount");
  const out = BigInt(q.outAmount);
  const min = BigInt(q.otherAmountThreshold ?? "0");
  const floor = (out * BigInt(10_000 - slippageBps - 50)) / 10_000n;
  if (out <= 0n || min < floor) throw new Error(`quote refused: minimum output ${min} under the ${slippageBps / 100}% slippage floor`);
}

/**
 * What a confirmed swap really did to the wallet (v0.1.33): lamports in or out (tip, fees and rent included) and the
 * token change for the mint. The books use these instead of Jupiter's quote.
 */
export async function realDelta(sig: string, owner: PublicKey, mint: string) {
  const { parsedTx } = await import("./solana");
  for (let i = 0; i < 4; i++) {
    const tx: any = await parsedTx(sig).catch(() => null);
    if (tx?.meta) {
      const keys = tx.transaction.message.accountKeys;
      const me = owner.toBase58();
      const wi = keys.findIndex((k: any) => k.pubkey.toBase58() === me);
      const sol = wi >= 0 ? ((tx.meta.postBalances[wi] || 0) - (tx.meta.preBalances[wi] || 0)) / 1e9 : null;
      const sum = (arr: any[]) => (arr || []).filter((b) => b.mint === mint && b.owner === me).reduce((a, b) => a + Number(b.uiTokenAmount?.uiAmount || 0), 0);
      const tok = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
      return { sol, tok };
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  return null;
}

const T = (ms: number) => AbortSignal.timeout(ms);

export type ExecCfg = { fastExec?: boolean; maxPriorityLamports?: number; jitoTipMinSol?: number; jitoTipMaxSol?: number };

// ---------------------------------------------------------------- warm caches (refreshed by the desk loop)

let BH: { blockhash: string; lastValidBlockHeight: number; at: number } | null = null;
const ALT = new Map<string, AddressLookupTableAccount>();

/** Keep a fresh blockhash ready, so a trade never waits for one (call every ~2s from the desk loop). */
export async function warm() {
  if (BH && Date.now() - BH.at < 2500) return;
  const b = await conn().getLatestBlockhash("confirmed").catch(() => null);
  if (b) BH = { ...b, at: Date.now() };
}

async function blockhash() {
  if (!BH || Date.now() - BH.at > 20_000) await warm();
  if (!BH) throw new Error("no blockhash");
  return BH;
}

async function alts(keys: string[]) {
  const need = keys.filter((k) => !ALT.has(k));
  if (need.length) {
    const infos = await conn().getMultipleAccountsInfo(need.map((k) => new PublicKey(k)));
    need.forEach((k, i) => {
      const d = infos[i]?.data;
      if (d) ALT.set(k, new AddressLookupTableAccount({ key: new PublicKey(k), state: AddressLookupTableAccount.deserialize(d) }));
    });
  }
  return keys.map((k) => ALT.get(k)).filter((x): x is AddressLookupTableAccount => !!x);
}

async function priorityMicroLamports(accounts: string[]) {
  const url = process.env.HELIUS_RPC_URL;
  if (!url) return 200_000;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getPriorityFeeEstimate", params: [{ accountKeys: accounts.slice(0, 30), options: { priorityLevel: "VeryHigh" } }] }),
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    const j: any = await r.json();
    const v = Number(j?.result?.priorityFeeEstimate);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 200_000;
  } catch {
    return 200_000;
  }
}

const ixOf = (x: any) =>
  new TransactionInstruction({ programId: new PublicKey(x.programId), keys: x.accounts.map((a: any) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(x.data, "base64") });

async function sendBoth(raw: Uint8Array, fast: boolean) {
  const b64 = Buffer.from(raw).toString("base64");
  const jobs: Promise<unknown>[] = [conn().sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => null)];
  if (fast)
    jobs.push(
      fetch(SENDER(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "sendTransaction", params: [b64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }] }), signal: AbortSignal.timeout(3000) }).catch(() => null)
    );
  await Promise.all(jobs);
}

/**
 * Wait for a sent transaction. Rebroadcasts while waiting. If it hasn't confirmed after `ms`, keeps watching (no more
 * rebroadcasts) until its blockhash has expired: only then is it certain it can never land, so the caller may try
 * again without risking a double buy.
 */
async function confirm(sig: string, raw: Uint8Array, fast: boolean, lastValid: number, ms = 25_000) {
  const c = conn();
  const t0 = Date.now();
  let lastSend = Date.now();
  for (;;) {
    const late = Date.now() - t0 >= ms;
    await new Promise((res) => setTimeout(res, 400));
    const st = await c.getSignatureStatuses([sig]).catch(() => null);
    const v = st?.value[0];
    if (v?.err) throw new Error(`tx failed ${sig.slice(0, 8)}`);
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") return Date.now() - t0;
    if (!late && Date.now() - lastSend > 700) {
      lastSend = Date.now();
      await sendBoth(raw, fast);
    }
    if (late) {
      // a failed height read proves nothing (it used to read as height 0, so a swap that may have landed was reported
      // as unknown after 120s); only a real height past the blockhash's last valid height means it can never land
      const h = await c.getBlockHeight("confirmed").catch(() => null);
      if (h != null && h > lastValid) throw new Expired(sig);
      if (Date.now() - t0 > 120_000) throw new Error(`unknown state ${sig.slice(0, 8)}: check Solscan before retrying`);
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
}

/** The transaction provably never landed (its blockhash expired). Safe to retry. */
export class Expired extends Error {
  constructor(sig: string) {
    super(`expired without landing ${sig.slice(0, 8)}`);
  }
}

let inFlight = 0;
/** Swaps sent and not yet settled in this process (the worker's watchdog never restarts in the middle of one). */
export const swapsInFlight = () => inFlight;

/** Swap with the fast path. Returns the signature, Jupiter's quoted output and how long it took. */
export async function fastSwap(kp: Keypair, inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number, cfg: ExecCfg = {}) {
  inFlight++;
  try {
    return await fastSwapInner(kp, inputMint, outputMint, amountRaw, slippageBps, cfg);
  } finally {
    inFlight--;
  }
}

async function fastSwapInner(kp: Keypair, inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number, cfg: ExecCfg = {}) {
  const t0 = Date.now();
  const quoteP = fetch(`${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`, { headers: jupHeaders(), cache: "no-store", signal: T(3000) }).then(async (r) => {
    if (!r.ok) throw new Error(`no route (${r.status})`);
    const q = await r.json();
    if (!q?.outAmount) throw new Error("no route");
    vetQuote(q, inputMint, outputMint, amountRaw, slippageBps);
    return q;
  });
  const [quote, bh] = await Promise.all([quoteP, blockhash()]);
  const fast = cfg.fastExec !== false;
  const body = { quoteResponse: quote, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true };
  let sent = false; // once the fast tx is out, never build a second one (it could still land: double buy)
  try {
    if (!fast) throw new Error("fast path off");
    const res = await fetch(`${JUP}/swap-instructions`, { method: "POST", headers: { "content-type": "application/json", ...jupHeaders() }, body: JSON.stringify(body), cache: "no-store", signal: T(3000) });
    if (!res.ok) throw new Error(`swap-instructions ${res.status}`);
    const si: any = await res.json();
    if (si.error) throw new Error(String(si.error));
    const swapIx = ixOf(si.swapInstruction);
    const [lookup, micro] = await Promise.all([alts(si.addressLookupTableAddresses || []), priorityMicroLamports(swapIx.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58()))]);
    const cu = Math.min(1_400_000, Math.ceil((Number(si.computeUnitLimit) || 300_000) * 1.15));
    // cap the priority fee in total lamports (cu * microLamports / 1e6)
    const maxTotal = cfg.maxPriorityLamports ?? 3_000_000;
    const price = Math.max(10_000, Math.min(micro, Math.floor((maxTotal * 1e6) / cu)));
    const sol = inputMint === "So11111111111111111111111111111111111111112" ? Number(amountRaw) / 1e9 : Number(quote.outAmount) / 1e9;
    const tipSol = Math.max(cfg.jitoTipMinSol ?? 0.0003, Math.min(cfg.jitoTipMaxSol ?? 0.002, sol * 0.004));
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
      ...(si.setupInstructions || []).map(ixOf),
      swapIx,
      ...(si.cleanupInstruction ? [ixOf(si.cleanupInstruction)] : []),
      ...(si.otherInstructions || []).map(ixOf),
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(TIP[Math.floor(Math.random() * TIP.length)]), lamports: Math.round(tipSol * 1e9) }),
    ];
    const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message(lookup);
    const tx = new VersionedTransaction(msg);
    vetTx(tx, kp.publicKey, lookup, outputMint);
    tx.sign([kp]);
    const raw = tx.serialize();
    const sig58 = bs58.encode(tx.signatures[0]);
    sent = true;
    await sendBoth(raw, true);
    const landedMs = await confirm(sig58, raw, true, bh.lastValidBlockHeight);
    return { sig: sig58, outRaw: BigInt(quote.outAmount), ms: Date.now() - t0, landedMs, path: "fast" as const, tipSol, priority: price };
  } catch (e) {
    if (sent) throw e; // the fast tx went out: its fate is known (landed, failed on chain, or expired); no second swap
    // fallback (the fast tx was never sent): Jupiter's finished transaction on the normal RPC
    const s = await fetch(`${JUP}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json", ...jupHeaders() },
      body: JSON.stringify({ ...body, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: cfg.maxPriorityLamports ?? 3_000_000, priorityLevel: "veryHigh" } } }),
      cache: "no-store",
      signal: T(4000),
    });
    if (!s.ok) throw new Error(`swap build failed (${s.status})`);
    const { swapTransaction, lastValidBlockHeight } = await s.json();
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    const lk = await alts((tx.message.addressTableLookups || []).map((x) => x.accountKey.toBase58()));
    vetTx(tx, kp.publicKey, lk, outputMint);
    tx.sign([kp]);
    const raw = tx.serialize();
    const sig58 = bs58.encode(tx.signatures[0]);
    await sendBoth(raw, false);
    const landedMs = await confirm(sig58, raw, false, Number(lastValidBlockHeight) || bh.lastValidBlockHeight + 150);
    return { sig: sig58, outRaw: BigInt(quote.outAmount), ms: Date.now() - t0, landedMs, path: "standard" as const, tipSol: 0, priority: 0, fallbackWhy: String((e as any)?.message || e).slice(0, 80) };
  }
}
