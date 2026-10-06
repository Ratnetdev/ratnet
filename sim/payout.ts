// Payout test for the earning rules: bag snapshot (lowest held, burns added back), linear multipliers, repeat price,
// pups at x0.25 with 20% royalty, 2x cap under 100K per rat. Run: npx tsx sim/payout.ts
import { Keypair } from "@solana/web3.js";
import { MockRedis } from "./mockredis";
const ROUND = 41465;
let NOW = (ROUND + 1) * 12 * 3600_000 + 60_000; // just after the round closed
Date.now = () => NOW;
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
const w = () => Keypair.generate().publicKey.toBase58();
const A = w(), B = w(), C = w(), D = w();
const bal: Record<string, number> = { [A]: 1_000_000, [B]: 3_000_000, [C]: 0, [D]: 0 };
(globalThis as any).__rnConn = {
  async getParsedTokenAccountsByOwner(o: any) { return { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: bal[o.toBase58()] } } } } } }] }; },
};
const ok = (c: boolean, m: string) => console.log(c ? "PASS" : "FAIL", m);
async function main() {
  const mint = w();
  R.kv.set("rn:settings", { mint, litter: { n: 1, size: 100, open: true } });
  const { sampleBags } = await import("../src/lib/bags");
  const { computeRound, multFor } = await import("../src/lib/rounds");
  const { priceFor } = await import("../src/lib/rats");
  const { getSettings } = await import("../src/lib/settings");
  const s = await getSettings();
  // repeat price
  ok((await priceFor("spawn", A, s)) === 100_000, "first rat costs 100,000");
  await R.sadd(`rn:ratsof:${A}`, "1");
  ok((await priceFor("spawn", A, s)) === 70_000, "next rat from the same wallet costs 70,000 (30% off)");
  ok((await priceFor("pup", A, s)) === 25_000, "a pup costs 25,000");
  // linear multipliers
  ok(multFor(100_000) === 1 && multFor(300_000) === 1.13 && multFor(2_500_000) === 2 && multFor(9e9) === 2, `linear multipliers: 300K -> ${multFor(300_000)}`);
  // rats and pups
  const rat = (id: number, owner: string, costSol: number) => ({ id, name: `RAT-00${id}`, owner, litter: 1, sig: "x", spawnedAt: 0, costSol, earnedSol: 0 });
  R.kv.set("rn:rats", { 1: rat(1, A, 1), 2: rat(2, A, 1), 3: rat(3, B, 0.3), 4: rat(4, D, 0.01) });
  R.kv.set("rn:pups", { 1: { id: 1, name: "PUP-001", owner: C, parent: "RAT-001", sig: "y", spawnedAt: 0, costSol: 0.5, costRat: 25000, earnedSol: 0 }, 2: { id: 2, name: "PUP-002", owner: C, parent: "RAT-002", sig: "z", spawnedAt: 0, costSol: 0.5, costRat: 25000, earnedSol: 0 } });
  R.kv.set(`rn:work:${ROUND}`, { "RAT-001": 100, "RAT-002": 100, "RAT-003": 100, "RAT-004": 100 });
  // during the round: B held only 50K (bought 2.95M right before the close); D held 100K, then burned it for a sniff
  await sampleBags(ROUND, { [A]: 1_000_000, [B]: 50_000, [C]: 0, [D]: 100_000 });
  R.kv.set(`rn:burnw:${ROUND}`, { [D]: 100_000 });
  await sampleBags(ROUND, { [A]: 1_000_000, [B]: 3_000_000, [C]: 0, [D]: 0 });
  const round = await computeRound(ROUND, 10); // 10 SOL fees -> 4 SOL to owners
  const by = Object.fromEntries(round.payouts.map((p) => [p.owner, p]));
  const pa = by[A], pb = by[B], pc = by[C], pd = by[D];
  console.log("payouts:", round.payouts.map((p) => `${p.owner === A ? "A" : p.owner === B ? "B" : p.owner === C ? "C" : "D"} ${p.sol} (x${p.mult}${p.royalty ? `, royalty ${p.royalty.toFixed(4)}` : ""}${p.capped ? `, capped ${p.capped}` : ""})`).join(" · "), "| capped total", round.cappedSol);
  ok(pa.mult === 1.25, "A: 1M over 2 rats = 500K each -> x1.25");
  ok(pb.mult === 1, "B: bought right before the close, the lowest bag (50K) counts -> x1");
  ok(pd.mult === 1, "D: burned 100K for a sniff, the burn is added back -> bag 100K -> x1 (not 0)");
  ok(Math.abs(pb.sol - 0.6) < 1e-6 && pb.capped > 0, `B: under 100K per rat, capped at 2x its 0.3 SOL cost -> ${pb.sol} (${pb.capped} capped)`);
  ok(!!pa.royalty && Math.abs(pa.royalty - (pc.sol / 0.8) * 0.2) < 1e-5, "A gets 20% of the pups riding its rats");
  const total = round.payouts.reduce((a, p) => a + p.sol, 0) + round.cappedSol;
  // capped SOL stays in the treasury (it is not redistributed), so C is checked against the uncapped weights
  ok(Math.abs(total - 4) < 1e-4, `owners pool fully accounted: ${total.toFixed(6)} of 4`);
  const wA = 100 * 1.25 * 2, wB = 100, wD = 100, wC = 2 * 100 * 1 * 0.25;
  const expC = (4 * wC) / (wA + wB + wD + wC) * 0.8;
  ok(Math.abs(pc.sol - expC) < 1e-5, `C (two pups, no bag): ${pc.sol} = expected ${expC.toFixed(6)}`);
}
main();
