// Unit check of the fast execution path with stand-ins for Jupiter, Helius and the RPC.
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
const kp = Keypair.generate();
const sent: { via: string; tx: VersionedTransaction }[] = [];
(globalThis as any).__rnConn = {
  getLatestBlockhash: async () => ({ blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1 }),
  getMultipleAccountsInfo: async () => [],
  sendRawTransaction: async (raw: Uint8Array) => { sent.push({ via: "rpc", tx: VersionedTransaction.deserialize(raw) }); return "x"; },
  getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] }),
};
process.env.HELIUS_RPC_URL = "https://rpc.example/?api-key=k";
const MINT = Keypair.generate().publicKey.toBase58();
let ix: TransactionInstruction = SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
const asJup = (i: any) => ({ programId: i.programId.toBase58(), accounts: i.keys.map((k: any) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(i.data).toString("base64") });
(globalThis as any).fetch = async (url: string, init?: any) => {
  const u = String(url);
  if (u.includes("/quote")) {
    // a real quote echoes what was asked (v0.1.46 checks it)
    const qs = new URL(u).searchParams;
    return { ok: true, json: async () => ({ inputMint: qs.get("inputMint"), outputMint: qs.get("outputMint"), inAmount: qs.get("amount"), outAmount: "123456", otherAmountThreshold: "121000" }) };
  }
  if (u.includes("/swap-instructions")) return { ok: true, json: async () => ({ swapInstruction: asJup(ix), setupInstructions: [], cleanupInstruction: null, addressLookupTableAddresses: [], computeUnitLimit: 120000 }) };
  if (u.includes("rpc.example")) return { ok: true, json: async () => ({ result: { priorityFeeEstimate: 500000 } }) };
  if (u.includes("sender")) { sent.push({ via: "sender", tx: VersionedTransaction.deserialize(Buffer.from(JSON.parse(init.body).params[0], "base64")) }); return { ok: true, json: async () => ({}) }; }
  return { ok: false, json: async () => ({}) };
};
async function main() {
  const { fastSwap, ownAtas } = await import("../src/lib/exec");
  // a route that sends SOL to a stranger is refused before signing (and nothing is sent)
  let refused = "";
  await fastSwap(kp, "So11111111111111111111111111111111111111112", MINT, 200_000_000n, 1500, {}).catch((e) => (refused = String(e.message)));
  console.log(refused && !sent.length ? "PASS a transfer to a stranger is never signed" : `FAIL stranger transfer: ${refused} sent ${sent.length}`);
  // a Jupiter route whose output lands in the wallet's own token account
  const ata = [...ownAtas(kp.publicKey, MINT)][0];
  ix = new TransactionInstruction({ programId: new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"), keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }, { pubkey: new PublicKey(ata), isSigner: false, isWritable: true }], data: Buffer.from([1, 2, 3]) });
  const r = await fastSwap(kp, "So11111111111111111111111111111111111111112", MINT, 200_000_000n, 1500, { maxPriorityLamports: 3_000_000 });
  console.log("path", r.path, "tip", r.tipSol, "priority µlamports/CU", r.priority, "out", String(r.outRaw), "ms", r.ms);
  const tx = sent[0].tx;
  console.log("sent via", [...new Set(sent.map((s) => s.via))].join("+"), "· instructions", tx.message.compiledInstructions.length, "· signed", tx.signatures[0].some((b) => b !== 0));
}
main();
