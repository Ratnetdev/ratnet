// Graduation proof and fast market caps, straight from the chain.
//
// A pump.fun coin has really graduated only when its curve is complete AND it migrated into its canonical PumpSwap pool.
// That pool's address is a PDA only pump.fun's migration can create (seeds from @pump-fun/pump-sdk canonicalPumpPoolPda):
//   pool-authority = PDA(pump, ["pool-authority", mint])
//   pool           = PDA(pumpswap, ["pool", u16 0, pool-authority, mint, wSOL])
// Anyone can open other PumpSwap pools for a coin (often with a few dollars in them), so those never count, and their
// prices are never used. Market cap = pool price x supply, read from the two pool vaults: one RPC call for up to 50 coins,
// no third-party API, no indexing delay.
import { PublicKey } from "@solana/web3.js";
import { conn } from "./solana";
import { redis } from "./redis";

const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const IDX0 = Buffer.from([0, 0]);
export const POOLS_KEY = "rn:pools"; // hash mint -> { pool, bv, qv } (vault addresses never change)
// A real migration seeds the pool with the whole curve (~80 SOL). Anything far below that is not a graduation.
export const MIN_POOL_SOL = 20;

export function canonicalPool(mint: string): string {
  const m = new PublicKey(mint);
  const [auth] = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), m.toBuffer()], PUMP);
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from("pool"), IDX0, auth.toBuffer(), m.toBuffer(), WSOL.toBuffer()], PUMP_AMM);
  return pool.toBase58();
}

type Vaults = { pool: string; bv: string; qv: string; vq: number };
export type PoolRead = { pool: string; sol: number; tok: number; px: number }; // px = SOL per whole token

function parsePool(mint: string, d: Buffer | Uint8Array | undefined | null): Omit<Vaults, "pool"> | null {
  if (!d || d.length < 211) return null;
  const b = Buffer.from(d);
  if (!b.subarray(0, 8).equals(POOL_DISC)) return null;
  const base = new PublicKey(b.subarray(43, 75)).toBase58();
  const quote = new PublicKey(b.subarray(75, 107));
  if (base !== mint || !quote.equals(WSOL)) return null;
  // newer pools carry virtual quote reserves (i128 at 245); canonical migrated pools have 0, read it anyway
  let vq = 0;
  if (b.length >= 261) {
    const lo = b.readBigUInt64LE(245);
    const hi = b.readBigInt64LE(253);
    if (hi === 0n) vq = Number(lo) / 1e9;
  }
  return { bv: new PublicKey(b.subarray(139, 171)).toBase58(), qv: new PublicKey(b.subarray(171, 203)).toBase58(), vq };
}

const amountOf = (d: Buffer | Uint8Array | undefined | null) => (d && d.length >= 72 ? Number(Buffer.from(d).readBigUInt64LE(64)) : null);

async function accounts(keys: string[]) {
  const out: (Buffer | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const infos = await conn().getMultipleAccountsInfo(keys.slice(i, i + 100).map((k) => new PublicKey(k)));
    infos.forEach((x: any) => out.push(x?.data ? Buffer.from(x.data) : null));
  }
  return out;
}

/** Canonical pool reserves for many coins. null = no canonical pool (never migrated). */
export async function readPools(mints: string[]): Promise<Record<string, PoolRead | null>> {
  const uniq = Array.from(new Set(mints.filter(Boolean)));
  const out: Record<string, PoolRead | null> = {};
  if (!uniq.length) return out;
  const r = redis();
  const cached = ((await r.hmget<Record<string, Vaults>>(POOLS_KEY, ...uniq)) || {}) as Record<string, Vaults | null>;
  const vaults: Record<string, Vaults> = {};
  const missing = uniq.filter((m) => {
    const v = cached?.[m];
    if (v && v.bv) vaults[m] = v;
    return !(v && v.bv);
  });
  if (missing.length) {
    const pools = missing.map(canonicalPool);
    const datas = await accounts(pools);
    const save: Record<string, Vaults> = {};
    missing.forEach((m, i) => {
      const v = parsePool(m, datas[i]);
      if (v) vaults[m] = save[m] = { pool: pools[i], ...v };
    });
    if (Object.keys(save).length) await r.hset(POOLS_KEY, save);
  }
  const found = uniq.filter((m) => vaults[m]);
  for (const m of uniq) out[m] = null;
  if (!found.length) return out;
  const datas = await accounts(found.flatMap((m) => [vaults[m].bv, vaults[m].qv]));
  found.forEach((m, i) => {
    const b = amountOf(datas[2 * i]);
    const q = amountOf(datas[2 * i + 1]);
    if (b == null || q == null || b <= 0) return;
    const tok = b / 1e6;
    const sol = q / 1e9;
    out[m] = { pool: vaults[m].pool, sol, tok, px: (sol + (vaults[m].vq || 0)) / tok };
  });
  return out;
}

/** USD market cap from a pool read. pump.fun supply is 1B tokens unless the curve said otherwise. */
export function poolUsd(p: PoolRead | null | undefined, solUsd: number, supply = 1e9) {
  return p && solUsd ? p.px * supply * solUsd : 0;
}

/**
 * True graduation: the canonical pool exists. Only pump.fun's migration can create that PDA, so existence is the proof.
 * Before v0.1.28 it also had to hold 20 SOL: a coin dumped hard right after migrating was then counted as "never
 * migrated" and labelled DIED, so the models learned some of the fastest bonds as losers.
 */
export const migrated = (p: PoolRead | null | undefined) => !!p;
