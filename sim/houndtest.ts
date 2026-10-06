// Unit check of HOUND: FOMO profiling and classes, the Helius swap parser, confluence to MIND, copy records.
import { MockRedis } from "./mockredis";
import { Keypair } from "@solana/web3.js";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
(globalThis as any).__rnConn = { getMultipleAccountsInfo: async () => [], getAccountInfo: async () => null };
(globalThis as any).fetch = async (url: string) => {
  const u = String(url);
  if (u.includes("dexscreener")) return { ok: true, json: async () => [{ baseToken: { address: "MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1" }, priceNative: "0.000002", liquidity: { usd: 90000, quote: 300 } }] };
  if (u.includes("bonfida")) return { ok: true, json: async () => ({ result: "kolguy" }) };
  return { ok: false, json: async () => ({}) };
};
async function main() {
  const h = await import("../src/lib/hound");
  const mk = (pnl: number, cost = 100) => ({ realizedPnlUsd: pnl, costBasisUsd: cost, status: "closed" });
  const homerun = [...Array(14).fill(mk(-60)), mk(1500), mk(2400), mk(300), mk(-40), mk(-50), mk(900)];
  const steady = [...Array(14).fill(mk(40)), ...Array(5).fill(mk(-25)), mk(60)];
  const meh = [...Array(10).fill(mk(-30)), ...Array(10).fill(mk(20))];
  for (const [n, t] of [["homerun", homerun], ["steady", steady], ["meh", meh]] as const) {
    const p = h.profileOf(t as any);
    console.log(n, JSON.stringify(p), "->", h.classify(p));
  }
  const W1 = Keypair.generate().publicKey.toBase58();
  const W2 = Keypair.generate().publicKey.toBase58();
  const x = await h.addWallet(W1, "Kol Guy", "kolguy", null);
  console.log("added", x.name, x.conf, x.proof.join(" | "));
  await R.hset("rn:hd:w", { [W2]: { w: W2, cls: "smart", name: "smart Smt1", conf: "confirmed", proof: [], src: [], at: Date.now() } });
  const M = "MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
  const tx = (w: string, sig: string) => ({ signature: sig, timestamp: Date.now() / 1000, feePayer: w, type: "SWAP", nativeTransfers: [{ fromUserAccount: w, toUserAccount: "pool", amount: 2.5e9 }], tokenTransfers: [{ fromUserAccount: "pool", toUserAccount: w, mint: M, tokenAmount: 1000 }] });
  console.log("swaps", JSON.stringify(await h.onSwaps([tx(W1, "s1"), tx(W2, "s2"), tx(Keypair.generate().publicKey.toBase58(), "s3")])));
  console.log("mind queue", JSON.stringify([...((R.kv.get("rn:mind:q") as Map<string, number>) || new Map()).keys()]));
  console.log("buyers", JSON.stringify((await h.buyersOf(M)).map((b: any) => [b.name, b.cls, b.sol])));
  const v = await h.houndView(false);
  console.log("public feed", JSON.stringify(v.feed.map((b: any) => [b.name, b.w ? "addr" : "hidden", b.sol])));
}
main();
