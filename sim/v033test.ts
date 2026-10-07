// v0.1.33 checks (Run 5, live-safe execution and scam walls). Run: npx tsx sim/v033test.ts
process.env.HELIUS_RPC_URL = "https://rpc.example/?api-key=x";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram } = await import("@solana/web3.js");
  const { createCloseAccountInstruction, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction } = await import("@solana/spl-token");
  const { vetTx, ownAtas, realDelta } = await import("../src/lib/exec");
  const kp = Keypair.generate();
  const me = kp.publicKey;
  const mint = Keypair.generate().publicKey.toBase58();
  const stranger = Keypair.generate().publicKey;
  const ata = new PublicKey([...ownAtas(me, mint)][0]);
  const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  const route = (dest: InstanceType<typeof PublicKey>) => new TransactionInstruction({ programId: JUP, keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }], data: Buffer.from([1]) });
  const build = (ixs: any[]) => new VersionedTransaction(new TransactionMessage({ payerKey: me, recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", instructions: ixs }).compileToV0Message());
  const tries = (ixs: any[]) => {
    try {
      vetTx(build(ixs), me, [], mint);
      return "";
    } catch (e: any) {
      return String(e.message);
    }
  };
  ok(tries([createAssociatedTokenAccountIdempotentInstruction(me, ata, me, new PublicKey(mint)), route(ata)]) === "", "a normal buy (own account created, output to it) is signed");
  ok(/output/.test(tries([route(stranger)])), "a route whose output goes elsewhere is refused");
  ok(/SOL transfer/.test(tries([route(ata), SystemProgram.transfer({ fromPubkey: me, toPubkey: stranger, lamports: 1 })])), "a SOL transfer to a stranger is refused");
  ok(/closed to someone/.test(tries([route(ata), createCloseAccountInstruction(ata, stranger, me)])), "closing an account to a stranger is refused");
  ok(/instruction 3/.test(tries([route(ata), createTransferInstruction(ata, stranger, me, 1)])), "a top-level token transfer is refused");
  ok(/someone other/.test(tries([createAssociatedTokenAccountIdempotentInstruction(me, ata, stranger, new PublicKey(mint)), route(ata)])), "an account created for someone else is refused");

  // books from the confirmed transaction
  const tx = { slot: 1, meta: { err: null, preBalances: [2e9], postBalances: [1.7e9], preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint, owner: me.toBase58(), uiTokenAmount: { uiAmount: 1234 } }] }, transaction: { message: { accountKeys: [{ pubkey: me, signer: true }], instructions: [] } } };
  (globalThis as any).__rnConn = { getParsedTransaction: async () => tx };
  const d = await realDelta("sig", me, mint);
  ok(!!d && Math.abs((d.sol ?? 0) + 0.3) < 1e-9 && d.tok === 1234, `real SOL out and tokens in from the chain (${d?.sol} SOL, ${d?.tok} tokens)`);

  // telegram: without admin ids nobody commands the bot
  delete process.env.TELEGRAM_ADMIN_IDS;
  process.env.TELEGRAM_IDEAS_CHAT_ID = "-100";
  process.env.TELEGRAM_BOT_TOKEN = "t";
  let sends = 0;
  (globalThis as any).fetch = async () => {
    sends++;
    return new Response("{}");
  };
  const { handleUpdate } = await import("../src/lib/tgbot");
  await handleUpdate({ message: { text: "/status", chat: { id: -100, type: "supergroup" }, from: { id: 1 } } });
  ok(sends === 0, "no TELEGRAM_ADMIN_IDS: a command in the ideas chat is ignored");
  await handleUpdate({ message: { text: "/id", chat: { id: -100, type: "supergroup" }, from: { id: 1 } } });
  ok(sends === 1, "/id still answers (setup)");

  // x hook: a key derived from CRON_SECRET no longer opens it
  process.env.CRON_SECRET = "c";
  const { secretFor } = await import("../src/lib/admin");
  const { POST } = await import("../src/app/api/x/hook/route");
  const res = await POST(new Request(`https://x.test/api/x/hook?key=${secretFor("x-hook")}`, { method: "POST", body: "{}" }));
  ok(res.status === 401, "the derived key is refused (a forged post could make WIRE buy)");
  process.env.X_API_KEY = "k1";
  const res2 = await POST(new Request("https://x.test/api/x/hook", { method: "POST", body: "{}", headers: { "x-api-key": "k1" } }));
  ok(res2.status !== 401, "twitterapi.io's X-API-Key header is accepted");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.33 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
