// v0.1.19 checks: HOUND fills its book from FOMO and MadeOnSol, the pool watch reads every migration, CATCH keeps
// a model trained on fewer inputs and learns from old snapshots, the fast 2-hour labels resolve.
import { MockRedis } from "./mockredis";
import { Keypair } from "@solana/web3.js";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
(globalThis as any).__rnConn = { getMultipleAccountsInfo: async () => [], getAccountInfo: async () => null };
process.env.FOMO_API_KEY = "test";
process.env.MADEONSOL_API_KEY = "test";
const addr = () => Keypair.generate().publicKey.toBase58();
const FW = [addr(), addr(), addr()];
const KW = Array.from({ length: 40 }, addr);
const MINTS = Array.from({ length: 35 }, () => addr().slice(0, 40) + "pump");
const mk = (pnl: number, cost = 100) => ({ realizedPnlUsd: pnl, costBasisUsd: cost, status: "closed" });
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(globalThis as any).fetch = async (url: string) => {
  const u = String(url);
  if (u.includes("fomoapi.io/v2/leaderboard")) return { ok: true, json: async () => ({ traders: FW.map((w, i) => ({ rank: i + 1, handle: `t${i}`, userId: `u${i}`, displayName: `T${i}`, pnlUsd: 5000 - i, wallets: { solana: w } })) }) };
  if (u.includes("fomoapi.io/v2/users/u0/positions")) return { ok: true, json: async () => ({ available: true, positions: [...Array(14).fill(mk(40)), ...Array(5).fill(mk(-25)), mk(60)] }) };
  if (u.includes("fomoapi.io/v2/users")) return { ok: true, json: async () => ({ available: false, positions: [] }) };
  if (u.includes("madeonsol.com/api/v1/kol/wallets")) return { ok: true, json: async () => ({ wallets: KW.map((w, i) => ({ wallet_address: w, name: `KOL ${i}`, twitter_url: `https://x.com/kol${i}` })) }) };
  if (u.includes("dexscreener.com/tokens/v1/solana/")) {
    const asked = u.split("/solana/")[1].split(",");
    return { ok: true, json: async () => asked.map((m, i) => ({ baseToken: { address: m, symbol: `S${i}` }, quoteToken: { symbol: "SOL" }, liquidity: { usd: 40000 + i }, marketCap: 120000, volume: { m5: 9000, h1: 50000 }, txns: { m5: { buys: 80, sells: 30 } }, priceChange: { m5: 12, h1: 40, h6: 90 }, dexId: "pumpswap", pairAddress: `P${i}`, pairCreatedAt: Date.now() - 600_000 })) };
  }
  if (u.includes("bonfida")) return { ok: true, json: async () => ({ result: null }) };
  return { ok: false, status: 404, json: async () => ({}) };
};

async function main() {
  // --- HOUND
  const h = await import("../src/lib/hound");
  const res: any = await h.houndRefill();
  const book = await h.book();
  const n = Object.keys(book).length;
  ok(n >= 40, `HOUND book filled: ${n} wallets (fomo ${JSON.stringify(res.status.fomo)}, kol ${JSON.stringify(res.status.kol)})`);
  ok(Object.values(book).some((w) => w.cls === "fomo-steady"), "a FOMO steady hand classified from /positions");
  ok(Object.values(book).filter((w) => w.cls === "fomo-top").length === 2, "the other leaderboard top traders tracked as FOMO top");
  ok(Object.values(book).filter((w) => w.cls === "kol").length === 40, "every MadeOnSol wallet_address joined the book");

  // --- POOL WATCH
  const now = Date.now();
  for (const m of MINTS) await R.zadd("rn:ct:mig", { score: now - 20 * 60_000, member: m });
  const pw = await import("../src/lib/pools");
  const r1: any = await pw.poolWatch(true);
  ok(r1.pools === MINTS.length, `pool watch read ${r1.pools}/${MINTS.length} migrations in 2 batches`);
  const snaps = await pw.poolSnaps(MINTS.slice(0, 2));
  const hot = pw.asHot(MINTS[0], snaps[MINTS[0]]!);
  ok(hot.v5 === 9000 && hot.buyers5 === 80 && hot.mc === 120000, "a pool snapshot reads as MOMO's shape");

  // --- CATCH: an old model (34 inputs) keeps its weights and learns from old snapshots
  const ct = await import("../src/lib/catcher");
  const D = ct.CT_FEATURES.length;
  ok(D === 46, `CATCH has ${D} inputs`);
  const old = { w: Array.from({ length: 34 }, (_, i) => (i === 2 ? 0.5 : 0)), mu: new Array(34).fill(0), m2: new Array(34).fill(50), n: 50, pos: 5, ver: 1 };
  await R.set("rn:ct:w2", old);
  const x34 = new Array(34).fill(0.2);
  x34[0] = 1;
  ok(Number.isFinite(ct.predict(old as any, x34)), "predict works on an old snapshot");
  // historian items with 2-hour labels feed both models
  const items = Array.from({ length: 60 }, (_, i) => ({ f: { pool: 1, mc: 50000 + i * 1000, ageMin: 40, prog: 100, vel: 1, sol: 80, migMin: 30, uniq: 100, organic: 80, buyShare: 0.6, bundle: 0, farm: 0, smart: 1, tracked: 0, king: 50, kingBond: 0, post: 0, wave: 0, narrative: 0, v5: 10000, buyers5: 50, buyRatio: 1.5, ch5: 5, ch1h: 10, confPos: 1, confNeg: 0, devRate: 0, socials: 2, copy: 0, mind: 0, lens: 0 }, y: i % 10 === 0, y2: i % 20 === 0, w: 1 }));
  await ct.learnHistory(items);
  const m6: any = await R.get("rn:ct:w2");
  const m2: any = await R.get("rn:ct:w2h");
  ok(m6.w.length === D && m6.w[2] !== 0 && m6.n === 110, `6h model grown to ${m6.w.length} inputs, kept learning (n ${m6.n})`);
  ok(m2 && m2.n === 60 && m2.w.every((v: number) => Number.isFinite(v)), `2h model learned from history (n ${m2?.n})`);
  const view: any = await ct.catchView();
  ok(view.fast && view.fast.n === 60 && view.fast.hist.n === 60, "the CATCH view shows the fast model");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.19 checks passed");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
