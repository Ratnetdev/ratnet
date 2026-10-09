process.env.RATNET_SIM = "1";
// Desk simulator v0.1.4: the real engine + desk against a synthetic pump.fun with structure the agents can learn:
// trades on every curve, bundles, snipers, dev rugs, 40 smart wallets that tend to be early on winners,
// factory devs funded from the same wallet, pro teams funded from another, power-law peaks after bond, insider dumps.
// Run: HOURS=12 npx tsx sim/desk.ts
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MockRedis } from "./mockredis";
import { canonicalPool } from "../src/lib/pool";

let NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
Date.now = () => NOW;
const R = new MockRedis();
(globalThis as any).__rnRedis = R;

let rng = Number(process.env.SEED || 42);
const rand = () => ((rng = (rng * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pk = () => Keypair.generate().publicKey.toBase58();
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const MINT_AUTH = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";
const SOL_USD = 150;

const SMART = Array.from({ length: 40 }, pk);
const FACTORY = pk(); // funds serial ruggers
const PRO = pk(); // funds teams that ship winners
const CEX = pk(); // funds everyone else
const factoryDevs = Array.from({ length: 25 }, pk);
const proDevs = Array.from({ length: 8 }, pk);
const funderOf = new Map<string, string>();
factoryDevs.forEach((d) => funderOf.set(d, FACTORY));
proDevs.forEach((d) => funderOf.set(d, PRO));

type Coin = {
  i: number; mint: string; curve: string; sig: string; t: number; slot0: number; creator: string;
  bondAt: number | null; peak: number; peakAt: number; socials: boolean; desc: boolean; dev: number;
  rug: boolean; rugAt: number; bundled: boolean; smartIn: number; postPeakUsd: number; postPeakAt: number; symbol: string; farm: boolean; wash?: boolean; tw?: { name: string; sym: string; url: string | null; real: boolean };
  ghost: boolean; pool: string; bv: string; qv: string; // ghost: curve hits 100% but never migrates (the v0.1.4 false graduations)
};
const coins: Coin[] = [];
const bySig = new Map<string, Coin>();
const byCurve = new Map<string, Coin>();
const byMint = new Map<string, Coin>();
const byPool = new Map<string, Coin>();
const byVault = new Map<string, { c: Coin; q: boolean }>();
const accs = new Map<string, { coin: Coin; w: string; role: string; amt: number }>(); // token account -> holder
const accOf = new Map<string, string>(); // wallet|mint -> token account
let slot = 1000;

function spawnCoin(tw?: { name: string; sym: string; url: string | null; real: boolean }) {
  const kp = Keypair.generate().publicKey;
  const mint = kp.toBase58();
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), kp.toBuffer()], PUMP);
  const kind = rand();
  const creator = kind < 0.25 ? factoryDevs[Math.floor(rand() * factoryDevs.length)] : kind < 0.29 ? proDevs[Math.floor(rand() * proDevs.length)] : pk();
  if (!funderOf.has(creator)) funderOf.set(creator, CEX);
  const fac = funderOf.get(creator) === FACTORY;
  const pro = funderOf.get(creator) === PRO;
  const socials = rand() < (pro ? 0.9 : 0.35);
  const desc = rand() < 0.4;
  const bondP = (fac ? 0.002 : pro ? 0.18 : 0.008) + (socials ? 0.015 : 0) + (desc ? 0.006 : 0);
  const farm = rand() < 0.04; // block-0 farm: bundle pumps the curve, 5 bot wallets trade uniform sizes, fake bond, dump
  const ghost = !farm && rand() < 0.03;
  const wash = !tw && !farm && !ghost && rand() < 0.05; // bot coin: a handful of wallets loop micro-buys, curve pumped by the dev, never bonds
  const bonds = !wash && (farm || ghost || rand() < bondP);
  // power law after bond: most die near $70K, a few run to $1M-$50M
  const u = Math.max(1e-6, rand());
  const postPeakUsd = bonds ? Math.min(5e7, 70_000 * Math.pow(1 / u, pro ? 1.4 : 1.0)) : 0;
  const c: Coin = {
    i: coins.length, mint, curve: pda.toBase58(), sig: bs58.encode(Keypair.generate().secretKey.slice(0, 64)), t: NOW, slot0: (slot += 3),
    creator, bondAt: bonds ? NOW + (2 + rand() * 40) * 60_000 : null, peak: bonds ? 100 : Math.pow(rand(), 3) * 60, peakAt: NOW + rand() * 40 * 60_000,
    socials, desc, dev: Math.round(rand() * 30) / 10, rug: fac ? rand() < 0.7 : rand() < 0.15, rugAt: NOW + (4 + rand() * 30) * 60_000,
    bundled: fac ? rand() < 0.8 : rand() < 0.2, smartIn: bonds ? (rand() < 0.6 ? 1 + Math.floor(rand() * 4) : 0) : rand() < 0.04 ? 1 : 0,
    postPeakUsd: farm ? 80_000 : postPeakUsd, postPeakAt: 0, symbol: `C${coins.length}`, farm,
    ghost, pool: canonicalPool(mint), bv: pk(), qv: pk(), wash,
  };
  if (tw) {
    // tweet coins: the real one (first, links the post) often runs; copies die
    c.tw = tw;
    c.farm = false;
    c.ghost = false;
    c.wash = false;
    c.socials = true;
    if (tw.real && rand() < 0.55) {
      c.bondAt = NOW + (4 + rand() * 12) * 60_000;
      c.postPeakUsd = 70_000 * Math.pow(1 / Math.max(1e-6, rand()), 1.2);
      c.postPeakAt = c.bondAt + (10 + rand() * 600) * 60_000;
      c.rug = false;
    } else {
      c.bondAt = null;
      c.peak = 5 + rand() * 20;
      c.peakAt = NOW + (2 + rand() * 6) * 60_000;
    }
  }
  if (wash) {
    c.peak = 40 + rand() * 20;
    c.peakAt = NOW + (6 + rand() * 10) * 60_000;
    c.socials = true;
    c.desc = true;
  }
  if (farm) {
    c.bondAt = NOW + (3 + rand() * 5) * 60_000;
    c.bundled = true;
    c.rug = true;
    c.rugAt = c.bondAt + 5 * 60_000;
    c.smartIn = 0;
  }
  if (bonds) c.postPeakAt = c.bondAt! + (10 + rand() * 60 * 24) * 60_000;
  coins.push(c);
  bySig.set(c.sig, c);
  byCurve.set(c.curve, c);
  byMint.set(c.mint, c);
  byPool.set(c.pool, c);
  byVault.set(c.bv, { c, q: false });
  byVault.set(c.qv, { c, q: true });
}

function progressOf(c: Coin) {
  if (NOW < c.t) return 0;
  if (c.bondAt) return NOW >= c.bondAt ? 100 : Math.min(99, (100 * (NOW - c.t)) / (c.bondAt - c.t));
  let p = NOW <= c.peakAt ? (c.peak * (NOW - c.t)) / Math.max(1, c.peakAt - c.t) : Math.max(0, c.peak * Math.exp(-(NOW - c.peakAt) / (60 * 60_000)));
  if (c.rug && NOW >= c.rugAt) p *= 0.25;
  // noise so pullbacks exist
  return Math.max(0, p * (1 + 0.15 * Math.sin(NOW / 47_000 + c.i)));
}
function postUsd(c: Coin) {
  if (!c.bondAt || NOW < c.bondAt || c.ghost) return 0;
  const start = 69_000;
  if (NOW <= c.postPeakAt) return start * Math.pow(c.postPeakUsd / start, (NOW - c.bondAt) / Math.max(1, c.postPeakAt - c.bondAt));
  return Math.max(5000, c.postPeakUsd * Math.exp(-(NOW - c.postPeakAt) / (6 * 3600_000)));
}

function curveData(c: Coin) {
  const b = Buffer.alloc(151);
  const p = Math.min(100, progressOf(c));
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

// ---- trades on a curve
type T = { sig: string; slot: number; t: number; w: string; sol: number; tok: number; role: string };
const tradeCache = new Map<string, T[]>();
function tradesOf(c: Coin): T[] {
  const key = `${c.i}`;
  let all = tradeCache.get(key);
  if (!all) {
    all = [];
    let r2 = c.i * 7919 + 1;
    const rr = () => ((r2 = (r2 * 1103515245 + 12345) % 2147483648) / 2147483648);
    const good = !!c.bondAt;
    const n = 400;
    const add = (k: number, w: string, sol: number, role: string, dt: number, sl: number) => all!.push({ sig: `tr${c.i}x${k}`, slot: sl, t: c.t + dt, w, sol, tok: sol > 0 ? sol * 3e7 : sol * 3e7, role });
    add(0, c.creator, c.dev || 0.5, "dev", 0, c.slot0);
    let k = 1;
    if (c.farm) for (let j = 0; j < 8; j++) add(k++, `b${c.i}w${j}`, 4 + rr() * 3, "bundle", 0, c.slot0);
    else if (c.bundled) for (let j = 0; j < 4 + Math.floor(rr() * 6); j++) add(k++, `b${c.i}w${j}`, 0.5 + rr() * 2, "bundle", 0, c.slot0);
    for (let j = 0; j < 2 + Math.floor(rr() * 4); j++) add(k++, `s${c.i}w${j}`, 0.3 + rr(), "sniper", 400, c.slot0 + 1 + Math.floor(rr() * 2));
    for (let j = 0; j < c.smartIn; j++) add(k++, SMART[Math.floor(rr() * SMART.length)], 1 + rr() * 2, "smart", 2000 + j * 3000, c.slot0 + 5 + j * 7);
    if (c.wash) {
      // bot coin: 1 to 9 wallets, 0.001 SOL buys and sells over and over
      const nw = 1 + Math.floor(rr() * 9);
      for (; k < n; k++) add(k, `wb${c.i}w${k % nw}`, (k % 3 ? 1 : -1) * 0.001, "bot", k * 700, c.slot0 + 10 + k * 2);
    }
    if (c.farm) {
      // volume bots: the same 5 wallets, the same size, buy and sell
      for (; k < n; k++) add(k, `bot${c.i}w${k % 5}`, (k % 2 ? 1 : -1) * 0.5, "bot", k * 1500, c.slot0 + 10 + k * 4);
    }
    for (; k < n; k++) {
      const dt = k * (good ? 1500 : 4000) + rr() * 1000;
      const buy = rr() < (good ? 0.68 : 0.52);
      const sol = (buy ? 1 : -1) * (good ? 0.4 + rr() * 1.4 : 0.05 + rr() * 0.6);
      add(k, `r${Math.floor(rr() * 1e9)}`, sol, "retail", dt, c.slot0 + 10 + k * 4);
    }
    if (c.rug) add(k++, c.creator, -(2 + rr() * 5), "dev", c.rugAt - c.t, c.slot0 + 10 + k * 4);
    all.sort((a, b) => a.t - b.t);
    tradeCache.set(key, all);
  }
  return all.filter((t) => t.t <= NOW);
}
const sigTrade = (sig: string): { c: Coin; t: T } | null => {
  const m = /^tr(\d+)x/.exec(sig);
  if (!m) return null;
  const c = coins[Number(m[1])];
  const t = tradesOf(c).find((x) => x.sig === sig) || (tradeCache.get(`${c.i}`) || []).find((x) => x.sig === sig);
  return t ? { c, t } : null;
};
function tokenAcc(w: string, c: Coin, role: string) {
  const k = `${w}|${c.mint}`;
  let a = accOf.get(k);
  if (!a) {
    a = pk();
    accOf.set(k, a);
    accs.set(a, { coin: c, w, role, amt: 0 });
  }
  return a;
}
function walletPk(w: string) {
  // synthetic wallet ids -> stable real pubkeys
  if (w.length >= 32) return w;
  const k = `w|${w}`;
  let a = accOf.get(k);
  if (!a) {
    a = pk();
    accOf.set(k, a);
  }
  return a;
}

const str = (s: string) => { const x = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(x.length); return Buffer.concat([l, x]); };
function createTx(c: Coin) {
  const data = Buffer.concat([Buffer.from([214, 144, 76, 236, 95, 1, 2, 3]), str(c.tw ? c.tw.name : `Coin ${c.i}`), str(c.tw ? c.tw.sym : c.symbol), str(`https://meta.test/${c.mint}`), new PublicKey(c.creator).toBuffer(), Buffer.from([0])]);
  return {
    slot: c.slot0,
    blockTime: Math.floor(c.t / 1000),
    meta: { err: null, logMessages: ["Program log: Instruction: CreateV2"], postTokenBalances: [{ mint: c.mint, owner: c.curve }], innerInstructions: [], preBalances: [6e9, 0], postBalances: [5e9, Math.round((c.dev + 0.0016) * 1e9)] },
    transaction: { message: { instructions: [{ programId: PUMP, data: bs58.encode(data) }], accountKeys: [{ pubkey: new PublicKey(c.creator), signer: true }, { pubkey: new PublicKey(c.curve), signer: false }] } },
  };
}
function tradeTx(c: Coin, t: T) {
  const w = walletPk(t.w);
  const acc = tokenAcc(w, c, t.role);
  const h = accs.get(acc)!;
  h.amt = Math.max(0, h.amt + t.tok / 1e6);
  return {
    slot: t.slot,
    blockTime: Math.floor(t.t / 1000),
    meta: {
      err: null,
      preBalances: [5e9, 1e9, 0],
      postBalances: [5e9 - t.sol * 1e9, 1e9 + t.sol * 1e9, 0],
      preTokenBalances: [{ accountIndex: 2, mint: c.mint, owner: w, uiTokenAmount: { uiAmount: 0 } }],
      postTokenBalances: [{ accountIndex: 2, mint: c.mint, owner: w, uiTokenAmount: { uiAmount: Math.max(0, t.tok) } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: new PublicKey(w), signer: true }, { pubkey: new PublicKey(c.curve), signer: false }, { pubkey: new PublicKey(acc), signer: false }] } },
  };
}

let rpc = 0;
(globalThis as any).__rnConn = {
  async getSignaturesForAddress(addr: PublicKey, o: { until?: string; limit: number }) {
    rpc++;
    const a = addr.toBase58();
    if (a === MINT_AUTH) {
      const out = [];
      for (let i = coins.length - 1; i >= 0 && out.length < o.limit; i--) {
        if (coins[i].sig === o.until) break;
        if (coins[i].t <= NOW) out.push({ signature: coins[i].sig, err: null, slot: coins[i].slot0 });
      }
      return out;
    }
    const c = byCurve.get(a);
    if (c) return [{ signature: c.sig, slot: c.slot0, err: null }, ...tradesOf(c).slice(1).map((t) => ({ signature: t.sig, slot: t.slot, err: null }))].reverse().slice(0, o.limit);
    // a wallet: its first tx is the funding tx
    return [{ signature: `fund:${a}`, slot: 1, err: null }];
  },
  async getParsedTransaction(sig: string) {
    rpc++;
    if (sig.startsWith("fund:")) {
      const w = sig.slice(5);
      const f = funderOf.get(w) || CEX;
      return { slot: 1, blockTime: 0, meta: { err: null, preBalances: [1e10, 0], postBalances: [9e9, 1e9] }, transaction: { message: { accountKeys: [{ pubkey: new PublicKey(f), signer: true }, { pubkey: new PublicKey(w), signer: false }] } } };
    }
    const c = bySig.get(sig);
    if (c) return createTx(c);
    const st = sigTrade(sig);
    return st ? (st.t.role === "dev" && st.t.sol > 0 ? createTx(st.c) : tradeTx(st.c, st.t)) : null;
  },
  async getParsedTransactions(sigs: string[]) {
    return Promise.all(sigs.map((s) => (globalThis as any).__rnConn.getParsedTransaction(s)));
  },
  async getMultipleAccountsInfo(pks: PublicKey[]) {
    rpc++;
    return pks.map((p) => {
      const a = p.toBase58();
      const c = byCurve.get(a);
      if (c) return { data: curveData(c) };
      const pc = byPool.get(a);
      if (pc) {
        // the canonical pool exists only after a real migration (a few seconds after the curve completes)
        if (pc.ghost || !pc.bondAt || NOW < pc.bondAt + 15_000) return null;
        const d = Buffer.alloc(261);
        Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(d, 0);
        new PublicKey(pc.mint).toBuffer().copy(d, 43);
        new PublicKey("So11111111111111111111111111111111111111112").toBuffer().copy(d, 75);
        new PublicKey(pc.bv).toBuffer().copy(d, 139);
        new PublicKey(pc.qv).toBuffer().copy(d, 171);
        return { data: d };
      }
      const v = byVault.get(a);
      if (v) {
        const mc = postUsd(v.c);
        if (!mc) return null;
        const pxSol = mc / SOL_USD / 1e9;
        const sol = 85;
        const d = Buffer.alloc(165);
        d.writeBigUInt64LE(BigInt(Math.floor(v.q ? sol * 1e9 : (sol / pxSol) * 1e6)), 64);
        return { data: d };
      }
      const h = accs.get(a);
      if (h) {
        // insiders dump at the rug; others hold
        const dumped = h.coin.rug && NOW >= h.coin.rugAt && (h.role === "dev" || h.role === "bundle" || h.role === "sniper");
        const d = Buffer.alloc(165);
        d.writeBigUInt64LE(BigInt(Math.floor((dumped ? 0 : Math.max(h.amt, 1)) * 1e6)), 64);
        return { data: d };
      }
      return null;
    });
  },
  async getBalance() { return 0; },
  async getSlot() { return 1; },
};
let llmCalls = 0;
const llmKinds: Record<string, number> = {};
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sim";
(globalThis as any).fetch = async (url: string, init?: any) => {
  const u = String(url);
  if (u.includes("api.anthropic.com")) {
    // stand-in trader: SEND coins born from a big post or with 2+ smart wallets, PASS the rest
    llmCalls++;
    const b = JSON.parse(init.body);
    const text = b.messages[0].content.map((x: any) => x.text || "").join("\n");
    let out: any;
    if (b.system.includes("veteran")) {
      llmKinds.judge = (llmKinds.judge || 0) + 1;
      const smart = Number((/(\d+) smart wallets early/.exec(text) || [])[1] || 0);
      const send = text.includes("POST BEHIND IT") || smart >= 2;
      out = { verdict: send ? "SEND" : "PASS", conviction: send ? 82 : 25, thesis: send ? "Born from a big post with real buyers." : "Nothing here people will buy in the next hours.", reasons: ["test"], risks: ["test"], narrative: "sim", meme: "sim meme", copy: "original", horizon: "hours", lessons: ["s0", "s2"] };
    } else if (b.system.includes("reviewing your own call")) {
      llmKinds.pm = (llmKinds.pm || 0) + 1;
      out = { lesson: `Coins tied to a big post keep going when real buyers keep coming (case ${llmCalls}).`, helped: ["s0"], hurt: ["s2"] };
    } else {
      llmKinds.school = (llmKinds.school || 0) + 1;
      out = { lessons: [] };
    }
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(out) }] }) };
  }
  if (u.includes("geckoterminal")) {
    // MOMO's view: bonded sim coins still rising look hot (volume grows with the run), falling ones do not
    const hot = coins.filter((c) => c.bondAt && NOW > c.bondAt && !c.ghost && NOW - c.bondAt < 6 * 3600_000).slice(-40).map((c) => {
      const mc = postUsd(c);
      const rising = NOW < c.postPeakAt;
      const v5 = rising ? mc * 0.4 : mc * 0.05;
      return { attributes: { address: c.pool, name: `${c.symbol} / SOL`, pool_created_at: new Date(c.bondAt!).toISOString(), market_cap_usd: mc, reserve_in_usd: mc / 5, volume_usd: { m5: v5, h1: v5 * 6 }, transactions: { m5: { buys: rising ? 300 : 40, sells: rising ? 200 : 60, buyers: rising ? 150 : 25, sellers: rising ? 110 : 40 } }, price_change_percentage: { m5: rising ? 6 : -4, h1: rising ? 30 : -15, h6: 0 } }, relationships: { base_token: { data: { id: `solana_${c.mint}` } }, dex: { data: { id: "pumpswap" } } } };
    });
    return { ok: true, json: async () => ({ data: hot }) };
  }
  if (u.includes("price/v3")) return { ok: true, json: async () => ({ So11111111111111111111111111111111111111112: { usdPrice: SOL_USD } }) };
  if (u.includes("dexscreener")) {
    const mints = u.split("/").pop()!.split(",");
    const pairs = mints
      .map((m) => byMint.get(m))
      .filter((c): c is Coin => !!c && !!c.bondAt && NOW >= c.bondAt)
      .flatMap((c) => {
        const mc = postUsd(c);
        const junk = { baseToken: { address: c.mint }, quoteToken: { symbol: "SOL" }, pairAddress: c.bv, marketCap: 10, priceNative: 1e-11, liquidity: { usd: 4 }, volume: { h1: 900, h24: 5e6 }, txns: { h1: { buys: 99, sells: 85 } }, dexId: "pumpswap" };
        if (!mc) return [junk];
        return [junk, { baseToken: { address: c.mint }, quoteToken: { symbol: "SOL" }, pairAddress: c.pool, marketCap: mc, priceNative: mc / 1e9 / SOL_USD, liquidity: { usd: mc / 10 }, volume: { h1: mc / 5 }, txns: { h1: { buys: 60, sells: 40 } }, dexId: "pumpswap" }];
      });
    return { ok: true, json: async () => pairs };
  }
  const mint = u.split("/").pop()!;
  const c = byMint.get(mint);
  return { ok: true, json: async () => ({ description: c?.desc ? "a real description of this coin and why it exists in the trenches" : "", twitter: c?.tw?.url ? c.tw.url : c?.socials ? "https://x.com/c" : "", telegram: "", website: c?.socials ? "https://c.fun" : "", image: "" }) };
};

async function main() {
  const realST = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: any, ms = 0) => { NOW += ms; return realST(fn, 0); };
  const { dig } = await import("../src/lib/digger");
  const { deskSession, getDesk } = await import("../src/lib/desk");
  const { getRunner, topRunners } = await import("../src/lib/runner");
  const { ingest, parseHook } = await import("../src/lib/wire");
  const { mindSession, mindRecord, lessonBook } = await import("../src/lib/mind");
  const { momoScan } = await import("../src/lib/momo");
  const { catchPass, catchView } = await import("../src/lib/catcher");
  if (process.env.MIND !== "0") {
    const cur: any = R.kv.get("rn:settings") || {};
    R.kv.set("rn:settings", { ...cur, desk: { ...(cur.desk || {}), mindMode: "on" } });
  }
  if (process.env.DAILY_LOSS) R.kv.set("rn:settings", { desk: { dailyLoss: Number(process.env.DAILY_LOSS), maxOpen: Number(process.env.MAX_OPEN || 5) } });
  const NAMES = [["Kekius Maximus", "KEKIUS"], ["Mars Colony", "MARS"], ["Gork", "GORK"], ["Dogefather", "DOGEFATHER"], ["Tariff Cat", "TARIFF"], ["Grok Imagine", "IMAGINE"], ["Pepe Tesla", "PEPETESLA"], ["Moonshot", "MOONSHOT"]];
  const AUTH = ["elonmusk", "realDonaldTrump", "cz_binance", "blknoiz06", "WatcherGuru"];
  let tweetN = 0;
  let nextTweet = NOW + 10 * 60_000;
  const pendingCopies: { at: number; tw: { name: string; sym: string; url: string | null; real: boolean } }[] = [];
  const HOURS = Number(process.env.HOURS || 6);
  const PER_MIN = Number(process.env.PER_MIN || 15);
  const end = NOW + HOURS * 3600_000;
  let lastLog = NOW;
  const begin = NOW;
  let errs = 0;
  while (NOW < end) {
    const t = NOW;
    for (let i = 0; i < PER_MIN; i++) spawnCoin();
    if (NOW >= nextTweet) {
      nextTweet = NOW + (12 + rand() * 20) * 60_000;
      const [name, sym] = NAMES[tweetN % NAMES.length];
      const h = AUTH[tweetN % AUTH.length];
      const id = String(1900000000000000000n + BigInt(tweetN++));
      await ingest(parseHook({ tweets: [{ id, url: `https://x.com/${h}/status/${id}`, text: `${name} is coming`, createdAt: new Date(NOW).toISOString(), author: { userName: h, name: h, followers: 1e6 } }] }));
      // within 2 minutes: the real coin (links the post) and 2 to 5 copies
      pendingCopies.push({ at: NOW + 20_000, tw: { name, sym, url: `https://x.com/${h}/status/${id}`, real: true } });
      for (let k = 0; k < 2 + Math.floor(rand() * 4); k++) pendingCopies.push({ at: NOW + 30_000 + k * 20_000, tw: { name: k % 2 ? `${name} Official` : name, sym, url: null, real: false } });
    }
    for (let k = pendingCopies.length - 1; k >= 0; k--) if (pendingCopies[k].at <= NOW + 60_000) spawnCoin(pendingCopies.splice(k, 1)[0].tw);
    if (process.env.MOMO !== "0") await momoScan().catch((e: any) => errs++ < 8 && console.log("MOMO ERR", String(e)));
    if (process.env.CATCH !== "0") {
      const cr: any = await catchPass(true).catch((e: any) => ({ error: String(e?.stack || e) }));
      if (cr?.error && errs++ < 8) console.log("CATCH ERR", cr.error);
    }
    const res: any = await deskSession(50_000, async () => {
      const d: any = await dig();
      if (d.ok === false && errs++ < 5) console.log("DIG ERR", d.error);
    });
    if (res?.error && errs++ < 8) console.log("DESK ERR", res.error);
    if (process.env.MIND !== "0") {
      const mr: any = await mindSession(40_000).catch((e: any) => ({ error: String(e?.stack || e) }));
      if (mr?.error && errs++ < 8) console.log("MIND ERR", mr.error);
    }
    if (NOW < t + 60_000) NOW = t + 60_000;
    if (process.env.SIM_HOURLY === "1" && Math.floor((NOW - begin) / 3600_000) !== Math.floor((t - begin) / 3600_000)) {
      const dd: any = await getDesk();
      const day = Object.entries(R.kv).length; void day;
      const dk = [...R.kv.keys()].filter((k: string) => k.startsWith("rn:desk:day:")).map((k: string) => R.kv.get(k));
      const sum: Record<string, number> = {};
      for (const h of dk) for (const [k, v] of Object.entries(h || {})) sum[k] = (sum[k] || 0) + Number(v);
      const q = R.kv.get("rn:desk:q");
      const evs = ((R.kv.get("rn:desk:ev") || []) as any[]).slice(0, 300);
      const king = evs.filter((e) => e.agent === "KING" && NOW - e.at < 3600_000).length;
      const recentStats = (R.kv.get("rn:stat") || {}) as any;
      console.log(`H${Math.floor((NOW - begin) / 3600_000)} closed=${dd.state.closed} open=${dd.positions.length} eq=${dd.state.equity.toFixed(2)} dayStart=${dd.state.dayStart?.toFixed?.(2)} seen=${sum.seen || 0} passed=${sum.passed || 0} fails=${Object.entries(sum).filter(([k]) => k.startsWith("f:")).sort((a: any, b: any) => b[1] - a[1]).slice(0, 4).map(([k, v]) => k.slice(2) + ":" + v).join(",")} q=${q ? q.size ?? Object.keys(q).length : 0} kingEv1h=${king} calls=${recentStats.calls ?? "?"} bondCalls=${recentStats.bond ?? "?"} pos=${dd.positions.map((p: any) => p.how + (p.tp1Done ? "*" : "")).join(" ")}`);
    }
    if (NOW - lastLog >= 2 * 3600_000) {
      lastLog = NOW;
      const d: any = await getDesk();
      const rn: any = await getRunner();
      console.log(
        `h=${((NOW - begin) / 3600_000).toFixed(1)} eq=${d.state.equity.toFixed(3)} closed=${d.state.closed} wins=${d.state.wins} open=${d.positions.length} trailK=${d.learn.trailK.toFixed(2)} reviews=${d.learn.reviews}(${d.learn.early}/${d.learn.late}/${d.learn.good}) arms=${d.learn.arms.map((a: any) => `${a.arm}:${a.mean}%/${a.n}`).join(" ")} stalk=${d.learn.stalkOn} early=${d.learn.earlyStat.n}/${d.learn.earlyStat.hit} runner n=${rn.n}`
      );
    }
  }
  const d: any = await getDesk();
  const rn: any = await getRunner();
  const top = await topRunners(8);
  const st = (R.kv.get("rn:stat") || {}) as any;
  const sw = (R.kv.get("rn:sw:b") || {}) as any;
  const smartHits = SMART.filter((w) => Number(sw[w] || 0) > 0).length;
  const cl = R.kv.get("rn:g:n") || {};
  const clb = R.kv.get("rn:g:b") || {};
  console.log("\n=== summary");
  if (process.env.CATCH !== "0") {
    const cv: any = await catchView();
    const trips = ((R.kv.get("rn:desk:trips") || []) as any[]).filter((t) => t.how === "catch");
    const pnl = trips.map((t) => (t.exitPx / t.entryPx - 1) * 100);
    console.log("CATCH model", JSON.stringify(cv.model.ready), `n=${cv.model.n} pos=${cv.model.pos}`, "all", `${cv.all.hit}/${cv.all.n}`, "curve", `${cv.stages.curve.hit}/${cv.stages.curve.n}`, "pool", `${cv.stages.pool.hit}/${cv.stages.pool.n}`);
    console.log("CATCH prior bands", cv.bands.map((b: any) => `${b.b * 10}:${b.qhit}/${b.qn}`).join(" "), "| model bands", cv.bands.map((b: any) => `${b.b * 10}:${b.hit}/${b.n}`).join(" "));
    console.log("CATCH desk trades", trips.length, "avg exit vs entry", pnl.length ? (pnl.reduce((a, x) => a + x, 0) / pnl.length).toFixed(1) + "%" : "-", "winners", pnl.filter((x) => x > 0).length);
  }
  if (process.env.MIND !== "0") {
    const book = await lessonBook();
    console.log("MIND llm calls", llmCalls, JSON.stringify(llmKinds), "record", JSON.stringify((await mindRecord()).map((r: any) => [r.verdict, r.n, r.h.map((h: any) => `${h.k}:${h.avg}%/${h.n}`).join(" ")])), "lessons", book.length, "top", book.slice(0, 2).map((l: any) => `${l.id} ${l.wins}-${l.losses}`).join(", "));
    const mindTrips = ((R.kv.get("rn:desk:trips") || []) as any[]).filter((t) => t.how === "mind").length;
    const mindGhost = ((R.kv.get("rn:ghost:trips") || []) as any[]).filter((t) => t.how === "mind").length;
    console.log("MIND trades closed", mindTrips, "ghost", mindGhost, "cal", JSON.stringify(R.kv.get("rn:kcal:now") ? { ready: (R.kv.get("rn:kcal:now") as any).ready, n: (R.kv.get("rn:kcal:now") as any).n, pos: (R.kv.get("rn:kcal:now") as any).pos, bond: (R.kv.get("rn:kcal:now") as any).bond } : null));
  }
  const ghosts = coins.filter((c) => c.ghost && c.bondAt && c.bondAt <= NOW - 31 * 60_000);
  const ghostBonded = ghosts.filter((c) => (R.kv.get(`rn:launch:${c.mint}`) as any)?.outcome === "BONDED").length;
  const realDone = coins.filter((c) => !c.ghost && c.bondAt && c.bondAt <= NOW - 60_000);
  const realMissed = realDone.filter((c) => { const l = R.kv.get(`rn:launch:${c.mint}`) as any; return l && l.outcome && l.outcome !== "BONDED"; }).length;
  const runs = [...R.kv.entries()].filter(([k]) => String(k).startsWith("rn:run:") && (R.kv.get(k) as any)?.pk != null).map(([, v]) => v as any);
  const badPk = runs.filter((x) => x.bondedAt && x.pk > 0 && x.pk < 5000).length;
  console.log(`ghosts (curve full, never migrated): ${ghosts.length}, counted as BONDED: ${ghostBonded}, stuck stat ${st.stuck || 0} · real bonds resolved as not bonded: ${realMissed} · runner peaks under $5K after bond: ${badPk}/${runs.length}`);
  console.log("coins", coins.length, "bonded truth", coins.filter((c) => !c.ghost && c.bondAt && c.bondAt <= NOW).length, "detected", st.bonded, "taped", st.tape_n, "taped bonded", st.tape_b);
  console.log("calls BOND hit", `${st.bond_hit}/${st.bond_res}`, "label-window: King BOND", `${st.lbond_hit}/${st.lbond_n}`, "early BOND", `${st.lebond_hit}/${st.lebond_n}`);
  console.log("smart wallets credited with a bond:", smartHits, "/", SMART.length);
  const farmCoins = coins.filter((c) => c.farm && c.t <= NOW - 6 * 60_000);
  let fFlag = 0, fCalled = 0, fBond = 0;
  for (const c of farmCoins) {
    const call = R.kv.get(`rn:call:${c.mint}`) as any;
    if (!call) continue;
    fCalled++;
    if (call.farm) fFlag++;
    if (call.verdict === "BOND") fBond++;
  }
  const washCoins = coins.filter((c) => c.wash && c.t <= NOW - 6 * 60_000);
  let wCalled = 0, wFlag = 0, wBond = 0, wTaped = 0;
  for (const c of washCoins) { const call = R.kv.get(`rn:call:${c.mint}`) as any; if (!call) continue; wCalled++; if (call.farm) wFlag++; if (call.verdict === "BOND") wBond++; if (!call.farm && call.tp) wTaped++; }
  const realBonds = coins.filter((c) => !c.farm && !c.wash && !c.ghost && c.bondAt && c.t <= NOW - 6 * 60_000);
  let rbCalled = 0, rbFlag = 0;
  for (const c of realBonds) { const call = R.kv.get(`rn:call:${c.mint}`) as any; if (!call) continue; rbCalled++; if (call.farm) rbFlag++; }
  console.log(`bot coins: ${washCoins.length} launched, ${wCalled} called, ${wFlag} flagged FARM, ${wBond} still called BOND, ${wTaped} read and not flagged · desk bought bot coins: ${(d.trades as any[]).filter((t) => t.side === "buy" && byMint.get(t.mint)?.wash).length} · real bonds wrongly flagged: ${rbFlag} of ${rbCalled}`);
  for (const t of (d.trades as any[]).filter((t) => t.side === "buy" && (byMint.get(t.mint)?.farm || byMint.get(t.mint)?.wash))) { const L = R.kv.get(`rn:launch:${t.mint}`) as any; console.log("BOUGHT BAD", t.symbol, t.reason, "early tape farm", L?.tape?.farm?.farm, "call farm", (R.kv.get(`rn:call:${t.mint}`) as any)?.farm, "ctx checks", JSON.stringify(t.ctx?.checks?.find((c: any) => c.rule === "not_a_farm"))); }
  // v0.1.58: ARENA books
  {
    const { arenaView } = await import("../src/lib/arena");
    const av: any = await arenaView();
    console.log("ARENA", av.variants.map((v: any) => `${v.id}: ${v.n} trips (${v.open.length} open) win ${Math.round(v.winRate)}% avg ${v.avgPct}% exam ${v.checks.filter((c: any) => c.ok).length}/${v.checks.length}`).join(" | "));
  }
  const gt = ((R.kv.get("rn:ghost:trades") as any[]) || []);
  const gpos = R.kv.get("rn:ghost:pos") as any;
  console.log(`ghost desk: ${gt.filter((t) => t.side === "buy").length} buys, ${gt.filter((t) => t.side === "sell").length} sells, ${gpos ? Object.keys(gpos).length : 0} open · exam drawdown check: ${JSON.stringify((await (await import("../src/lib/desk")).getDesk() as any).exam?.checks?.find((c: any) => /drawdown/.test(c.label)))}`);
  const twCoins = coins.filter((c) => c.tw);
  const picked = twCoins.filter((c) => (R.kv.get(`rn:launch:${c.mint}`) as any)?.wire?.pick);
  const boughtTw = (d.trades as any[]).filter((t) => t.side === "buy" && byMint.get(t.mint)?.tw);
  console.log(`wire: ${tweetN} posts, ${twCoins.length} tweet coins, matched ${twCoins.filter((c) => (R.kv.get(`rn:launch:${c.mint}`) as any)?.wire).length}, picked ${picked.length} (real ${picked.filter((c) => c.tw!.real).length}), desk bought ${boughtTw.length} (real ${boughtTw.filter((t) => byMint.get(t.mint)!.tw!.real).length})`);
  const realBundled = coins.filter((c) => !c.farm && c.bundled && c.bondAt);
  let rFlag = 0, rCalled = 0;
  for (const c of realBundled) { const call = R.kv.get(`rn:call:${c.mint}`) as any; if (!call) continue; rCalled++; if (call.farm) rFlag++; }
  const boughtFarm = (d.trades as any[]).filter((t) => t.side === "buy" && byMint.get(t.mint)?.farm).length;
  console.log(`farms: ${farmCoins.length} launched, ${fCalled} called, ${fFlag} flagged FARM, ${fBond} still called BOND · desk bought farms: ${boughtFarm}`);
  console.log(`real block-0 bundles that bonded: ${rCalled} called, ${rFlag} wrongly flagged as farm`);
  console.log("clusters: FACTORY", cl[FACTORY] || 0, "launches /", clb[FACTORY] || 0, "bonded · PRO", cl[PRO] || 0, "/", clb[PRO] || 0, "· CEX", cl[CEX] || 0, "/", clb[CEX] || 0);
  console.log("runner ladder:", rn.ladder.map((l: any) => `${Math.round(l.from / 1000)}K→${l.up}/${l.n}`).join(" "));
  console.log("top runners:", top.map((v: any) => `$${v.symbol} ${v.x}x pk ${Math.round(v.pk / 1000)}K`).join(", "));
  console.log("desk:", `eq ${d.state.equity.toFixed(3)} closed ${d.state.closed} wins ${d.state.wins} trailK ${d.learn.trailK.toFixed(2)} stalkOn ${d.learn.stalkOn}`);
  const reasons: Record<string, number> = {};
  for (const tr of d.trades) if (tr.side === "sell") { const k = tr.reason.replace(/[\d.+\-%$x,]+/g, "#").slice(0, 40); reasons[k] = (reasons[k] || 0) + 1; }
  console.log("sell reasons:", reasons);
  console.log("errors:", errs, "rpc:", rpc, "redis:", R.calls);
  console.log(d.events.slice(0, 25).map((e: any) => `${e.agent}: ${e.text}`).join("\n"));
  const dump: any = {};
  for (const [k, v] of R.kv) dump[k] = v instanceof Map ? { __z: [...v.entries()] } : v;
  require("fs").writeFileSync(process.env.DUMP || "sim/state.json", JSON.stringify(dump));
}
main();
