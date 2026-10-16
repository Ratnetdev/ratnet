// v0.1.81: pump.fun and PumpSwap events, decoded from the programs' own published IDL (pump-fun/pump-public-docs,
// idl/pump.json and idl/pump_amm.json). Anchor events reach us two ways: "Program data: <base64>" log lines and
// self-CPI instructions (8-byte event tag + the event). Both are read; fields are read in IDL order, and anything an
// older (shorter) event does not carry is simply left out.
import bs58 from "bs58";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_PK = "11111111111111111111111111111111";

const D = {
  trade: [189, 219, 127, 211, 78, 230, 97, 238],
  create: [27, 114, 169, 77, 222, 235, 99, 118],
  complete: [95, 114, 97, 156, 212, 46, 152, 8],
  buy: [103, 244, 82, 31, 44, 245, 119, 119],
  sell: [62, 47, 55, 10, 165, 3, 220, 42],
  createPool: [177, 49, 12, 210, 160, 118, 167, 116],
};
export const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
const same = (b: Uint8Array, o: number, d: number[]) => d.every((x, i) => b[o + i] === x);

/** A sequential little-endian reader that never throws past the end (an older, shorter event): it marks `short`. */
class R {
  o = 0;
  short = false;
  constructor(private b: Uint8Array) {}
  private need(n: number) {
    if (this.o + n > this.b.length) {
      this.short = true;
      return false;
    }
    return true;
  }
  pk() {
    if (!this.need(32)) return "";
    const s = bs58.encode(this.b.subarray(this.o, this.o + 32));
    this.o += 32;
    return s;
  }
  u64() {
    if (!this.need(8)) return 0n;
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(this.b[this.o + i]);
    this.o += 8;
    return v;
  }
  i64() {
    const v = this.u64();
    return v >= 1n << 63n ? v - (1n << 64n) : v;
  }
  i128() {
    if (!this.need(16)) return 0n;
    let v = 0n;
    for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(this.b[this.o + i]);
    this.o += 16;
    return v >= 1n << 127n ? v - (1n << 128n) : v;
  }
  u16() {
    if (!this.need(2)) return 0;
    const v = this.b[this.o] | (this.b[this.o + 1] << 8);
    this.o += 2;
    return v;
  }
  u8() {
    if (!this.need(1)) return 0;
    return this.b[this.o++];
  }
  bool() {
    return this.u8() === 1;
  }
  u32() {
    if (!this.need(4)) return 0;
    const v = this.b[this.o] | (this.b[this.o + 1] << 8) | (this.b[this.o + 2] << 16) | (this.b[this.o + 3] * 2 ** 24);
    this.o += 4;
    return v >>> 0;
  }
  str() {
    const n = this.u32();
    if (n > 4096 || !this.need(n)) return "";
    const s = Buffer.from(this.b.subarray(this.o, this.o + n)).toString("utf8");
    this.o += n;
    return s;
  }
}

export type TradeEv = {
  kind: "trade";
  mint: string;
  sol: bigint; // lamports
  tokens: bigint; // raw (6 decimals)
  isBuy: boolean;
  user: string;
  ts: number; // seconds
  vSol: bigint;
  vTok: bigint;
  rSol: bigint;
  rTok: bigint;
  creator?: string;
  quoteMint?: string; // SOL when missing or the default key
};
export type CreateEv = { kind: "create"; name: string; symbol: string; uri: string; mint: string; curve: string; user: string; creator: string; ts: number; supply?: bigint; quoteMint?: string };
export type CompleteEv = { kind: "complete"; user: string; mint: string; curve: string; ts: number };
export type SwapEv = {
  kind: "swap";
  isBuy: boolean;
  ts: number;
  base: bigint; // raw base tokens moved
  quote: bigint; // lamports moved (to/from the user, before the user's own fees)
  poolBase: bigint; // pool reserves BEFORE the swap (checked against the vaults' balances on mainnet, 16 Oct)
  poolQuote: bigint;
  /** v0.1.82: lamports the quote vault gained (buy: quote_amount_in_with_lp_fee) or lost (sell:
   *  quote_amount_out_without_lp_fee). Matched the vault's balance change exactly on mainnet transactions. */
  vaultQuote: bigint;
  /** v0.1.82: virtual quote reserves (lamports): part of the price on boosted pools (17.5 SOL on the pools checked) */
  vq?: bigint;
  pool: string;
  user: string;
  creator?: string;
  supply?: bigint;
};
/** v0.1.82: a pool's reserves AFTER the swap: base tokens (raw), real quote (lamports), virtual quote (lamports). */
export function poolAfter(s: SwapEv) {
  const base = s.isBuy ? s.poolBase - s.base : s.poolBase + s.base;
  const quote = s.isBuy ? s.poolQuote + s.vaultQuote : s.poolQuote - s.vaultQuote;
  return { base, quote, vq: s.vq && s.vq > 0n ? s.vq : 0n };
}
export type CreatePoolEv = { kind: "createPool"; ts: number; creator: string; baseMint: string; quoteMint: string; poolBase: bigint; poolQuote: bigint; pool: string };
export type PumpEv = TradeEv | CreateEv | CompleteEv | SwapEv | CreatePoolEv;

/** One event (8-byte discriminator + fields). Unknown discriminators return null. */
export function decodeEvent(b: Uint8Array): PumpEv | null {
  if (b.length < 8) return null;
  const r = new R(b);
  r.o = 8;
  if (same(b, 0, D.trade)) {
    const ev: TradeEv = { kind: "trade", mint: r.pk(), sol: r.u64(), tokens: r.u64(), isBuy: r.bool(), user: r.pk(), ts: Number(r.i64()), vSol: r.u64(), vTok: r.u64(), rSol: r.u64(), rTok: r.u64() };
    if (r.short) return ev.mint && ev.user ? ev : null;
    r.pk(); // fee_recipient
    r.u64(); // fee_basis_points
    r.u64(); // fee
    const creator = r.pk();
    if (!r.short) ev.creator = creator;
    r.u64(); // creator_fee_basis_points
    r.u64(); // creator_fee
    r.bool(); // track_volume
    r.u64(); // total_unclaimed_tokens
    r.u64(); // total_claimed_tokens
    r.u64(); // current_sol_volume
    r.i64(); // last_update_timestamp
    r.str(); // ix_name
    r.bool(); // mayhem_mode
    r.u64(); // cashback_fee_basis_points
    r.u64(); // cashback
    r.u64(); // buyback_fee_basis_points
    r.u64(); // buyback_fee
    const n = r.u32(); // shareholders: Vec<{ address: pubkey, share_bps: u16 }>
    if (!r.short && n <= 64) for (let i = 0; i < n; i++) (r.pk(), r.u16());
    const qm = r.pk();
    if (!r.short && qm) ev.quoteMint = qm;
    return ev;
  }
  if (same(b, 0, D.create)) {
    const ev: CreateEv = { kind: "create", name: r.str(), symbol: r.str(), uri: r.str(), mint: r.pk(), curve: r.pk(), user: r.pk(), creator: r.pk(), ts: Number(r.i64()) };
    r.u64(); // virtual_token_reserves
    r.u64(); // virtual_sol_reserves
    r.u64(); // real_token_reserves
    const sup = r.u64();
    if (!r.short) ev.supply = sup;
    // v0.1.87: pump.fun curves can be quoted in another token now (ZEC, PUMP: $ZECRET on 16 Oct was called BOND at a
    // 63.7% curve with an empty tape, its trades were never in SOL). token_program, is_mayhem_mode,
    // is_cashback_enabled, then quote_mint (missing on older creates = SOL)
    r.pk();
    r.bool();
    r.bool();
    const qm = r.pk();
    if (!r.short && qm) ev.quoteMint = qm;
    return ev.mint ? ev : null;
  }
  if (same(b, 0, D.complete)) {
    const ev: CompleteEv = { kind: "complete", user: r.pk(), mint: r.pk(), curve: r.pk(), ts: Number(r.i64()) };
    return ev.mint ? ev : null;
  }
  if (same(b, 0, D.buy) || same(b, 0, D.sell)) {
    const isBuy = same(b, 0, D.buy);
    const ts = Number(r.i64());
    const base = r.u64(); // base_amount_out (buy) / base_amount_in (sell)
    r.u64(); // max_quote_amount_in / min_quote_amount_out
    r.u64(); // user_base_token_reserves
    r.u64(); // user_quote_token_reserves
    const poolBase = r.u64();
    const poolQuote = r.u64();
    const quote = r.u64(); // quote_amount_in / quote_amount_out
    r.u64(); // lp_fee_basis_points
    r.u64(); // lp_fee
    r.u64(); // protocol_fee_basis_points
    r.u64(); // protocol_fee
    const vaultQuote = r.u64(); // quote_amount_in_with_lp_fee / quote_amount_out_without_lp_fee
    r.u64(); // user_quote_amount_in / user_quote_amount_out
    const pool = r.pk();
    const user = r.pk();
    const ev: SwapEv = { kind: "swap", isBuy, ts, base, quote, poolBase, poolQuote, vaultQuote, pool, user };
    if (r.short) return pool && user ? ev : null;
    r.pk(); // user_base_token_account
    r.pk(); // user_quote_token_account
    r.pk(); // protocol_fee_recipient
    r.pk(); // protocol_fee_recipient_token_account
    const cc = r.pk();
    if (!r.short) ev.creator = cc;
    // v0.1.82: on to virtual_quote_reserves (IDL order; the buy carries more fields before it than the sell)
    r.u64(); // coin_creator_fee_basis_points
    r.u64(); // coin_creator_fee
    if (isBuy) {
      r.bool(); // track_volume
      r.u64(); // total_unclaimed_tokens
      r.u64(); // total_claimed_tokens
      r.u64(); // current_sol_volume
      r.i64(); // last_update_timestamp
      r.u64(); // min_base_amount_out
      r.str(); // ix_name
    }
    r.u64(); // cashback_fee_basis_points
    r.u64(); // cashback
    r.u64(); // buyback_fee_basis_points
    r.u64(); // buyback_fee
    const vq = r.i128();
    r.bool(); // can_boost
    const sup = r.u64(); // base_supply
    if (!r.short) {
      ev.vq = vq;
      ev.supply = sup;
    }
    return ev;
  }
  if (same(b, 0, D.createPool)) {
    const ts = Number(r.i64());
    r.u16(); // index
    const creator = r.pk();
    const baseMint = r.pk();
    const quoteMint = r.pk();
    r.u8(); // base_mint_decimals
    r.u8(); // quote_mint_decimals
    r.u64(); // base_amount_in
    r.u64(); // quote_amount_in
    const poolBase = r.u64();
    const poolQuote = r.u64();
    r.u64(); // minimum_liquidity
    r.u64(); // initial_liquidity
    r.u64(); // lp_token_amount_out
    r.u8(); // pool_bump
    const pool = r.pk();
    return pool && baseMint ? { kind: "createPool", ts, creator, baseMint, quoteMint, poolBase, poolQuote, pool } : null;
  }
  return null;
}

/** Every event in a transaction: log lines and self-CPI event instructions, each event once. */
export function eventsOf(logs: string[] | undefined, inner: { data: Uint8Array }[] = []): PumpEv[] {
  const out: PumpEv[] = [];
  const seen = new Set<string>();
  const push = (b: Uint8Array) => {
    const k = Buffer.from(b).toString("base64");
    if (seen.has(k)) return;
    seen.add(k);
    const ev = decodeEvent(b);
    if (ev) out.push(ev);
  };
  for (const l of logs || []) {
    if (!l.startsWith("Program data: ")) continue;
    try {
      push(Buffer.from(l.slice(14), "base64"));
    } catch {}
  }
  for (const ix of inner) {
    const d = ix?.data;
    if (d && d.length > 16 && same(d, 0, EVENT_IX_TAG)) push(d.subarray(8));
  }
  return out;
}

export const isSolQuote = (m?: string) => !m || m === WSOL_MINT || m === DEFAULT_PK;
const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
/** The curve after a trade, in the same terms as lib/solana.ts viewCurve (progress %, market cap in SOL, real SOL). */
export function curveOf(ev: TradeEv, supplyTokens = 1e9) {
  const vTok = Number(ev.vTok) / 1e6;
  const vSol = Number(ev.vSol) / 1e9;
  const price = vTok > 0 ? vSol / vTok : 0;
  const sol = isSolQuote(ev.quoteMint);
  const progress = Math.max(0, Math.min(100, Number(((INITIAL_REAL_TOKEN_RESERVES - ev.rTok) * 10000n) / INITIAL_REAL_TOKEN_RESERVES) / 100));
  const complete = ev.rTok === 0n;
  return {
    progress: complete ? 100 : Math.round(progress * 100) / 100,
    mcapSol: sol ? Math.round(price * supplyTokens * 100) / 100 : 0,
    realSol: sol ? Math.round((Number(ev.rSol) / 1e9) * 100) / 100 : 0,
    complete,
    priceSol: sol ? price : 0,
    supply: supplyTokens,
  };
}
