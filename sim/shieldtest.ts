import { MockRedis } from "./mockredis";
import { PublicKey, Keypair } from "@solana/web3.js";
(globalThis as any).__rnRedis = new MockRedis();
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const mk = (mintAuth: boolean, freeze: boolean) => { const d = Buffer.alloc(82); d.writeUInt32LE(mintAuth ? 1 : 0, 0); d.writeUInt32LE(freeze ? 1 : 0, 46); return { owner: TOKEN, data: d }; };
let cur: any = mk(false, false);
(globalThis as any).__rnConn = { getAccountInfo: async () => cur, getTokenLargestAccounts: async () => ({ value: [{ uiAmount: 7e8 }, { uiAmount: 3e7 }, { uiAmount: 2e7 }, { uiAmount: 1e7 }] }) };
(async () => {
  const { shield } = await import("../src/lib/shield");
  const m = Keypair.generate().publicKey.toBase58();
  const base = { mint: m, symbol: "T", grad: false, sol: 0.1, tokensRaw: 0n };
  console.log("clean:", (await shield(base)).ok);
  await (globalThis as any).__rnRedis.del(`rn:shield:mint:${m}`); cur = mk(false, true); console.log("freeze authority:", JSON.stringify((await shield(base)).hardFail));
  cur = mk(true, false); console.log("mint authority:", (await shield(base)).hardFail?.rule);
  cur = mk(false, false); console.log("honeypot tape:", (await shield({ ...base, buys5: 40, sells5: 0 })).hardFail?.rule);
  console.log("farm tape:", (await shield({ ...base, tape: { farm: { farm: true, why: "curve 80% in block 0-2" } } })).softFail?.v);
  console.log("hand-made pool (no pump.fun migration pool):", (await shield({ ...base, grad: true })).hardFail?.rule);
  console.log("wash volume ($533K in 5m on $52K):", (await shield({ ...base, v5: 533000, mcUsd: 52000 })).softFail?.rule);
})();
