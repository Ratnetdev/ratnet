// v0.1.30 checks: version 1 transactions are read (raw request with maxSupportedTransactionVersion 1, shaped like
// web3.js's parsed transaction), and nano is warm-started once more. Run: npx tsx sim/v030test.ts
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
  const { Keypair } = await import("@solana/web3.js");
  const signer = Keypair.generate().publicKey.toBase58();
  const prog = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const raw = {
    slot: 5,
    blockTime: 1791400000,
    version: 1,
    transaction: { signatures: ["sig1"], message: { accountKeys: [{ pubkey: signer, signer: true, writable: true, source: "transaction" }], instructions: [{ programId: prog, accounts: [signer], data: "abc" }] } },
    meta: { err: null, logMessages: ["Program log: Instruction: Buy"], preBalances: [1], postBalances: [1], preTokenBalances: [], postTokenBalances: [], innerInstructions: [{ index: 0, instructions: [{ programId: prog, accounts: [signer], data: "x" }] }] },
  };
  let rawCalls = 0;
  (globalThis as any).fetch = async (_u: string, init: any) => {
    const body = JSON.parse(init.body);
    const list = Array.isArray(body) ? body : [body];
    rawCalls += list.length;
    const ver = list[0]?.params?.[1]?.maxSupportedTransactionVersion;
    return new Response(JSON.stringify(list.map((x: any) => ({ jsonrpc: "2.0", id: x.id, result: ver === 1 ? raw : null }))), { headers: { "content-type": "application/json" } });
  };
  (globalThis as any).__rnConn = {
    getParsedTransaction: async () => {
      throw new Error("failed to get transaction: Transaction version (1) is not supported by the requesting client");
    },
    getParsedTransactions: async () => {
      throw new Error("failed to get transactions: Transaction version (1) is not supported by the requesting client");
    },
  };
  const sol = await import("../src/lib/solana");
  const tx: any = await sol.parsedTx("sig1");
  ok(!!tx && tx.version === 1, "a version 1 transaction is read through the raw request");
  ok(typeof tx?.transaction.message.accountKeys[0].pubkey.toBase58 === "function" && tx.transaction.message.accountKeys[0].pubkey.toBase58() === signer, "account keys come back as PublicKeys (the parsers call toBase58)");
  ok(typeof tx?.transaction.message.instructions[0].programId.toBase58 === "function" && typeof tx?.meta.innerInstructions[0].instructions[0].programId.toBase58 === "function", "program ids of outer and inner instructions too");
  const many = await sol.parsedTxsAny(["a", "b", "c"]);
  ok(many.length === 3 && many.every((x: any) => x?.version === 1), "a batch with version 1 transactions is read in one raw batch");
  ok(rawCalls === 4, `raw calls counted per transaction (${rawCalls})`);
  // a real failure (not a version error) still throws, so the backfill retries it
  (globalThis as any).__rnConn.getParsedTransaction = async () => {
    throw new Error("timeout");
  };
  let threw = false;
  await sol.parsedTx("sig2").catch(() => (threw = true));
  ok(threw, "a timeout is still a failure (retried), not an empty result");

  // nano: warm-started once more in v0.1.30 (the v0.1.28 code ran on the new model for a few minutes) (v0.1.41: once more, after the history-flag fix)
  const { K } = await import("../src/lib/redis");
  const nano = await import("../src/lib/nano");
  const m = nano.emptyModel();
  m.n = 999;
  await R.set(K.nano, m);
  await R.set("rn:nano:v1", { w: [1], n: 5000 });
  for (let i = 0; i < 50; i++) await R.lpush("rn:replay", { x: Array.from({ length: nano.NANO_FEATURES.length }, (_, j) => (j === 0 ? 1 : i % 2)), x1: null, y: i % 5 === 0 ? 1 : 0 });
  const { migrateNano, loadModel } = await import("../src/lib/digger");
  const a: any = await migrateNano();
  const nm = await loadModel();
  const v1: any = await R.get("rn:nano:v1");
  ok(a.nano === "migrated" && ["0.1.30", "0.1.41"].includes(String(nm.warm)) && nm.n === 50, `re-warmed from the lesson buffer (n=${nm.n})`);
  ok(v1?.n === 5000, "the archived v1 model is not overwritten by a v2 one");
  const b: any = await migrateNano();
  ok(b.nano === "v2", "and only once");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.30 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
