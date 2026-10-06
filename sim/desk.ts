// Desk simulator v0.1.4: the real engine + desk against a synthetic pump.fun with structure the agents can learn:
// trades on every curve, bundles, snipers, dev rugs, 40 smart wallets that tend to be early on winners,
// factory devs funded from the same wallet, pro teams funded from another, power-law peaks after bond, insider dumps.
// Run: HOURS=12 npx tsx sim/desk.ts
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MockRedis } from "./mockredis";

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
  rug: boolean; rugAt: number; bundled: boolean; smartIn: number; postPeakUsd: number; postPeakAt: number; symbol: string; farm: boolean;
};
const coins: Coin[] = [];
const bySig = new Map<string, Coin>();
const byCurve = new Map<string, Coin>();
const byMint = new Map<string, Coin>();
const accs = new Map<string, { coin: Coin; w: string; role: string; amt: number }>(); // token account -> holder
const accOf = new Map<string, string>(); // wallet|mint -> token account
let slot = 1000;

function spawnCoin() {
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
  const bonds = farm || rand() < bondP;
  // power law after bond: most die near $70K, a few run to $1M-$50M
  const u = Math.max(1e-6, rand());
  const postPeakUsd = bonds ? Math.min(5e7, 70_000 * Math.pow(1 / u, pro ? 1.4 : 1.0)) : 0;
  const c: Coin = {
    i: coins.length, mint, curve: pda.toBase58(), sig: bs58.encode(Keypair.generate().secretKey.slice(0, 64)), t: NOW, slot0: (slot += 3),
    creator, bondAt: bonds ? NOW + (2 + rand() * 40) * 60_000 : null, peak: bonds ? 100 : Math.pow(rand(), 3) * 60, peakAt: NOW + rand() * 40 * 60_000,
    socials, desc, dev: Math.round(rand() * 30) / 10, rug: fac ? rand() < 0.7 : rand() < 0.15, rugAt: NOW + (4 + rand() * 30) * 60_000,
    bundled: fac ? rand() < 0.8 : rand() < 0.2, smartIn: bonds ? (rand() < 0.6 ? 1 + Math.floor(rand() * 4) : 0) : rand() < 0.04 ? 1 : 0,
    postPeakUsd: farm ? 80_000 : postPeakUsd, postPeakAt: 0, symbol: `C${coins.length}`, farm,
  };
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
  if (!c.bondAt || NOW < c.bondAt) return 0;
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
  const data = Buffer.concat([Buffer.from([214, 144, 76, 236, 95, 1, 2, 3]), str(`Coin ${c.i}`), str(c.symbol), str(`https://meta.test/${c.mint}`), new PublicKey(c.creator).toBuffer(), Buffer.from([0])]);
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
(globalThis as any).fetch = async (url: string) => {
  const u = String(url);
  if (u.includes("price/v3")) return { ok: true, json: async () => ({ So11111111111111111111111111111111111111112: { usdPrice: SOL_USD } }) };
  if (u.includes("dexscreener")) {
    const mints = u.split("/").pop()!.split(",");
    const pairs = mints
      .map((m) => byMint.get(m))
      .filter((c): c is Coin => !!c && !!c.bondAt && NOW >= c.bondAt)
      .map((c) => {
        const mc = postUsd(c);
        return { baseToken: { address: c.mint }, quoteToken: { symbol: "SOL" }, marketCap: mc, priceNative: mc / 1e9 / SOL_USD, liquidity: { usd: mc / 10 }, volume: { h1: mc / 5 }, txns: { h1: { buys: 60, sells: 40 } }, dexId: "pumpswap" };
      });
    return { ok: true, json: async () => pairs };
  }
  const mint = u.split("/").pop()!;
  const c = byMint.get(mint);
  return { ok: true, json: async () => ({ description: c?.desc ? "a real description of this coin and why it exists in the trenches" : "", twitter: c?.socials ? "https://x.com/c" : "", telegram: "", website: c?.socials ? "https://c.fun" : "", image: "" }) };
};

async function main() {
  const realST = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: any, ms = 0) => { NOW += ms; return realST(fn, 0); };
  const { dig } = await import("../src/lib/digger");
  const { deskSession, getDesk } = await import("../src/lib/desk");
  const { getRunner, topRunners } = await import("../src/lib/runner");
  const HOURS = Number(process.env.HOURS || 6);
  const PER_MIN = Number(process.env.PER_MIN || 15);
  const end = NOW + HOURS * 3600_000;
  let lastLog = NOW;
  const begin = NOW;
  let errs = 0;
  while (NOW < end) {
    const t = NOW;
    for (let i = 0; i < PER_MIN; i++) spawnCoin();
    const res: any = await deskSession(50_000, async () => {
      const d: any = await dig();
      if (d.ok === false && errs++ < 5) console.log("DIG ERR", d.error);
    });
    if (res?.error && errs++ < 8) console.log("DESK ERR", res.error);
    if (NOW < t + 60_000) NOW = t + 60_000;
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
  console.log("coins", coins.length, "bonded truth", coins.filter((c) => c.bondAt && c.bondAt <= NOW).length, "detected", st.bonded, "taped", st.tape_n, "taped bonded", st.tape_b);
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
