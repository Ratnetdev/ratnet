// On-chain call receipts. Every counted Rat King call is written to an hourly list. Once the hour is over, the
// SHA-256 of that list goes on-chain in a memo transaction. The list itself stays public on /receipts, so anyone can
// hash it and compare it with the memo: no call can be added, changed or deleted after the outcome is known.
import { createHash } from "crypto";
import bs58 from "bs58";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { hourKey, redis } from "./redis";
import { conn } from "./solana";

const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const LINES = (h: string) => `rn:rc:l:${h}`; // the calls of one UTC hour, in the order they were made
const SEAL = (h: string) => `rn:rc:s:${h}`;
const IDX = "rn:rc:idx"; // sealed hours, scored by the hour's start
const LOCK = (h: string) => `rn:rc:lock:${h}`;
const KEEP = 35 * 86400;

export type Seal = { hour: string; n: number; sha: string; memo: string; sig: string | null; at: number; wallet: string | null; error?: string };

/** One line per counted call: mint, King verdict and score, nano verdict and score, call time (ms). */
export function callLine(c: { mint: string; verdict: string; score: number; nano: { verdict: string; score: number } | null; at: number }) {
  return `${c.mint},${c.verdict},${c.score},${c.nano?.verdict ?? "-"},${c.nano?.score ?? "-"},${c.at}`;
}

export function noteCall(p: { rpush: Function; expire: Function }, c: Parameters<typeof callLine>[0]) {
  const h = hourKey(c.at);
  p.rpush(LINES(h), callLine(c));
  p.expire(LINES(h), KEEP);
}

export const sha256 = (lines: string[]) => createHash("sha256").update(lines.join("\n")).digest("hex");
const memoOf = (h: string, n: number, sha: string) => `RATNET calls ${h}:00Z n=${n} sha256=${sha}`;

function signer(): Keypair | null {
  // v0.1.46: the desk wallet's key is used only in the worker (Railway). On Vercel only a receipt wallet of its own
  // (RECEIPT_WALLET_SECRET) can sign; the desk key is never loaded there
  const onVercel = !!process.env.VERCEL && process.env.DESK_ON_VERCEL !== "1";
  const sec = process.env.RECEIPT_WALLET_SECRET || (onVercel ? "" : process.env.DESK_WALLET_SECRET);
  if (!sec) return null;
  try {
    return Keypair.fromSecretKey(sec.trim().startsWith("[") ? Uint8Array.from(JSON.parse(sec)) : bs58.decode(sec.trim()));
  } catch {
    return null;
  }
}

async function sendMemo(kp: Keypair, memo: string) {
  const c = conn();
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(
    new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(memo, "utf8") }),
  );
  tx.sign(kp);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await Promise.race([c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed"), new Promise((r) => setTimeout(r, 25_000))]);
  return sig;
}

/** Seal every finished hour of the last 6 that is not sealed yet. Runs from the minute pinger; cheap when done. */
export async function sealDue(now = Date.now()) {
  const kp = signer();
  if (!kp) return { sealed: 0, note: "no wallet" };
  const r = redis();
  const out: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const start = Math.floor(now / 3600_000) * 3600_000 - i * 3600_000;
    if (now < start + 3600_000 + 2 * 60_000) continue; // give late writes two minutes
    const h = hourKey(start);
    if (await r.exists(SEAL(h))) continue;
    if (!(await r.set(LOCK(h), now, { nx: true, ex: 300 }))) continue;
    const lines = ((await r.lrange<string>(LINES(h), 0, -1)) || []).map(String);
    const sha = sha256(lines);
    const memo = memoOf(h, lines.length, sha);
    const seal: Seal = { hour: h, n: lines.length, sha, memo, sig: null, at: now, wallet: kp.publicKey.toBase58() };
    if (lines.length) {
      try {
        seal.sig = await sendMemo(kp, memo);
      } catch (e: any) {
        await r.del(LOCK(h)); // try again next minute
        out.push(`${h}: ${String(e?.message || e).slice(0, 80)}`);
        continue;
      }
    }
    await r.set(SEAL(h), seal, { ex: KEEP });
    await r.zadd(IDX, { score: start, member: h });
    out.push(`${h}: ${lines.length} calls${seal.sig ? ` · ${seal.sig.slice(0, 8)}` : ""}`);
  }
  return { sealed: out.length, out };
}

export async function getSeals(limit = 72) {
  const r = redis();
  const hours = ((await r.zrange<string[]>(IDX, 0, limit - 1, { rev: true })) || []).map(String);
  if (!hours.length) return [];
  const seals = (await r.mget<(Seal | null)[]>(...hours.map(SEAL))) || [];
  return seals.filter((x): x is Seal => !!x);
}

export async function getHour(h: string) {
  const r = redis();
  const [lines, seal] = await Promise.all([r.lrange<string>(LINES(h), 0, -1), r.get<Seal>(SEAL(h))]);
  return { hour: h, lines: (lines || []).map(String), seal: seal || null };
}

/** The seal that covers a call made at `at` (null while the hour is still open). */
export async function sealFor(at: number) {
  return (await redis().get<Seal>(SEAL(hourKey(at)))) || null;
}

/** Read the memo back from the chain, so the check does not have to trust this server. */
export async function memoOnChain(sig: string): Promise<string | null> {
  try {
    const tx = await conn().getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const logs = tx?.meta?.logMessages || [];
    const line = logs.find((l) => l.includes("Memo (len"));
    const m = line ? /Memo \(len \d+\): "(.*)"$/.exec(line) : null;
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
