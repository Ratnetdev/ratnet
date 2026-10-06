// Fee tracker test: accrual, a claim that empties the vault, more accrual. Run: npx tsx sim/fees.ts
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { MockRedis } from "./mockredis";
let NOW = Date.UTC(2026, 9, 6, 13, 0, 0);
Date.now = () => NOW;
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
const mint = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP);
const [pv] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP);
const [auth] = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), creator.toBuffer()], AMM);
const ata = getAssociatedTokenAddressSync(new PublicKey("So11111111111111111111111111111111111111112"), auth, true, TOKEN_PROGRAM_ID);
let pumpSol = 1.0, ammSol = 0;
(globalThis as any).__rnConn = {
  async getAccountInfo(k: PublicKey) {
    if (k.equals(curve)) { const d = Buffer.alloc(151); creator.toBuffer().copy(d, 49); return { data: d, lamports: 1 }; }
    return null;
  },
  async getMultipleAccountsInfo(ks: PublicKey[]) {
    return ks.map((k) => {
      if (k.equals(pv)) return { lamports: Math.round(pumpSol * 1e9) + 890_880, data: Buffer.alloc(0) };
      if (k.equals(ata)) { const d = Buffer.alloc(165); d.writeBigUInt64LE(BigInt(Math.round(ammSol * 1e9)), 64); return { lamports: 2e6, data: d }; }
      return null;
    });
  },
};
(globalThis as any).fetch = async () => ({ ok: false, json: async () => ({}) });
async function main() {
  R.kv.set("rn:settings", { mint: mint.toBase58() });
  const { trackFees, getEcon } = await import("../src/lib/fees");
  const step = async (label: string) => { NOW += 31_000; const f = await trackFees(); console.log(label.padEnd(36), "vault", f?.vault, "round so far", f?.soFar); };
  await step("start (1.0 already in vault)");
  pumpSol = 1.6; await step("+0.6 fees on the curve");
  pumpSol = 0; await step("claim empties the vault");
  ammSol = 0.25; await step("+0.25 fees after bond (pumpswap)");
  const last = (await R.get("rn:fees:live")) as any;
  const e = await getEcon();
  console.log("econ:", JSON.stringify({ fees: e.fees, perRatX1: e.perRatX1, tiers: e.tiers.map((t) => [t.label, t.mult, t.byClose]) }));
  const ok = Math.abs(last.soFar - 0.85) < 1e-6;
  console.log(ok ? "PASS: 0.6 + 0.25 = 0.85 counted, the 1.0 from before the round and the claim never double-counted" : "FAIL");
}
main();
