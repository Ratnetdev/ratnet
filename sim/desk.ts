import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MockRedis } from "./mockredis";

// ---------- fake clock
let NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const realNow = Date.now;
Date.now = () => NOW;

const R = new MockRedis();
(globalThis as any).__rnRedis = R;

// ---------- fake pump.fun
type Coin = { mint: string; curve: string; sig: string; t: number; bondAt: number | null; peak: number; peakAt: number; socials: boolean; desc: boolean; dev: number; creator: string; i: number };
const coins: Coin[] = [];
const bySig = new Map<string, Coin>();
const byCurve = new Map<string, Coin>();
const byMint = new Map<string, Coin>();
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const serialDevs = Array.from({ length: 30 }, () => Keypair.generate().publicKey.toBase58());
let rng = 42;
const rand = () => ((rng = (rng * 1664525 + 1013904223) % 4294967296) / 4294967296);

function spawnCoin() {
  const kp = Keypair.generate().publicKey;
  const mint = kp.toBase58();
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), kp.toBuffer()], PUMP);
  const socials = rand() < 0.35;
  const desc = rand() < 0.4;
  const serial = rand() < 0.3;
  const bondP = 0.004 + (socials ? 0.02 : 0) + (desc ? 0.01 : 0) - (serial ? 0.004 : 0);
  const bonds = rand() < bondP;
  const c: Coin = {
    mint,
    curve: pda.toBase58(),
    sig: bs58.encode(Keypair.generate().secretKey.slice(0, 64)),
    t: NOW,
    bondAt: bonds ? NOW + (3 + rand() * 80) * 60_000 : null,
    peak: bonds ? 100 : Math.pow(rand(), 3) * 60,
    peakAt: NOW + rand() * 40 * 60_000,
    socials,
    desc,
    dev: Math.round(rand() * 30) / 10,
    creator: serial ? serialDevs[Math.floor(rand() * serialDevs.length)] : Keypair.generate().publicKey.toBase58(),
    i: coins.length,
  };
  coins.push(c);
  bySig.set(c.sig, c);
  byCurve.set(c.curve, c);
  byMint.set(c.mint, c);
}

function progressOf(c: Coin) {
  if (NOW < c.t) return 0;
  if (c.bondAt) return NOW >= c.bondAt ? 100 : Math.min(99, (100 * (NOW - c.t)) / (c.bondAt - c.t));
  if (NOW <= c.peakAt) return (c.peak * (NOW - c.t)) / Math.max(1, c.peakAt - c.t);
  return Math.max(0, c.peak * Math.exp(-(NOW - c.peakAt) / (60 * 60_000)));
}

function curveData(c: Coin) {
  const b = Buffer.alloc(151);
  const p = progressOf(c);
  const sold = BigInt(Math.floor(793_100_000 * (p / 100))) * 1_000_000n;
  const rTok = 793_100_000_000_000n - sold;
  const vTok = 1_073_000_000_000_000n - sold;
  const vSol = (30_000_000_000n * 1_073_000_000_000_000n) / vTok;
  b.writeBigUInt64LE(vTok, 8);
  b.writeBigUInt64LE(vSol, 16);
  b.writeBigUInt64LE(rTok, 24);
  b.writeBigUInt64LE(vSol - 30_000_000_000n, 32);
  b.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  b[48] = p >= 100 ? 1 : 0;
  return b;
}

const str = (s: string) => { const x = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(x.length); return Buffer.concat([l, x]); };
let rpc = 0;
(globalThis as any).__rnConn = {
  async getSignaturesForAddress(_: any, o: { until?: string; limit: number }) {
    rpc++;
    const out = [];
    for (let i = coins.length - 1; i >= 0 && out.length < o.limit; i--) {
      if (coins[i].sig === o.until) break;
      if (coins[i].t <= NOW) out.push({ signature: coins[i].sig, err: null });
    }
    return out;
  },
  async getParsedTransaction(sig: string) {
    rpc++;
    const c = bySig.get(sig)!;
    const sym = c.i % 7 === 0 ? "bad ticker!!" : `C${c.i}`;
    const data = Buffer.concat([Buffer.from([214, 144, 76, 236, 95, 1, 2, 3]), str(`Coin ${c.i}`), str(sym), str(`https://meta.test/${c.mint}`), new PublicKey(c.creator).toBuffer(), Buffer.from([0])]);
    return {
      blockTime: Math.floor(c.t / 1000),
      meta: { err: null, logMessages: ["Program log: Instruction: CreateV2"], postTokenBalances: [{ mint: c.mint, owner: c.curve }], innerInstructions: [], postBalances: [5e9, Math.round((c.dev + 0.0016) * 1e9)] },
      transaction: { message: { instructions: [{ programId: PUMP, data: bs58.encode(data) }], accountKeys: [{ pubkey: new PublicKey(c.creator), signer: true }, { pubkey: new PublicKey(c.curve), signer: false }] } },
    };
  },
  async getMultipleAccountsInfo(pks: PublicKey[]) {
    rpc++;
    return pks.map((pk) => { const c = byCurve.get(pk.toBase58()); return c ? { data: curveData(c) } : null; });
  },
  async getSlot() { return 1; },
};
(globalThis as any).fetch = async (url: string) => {
  const mint = String(url).split("/").pop()!;
  const c = byMint.get(mint);
  return { ok: true, json: async () => ({ description: c?.desc ? "a real description of this coin and why it exists in the trenches" : "", twitter: c?.socials ? "https://x.com/c" : "", telegram: "", website: c?.socials ? "https://c.fun" : "", image: "" }) };
};

async function main() {
  const realST = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: any, ms = 0) => { NOW += ms; return realST(fn, 0); };
  const { dig } = await import("../src/lib/digger");
  const { deskSession, getDesk } = await import("../src/lib/desk");
  const HOURS = Number(process.env.HOURS || 6);
  const end = NOW + HOURS * 3600_000;
  let lastLog = NOW;
  const begin = NOW;
  while (NOW < end) {
    const t = NOW;
    for (let i = 0; i < 15; i++) spawnCoin();
    await deskSession(50_000, () => dig());
    if (NOW < t + 60_000) NOW = t + 60_000;
    if (NOW - lastLog >= 2 * 3600_000) {
      lastLog = NOW;
      const d: any = await getDesk();
      console.log(`h=${((NOW - begin) / 3600_000).toFixed(1)} eq=${d.state.equity.toFixed(3)} closed=${d.state.closed} wins=${d.state.wins} open=${d.positions.length} live=${d.live} exam=${d.exam.checks.map((c: any) => (c.ok ? "Y" : "n")).join("")}`);
    }
  }
  const d: any = await getDesk();
  console.log("trades:", d.trades.length, "events:", d.events.length);
  console.log(d.events.slice(0, 14).map((e: any) => `${e.agent}: ${e.text}`).join("\n"));
  const dump: any = {};
  for (const [k, v] of R.kv) dump[k] = v instanceof Map ? { __z: [...v.entries()] } : v;
  require("fs").writeFileSync(process.env.DUMP || "sim/state.json", JSON.stringify(dump));
  console.log("dumped");
}
main();
