import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { AsyncLocalStorage } from "node:async_hooks";
import { INITIAL_REAL_TOKEN_RESERVES, PUMP_PROGRAM } from "@/config/site";
import { K, redis } from "./redis";

// ---------- RPC rate limiter ----------
// The desk, the rats and the HISTORIAN share one process (and one RPC plan) every minute. One token bucket keeps every
// call under the plan's limit (RPC_RPS, default 10 = Helius free). Three lanes: the desk first (positions, exits),
// then the dig, then the historian on spare capacity only (at most 40%). A batched request costs one token per call
// inside it (that is how Helius counts). A 429 empties the bucket so everyone slows down, then retries.
export const RPS = Math.max(1, Number(process.env.RPC_RPS || 10));
export const lane = new AsyncLocalStorage<number>(); // 0 desk (default), 1 the rats (dig), 2 agents, 3 historian
export const lowLane = { run: <T,>(_: boolean, fn: () => T) => lane.run(3, fn) };
const queues: { cost: number; go: () => void; at: number }[][] = [[], [], [], []];
const log1m: [number, number, number, number][] = []; // [time, lane, calls, waited ms] over the last minute
// strict rolling 1-second window (never a burst over the plan), 10% headroom
const CAP = Math.max(1, Math.floor(RPS * 0.9));
// the live ceiling: it drops by a fifth on every 429 (the plan's real limit is lower than RPC_RPS, or another process
// shares the key) and climbs back one call per second every 10 quiet seconds. Before v0.1.24 a 429 only paused the
// window for a second, so the worker kept hammering at the full rate and every lane slowed to a crawl
let capNow = CAP;
let lastThrottle = 0;
let lastRaise = 0;
const sent: [number, number][] = []; // [time, calls]
const hist: [number, number][] = []; // historian share of the window
let timer: ReturnType<typeof setTimeout> | null = null;
const used = (w: [number, number][], now: number) => {
  while (w.length && now - w[0][0] >= 1100) w.shift(); // 1.1s: absorbs network jitter
  return w.reduce((a, x) => a + x[1], 0);
};
// Lanes, in priority order, each with a ceiling on its share of the plan while others are waiting, so no lane can
// starve the rest: the desk (exits and entries) first, then the rats (new launches, minute-1 reads, minute-5 calls),
// then the agents (CATCH, HOUND, MOMO, LENS...), then the historian. Before v0.1.21 the agents shared the desk's lane
// and one heavy agent (HOUND digging a breakout's whole curve) could keep the rats waiting for minutes.
const SHARE = [0.7, 0.8, 0.5, 0.4];
const RESERVE = [0.3, 0.3, 0.2, 0.1]; // guaranteed per lane each second, whatever the others want
const lanesUsed: [number, number, number][] = []; // [time, calls, lane]
const usedBy = (l: number, now: number) => {
  while (lanesUsed.length && now - lanesUsed[0][0] >= 1100) lanesUsed.shift();
  return lanesUsed.reduce((a, x) => a + (x[2] === l ? x[1] : 0), 0);
};
function pump() {
  timer = null;
  {
    const now = Date.now();
    if (capNow < CAP && now - lastThrottle > 10_000 && now - lastRaise > 10_000) {
      capNow++;
      lastRaise = now;
    }
  }
  const CAPL = capNow;
  for (;;) {
    const now = Date.now();
    if (!queues.some((x) => x.length)) break;
    if (used(sent, now) >= CAPL) break;
    let served = false;
    // 1) every lane first gets its reserved floor, so none can starve (before v0.1.24 the desk and the rats could
    // take 70% + 80% of the plan between them and the agents and the historian waited for minutes: CATCH, HOUND,
    // MIND and the slow lane all went silent while the desk kept beating)
    for (let l = 0; l < queues.length && !served; l++) {
      const q = queues[l];
      if (!q.length) continue;
      const need = Math.min(q[0].cost, CAPL);
      if (used(sent, now) + need > CAPL) break;
      if (usedBy(l, now) >= Math.max(1, Math.floor(CAPL * RESERVE[l]))) continue;
      const job = q.shift()!;
      sent.push([now, need]);
      lanesUsed.push([now, need, l]);
      if (l === 3) hist.push([now, need]);
      log1m.push([now, l, need, now - job.at]);
      job.go();
      served = true;
    }
    if (served) continue;
    // 2) what is left goes by priority, each lane up to its ceiling while others wait
    for (let l = 0; l < queues.length && !served; l++) {
      const q = queues[l];
      if (!q.length) continue;
      const job = q[0];
      const need = Math.min(job.cost, CAPL);
      if (used(sent, now) + need > CAPL) break;
      // alone, a lane may use the whole plan; with others waiting, only its share
      const othersWaiting = queues.some((x, i) => i !== l && x.length);
      const cap = l === 3 ? Math.floor(CAPL * (queues[0].length || queues[1].length ? 0.4 : 0.75)) : othersWaiting ? Math.floor(CAPL * SHARE[l]) : CAPL;
      // a lane that has used nothing this second may always send one job, even one bigger than its ceiling (a big
      // batch used to wait forever behind its own lane's ceiling while other lanes kept the plan busy)
      const mine = usedBy(l, now);
      if (mine > 0 && mine + need > Math.max(1, cap)) continue;
      sent.push([now, need]);
      lanesUsed.push([now, need, l]);
      if (l === 3) hist.push([now, need]);
      q.shift();
      log1m.push([now, l, need, now - job.at]);
      job.go();
      served = true;
    }
    if (!served) break;
  }
  if (queues.some((x) => x.length) && !timer) timer = setTimeout(pump, sent.length ? Math.max(15, 1100 - (Date.now() - sent[0][0]) + 2) : 20);
}
const slot = (l: number, cost: number) =>
  new Promise<void>((go) => {
    queues[Math.max(0, Math.min(3, l))].push({ cost, go, at: Date.now() });
    pump();
  });
export const rpcStats = { calls: 0, throttled: 0 };
const thr1m: number[] = [];
/** The limiter's last minute, per lane: calls, average wait in the queue, what is waiting now, 429s, the live ceiling. */
export function rpcView() {
  const now = Date.now();
  while (log1m.length && now - log1m[0][0] > 60_000) log1m.shift();
  while (thr1m.length && now - thr1m[0] > 60_000) thr1m.shift();
  const names = ["desk", "rats", "agents", "historian"];
  const by = names.map((name, l) => {
    const xs = log1m.filter((x) => x[1] === l);
    const calls = xs.reduce((a, x) => a + x[2], 0);
    return { lane: name, perSec: Math.round((calls / 60) * 10) / 10, waitMs: xs.length ? Math.round(xs.reduce((a, x) => a + x[3], 0) / xs.length) : 0, queued: queues[l].length };
  });
  return { plan: RPS, cap: CAP, capNow, perSec: Math.round((log1m.reduce((a, x) => a + x[2], 0) / 60) * 10) / 10, throttled1m: thr1m.length, lanes: by };
}
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 8000);
const BATCH_MAX = 10;
export async function limitedFetch(input: any, init?: any): Promise<Response> {
  const l = lane.getStore() ?? 0;
  let cost = 1;
  let batch: unknown[] | null = null;
  try {
    const b = typeof init?.body === "string" ? init.body : "";
    if (b.startsWith("[")) {
      batch = JSON.parse(b) as unknown[];
      cost = Math.max(1, batch.length);
    }
  } catch {}
  // a big JSON-RPC batch (a tape read asks for ~42 transactions at once) goes out in slices of 10: it fits every lane's
  // share and never lands on the plan as one burst (the plan counts every call inside a batch)
  if (batch && batch.length > BATCH_MAX) {
    const out: unknown[] = [];
    for (let i = 0; i < batch.length; i += BATCH_MAX) {
      const res = await limitedFetch(input, { ...init, body: JSON.stringify(batch.slice(i, i + BATCH_MAX)) });
      if (!res.ok) return res;
      const j = await res.json();
      if (!Array.isArray(j)) return new Response(JSON.stringify(j), { status: res.status, headers: { "content-type": "application/json" } });
      out.push(...j);
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }
  for (let i = 0; ; i++) {
    await slot(l, cost);
    rpcStats.calls += cost;
    // every chain read has a deadline: one stalled connection must never freeze the desk (a long-running worker has
    // no platform timeout to save it)
    const deadline = AbortSignal.timeout(RPC_TIMEOUT_MS);
    const signal = init?.signal && (AbortSignal as any).any ? (AbortSignal as any).any([init.signal, deadline]) : deadline;
    const res = await fetch(input, { ...(init || {}), signal });
    if (res.status !== 429 || i >= 4) return res;
    rpcStats.throttled++;
    const tnow = Date.now();
    thr1m.push(tnow);
    if (tnow - lastThrottle > 1000) capNow = Math.max(Math.ceil(CAP * 0.4), Math.floor(capNow * 0.8));
    lastThrottle = tnow;
    sent.push([tnow, CAP]); // everyone backs off for a second
    await new Promise((r) => setTimeout(r, 400 * 2 ** i + Math.random() * 250));
  }
}

let _c: Connection | null = null;
export function conn(): Connection {
  const injected = (globalThis as any).__rnConn; // test hook
  if (injected) return injected;
  if (_c) return _c;
  const url = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!url) throw new Error("RPC is not configured");
  _c = new Connection(url, { commitment: "confirmed", fetch: limitedFetch as any, disableRetryOnRateLimit: true });
  return _c;
}

// Never leak the RPC URL (it holds the API key) into errors shown to users.
export function safeErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/https?:\/\/\S+/g, "[rpc]").replace(/api-key=\S+/gi, "api-key=[hidden]").slice(0, 200);
}

export function isPubkey(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

const pumpPk = () => new PublicKey(PUMP_PROGRAM);

export function bondingCurvePda(mint: string): string {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], pumpPk());
  return pda.toBase58();
}

export type Curve = {
  vTok: bigint;
  vSol: bigint;
  rTok: bigint;
  rSol: bigint;
  supply: bigint;
  complete: boolean;
  solQuote: boolean;
};

const WSOL = "So11111111111111111111111111111111111111112";

export function parseCurve(data: Buffer | Uint8Array | null | undefined): Curve | null {
  if (!data || data.length < 49) return null;
  const b = Buffer.from(data);
  return {
    vTok: b.readBigUInt64LE(8),
    vSol: b.readBigUInt64LE(16),
    rTok: b.readBigUInt64LE(24),
    rSol: b.readBigUInt64LE(32),
    supply: b.readBigUInt64LE(40),
    complete: b[48] === 1,
    // Layout after `complete`: creator(32) is_mayhem(1) is_cashback(1) quote_mint(32). Zero or wSOL = SOL curve.
    solQuote: b.length < 115 || isSolQuote(b.subarray(83, 115)),
  };
}

function isSolQuote(k: Buffer) {
  if (k.every((x) => x === 0)) return true;
  try {
    return new PublicKey(k).toBase58() === WSOL;
  } catch {
    return true;
  }
}

export type CurveView = { progress: number; mcapSol: number; realSol: number; complete: boolean; priceSol: number; supply: number };

export function viewCurve(c: Curve): CurveView {
  const progress = c.complete
    ? 100
    : Math.max(0, Math.min(100, Number(((INITIAL_REAL_TOKEN_RESERVES - c.rTok) * 10000n) / INITIAL_REAL_TOKEN_RESERVES) / 100));
  const vTok = Number(c.vTok) / 1e6;
  const vSol = Number(c.vSol) / 1e9;
  const price = vTok > 0 ? vSol / vTok : 0;
  // Curves quoted in another token (e.g. USDC pairs) have no SOL market cap.
  const mcapSol = c.solQuote ? price * (Number(c.supply) / 1e6) : 0;
  return {
    progress: round2(progress),
    mcapSol: round2(mcapSol),
    realSol: c.solQuote ? round2(Number(c.rSol) / 1e9) : 0,
    complete: c.complete,
    priceSol: c.solQuote ? price : 0, // SOL per whole token
    supply: Number(c.supply) / 1e6, // whole tokens
  };
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** Fetch curves for many mints (100 per RPC call). Missing account => null. */
export async function getCurves(mints: string[]): Promise<Record<string, CurveView | null>> {
  const out: Record<string, CurveView | null> = {};
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    const pdas = chunk.map((m) => new PublicKey(bondingCurvePda(m)));
    const infos = await conn().getMultipleAccountsInfo(pdas);
    chunk.forEach((m, j) => {
      const c = parseCurve(infos[j]?.data);
      out[m] = c ? viewCurve(c) : null;
    });
  }
  return out;
}

// ---------- create tx parsing ----------

function readStr(b: Buffer, o: number): [string, number] | null {
  if (o + 4 > b.length) return null;
  const len = b.readUInt32LE(o);
  if (len > 300 || o + 4 + len > b.length) return null;
  return [b.subarray(o + 4, o + 4 + len).toString("utf8"), o + 4 + len];
}

/** Decode name/symbol/uri from a pump.fun create (or create_v2) instruction. */
function decodeCreate(dataB58: string): { name: string; symbol: string; uri: string } | null {
  try {
    const b = Buffer.from(bs58.decode(dataB58));
    if (b.length < 20) return null;
    const a = readStr(b, 8);
    if (!a) return null;
    const s = readStr(b, a[1]);
    if (!s) return null;
    const u = readStr(b, s[1]);
    if (!u) return null;
    if (!/^https?:\/\//.test(u[0]) && !u[0].startsWith("ipfs")) return null;
    return { name: a[0], symbol: s[0], uri: u[0] };
  } catch {
    return null;
  }
}

export type NewLaunch = {
  mint: string;
  sig: string;
  createdAt: number;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  devBuySol: number;
};

export function parseCreateTx(sig: string, tx: ParsedTransactionWithMeta | null): NewLaunch | null {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const logs = tx.meta.logMessages || [];
  if (!logs.some((l) => /Instruction: Create/i.test(l))) return null;

  // Find the minted token: a mint whose bonding-curve PDA holds tokens after the tx.
  const balances = tx.meta.postTokenBalances || [];
  let mint: string | null = null;
  for (const bal of balances) {
    try {
      if (bal.owner && bal.owner === bondingCurvePda(bal.mint)) {
        mint = bal.mint;
        break;
      }
    } catch {}
  }
  if (!mint) return null;

  // Name/symbol/uri from the create instruction (outer or inner).
  const ixs: any[] = [...tx.transaction.message.instructions];
  for (const inner of tx.meta.innerInstructions || []) ixs.push(...inner.instructions);
  let meta: { name: string; symbol: string; uri: string } | null = null;
  for (const ix of ixs) {
    if (ix.programId?.toBase58?.() !== PUMP_PROGRAM || typeof ix.data !== "string") continue;
    meta = decodeCreate(ix.data);
    if (meta) break;
  }

  const keys = tx.transaction.message.accountKeys;
  const creator = keys.find((k) => k.signer)?.pubkey.toBase58() || keys[0]?.pubkey.toBase58() || "";

  // Dev buy: SOL sitting in the curve after the tx, minus rent.
  let devBuySol = 0;
  const curve = bondingCurvePda(mint);
  const idx = keys.findIndex((k) => k.pubkey.toBase58() === curve);
  if (idx >= 0) {
    const post = (tx.meta.postBalances[idx] || 0) / 1e9;
    devBuySol = Math.max(0, round2(post - 0.0016));
  }

  return {
    mint,
    sig,
    createdAt: (tx.blockTime || Math.floor(Date.now() / 1000)) * 1000,
    creator,
    name: (meta?.name || "").slice(0, 64),
    symbol: (meta?.symbol || "").slice(0, 16),
    uri: meta?.uri || "",
    devBuySol,
  };
}

export type OffMeta = { description: string; twitter: string; telegram: string; website: string; image: string };

export async function fetchOffchain(uri: string, timeoutMs = 2500): Promise<OffMeta | null> {
  if (!uri) return null;
  // pump.fun's own gateway first for IPFS; the URI is chosen by the launcher, so safeFetch (public hosts, 64KB cap)
  const url = uri.startsWith("ipfs://") ? `https://pump.mypinata.cloud/ipfs/${uri.slice(7)}` : uri;
  try {
    let j: any;
    if (process.env.RATNET_SIM === "1") j = await (await fetch(url)).json(); // the simulator stubs fetch
    else {
      const { safeFetch } = await import("./safefetch");
      const g = await safeFetch(url, { timeoutMs, maxBytes: 64_000 });
      j = JSON.parse(g.buf.toString("utf8"));
    }
    if (!j || typeof j !== "object") return null;
    const s = (v: any) => (typeof v === "string" ? v.slice(0, 280) : "");
    return {
      description: s(j.description),
      twitter: s(j.twitter || j.extensions?.twitter),
      telegram: s(j.telegram || j.extensions?.telegram),
      website: s(j.website || j.extensions?.website),
      image: s(j.image),
    };
  } catch {
    return null;
  }
}

/** Helius DAS getAsset, used for sniffing coins the rats never dug. */
export async function dasAsset(mint: string): Promise<{ name: string; symbol: string; uri: string } | null> {
  const url = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!url) return null;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "rn", method: "getAsset", params: { id: mint } }),
      cache: "no-store",
    });
    const j: any = await r.json();
    const c = j?.result?.content;
    if (!c) return null;
    return { name: c.metadata?.name || "", symbol: c.metadata?.symbol || "", uri: c.json_uri || "" };
  } catch {
    return null;
  }
}

/** Run async fn over items with a concurrency limit. */
export async function pmap<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const n = i++;
        out[n] = await fn(items[n]);
      }
    })
  );
  return out;
}

// ---------- prices ----------

export async function solUsd(): Promise<number | null> {
  try {
    const cached = await redis().get<number>(K.solPrice);
    if (cached) return cached;
    const r = await fetch("https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", { cache: "no-store" });
    const j: any = await r.json();
    const p = Number(j?.So11111111111111111111111111111111111111112?.usdPrice);
    if (p > 0) {
      await redis().set(K.solPrice, p, { ex: 120 });
      return p;
    }
  } catch {}
  return null;
}

/** $RAT price in SOL: curve while bonding, Jupiter after. */
export async function ratPriceSol(mint: string): Promise<number | null> {
  if (!mint) return null;
  try {
    const cached = await redis().get<number>(K.ratPrice);
    if (cached) return cached;
    let p: number | null = null;
    const info = await conn().getAccountInfo(new PublicKey(bondingCurvePda(mint)));
    const c = parseCurve(info?.data);
    if (c && !c.complete && c.vTok > 0n) {
      p = Number(c.vSol) / 1e9 / (Number(c.vTok) / 1e6);
    } else {
      const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { cache: "no-store" });
      const j: any = await r.json();
      const usd = Number(j?.[mint]?.usdPrice);
      const sol = await solUsd();
      if (usd > 0 && sol) p = usd / sol;
    }
    if (p && p > 0) {
      await redis().set(K.ratPrice, p, { ex: 120 });
      return p;
    }
  } catch {}
  return null;
}
