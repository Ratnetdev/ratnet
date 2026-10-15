// v0.1.81: FIREHOSE (Shyft gRPC), pump.fun/PumpSwap event decoding, WALLETS, TAPE ALL, new GRID filters.
// Events are encoded here byte by byte in the order of pump.fun's published IDL. Run: npx tsx sim/v081test.ts
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
// ---- a tiny Borsh writer
class W {
  b: number[] = [];
  disc(d: number[]) { this.b.push(...d); return this; }
  pk(s: string) { this.b.push(...bs58.decode(s)); return this; }
  u64(v: bigint | number) { let x = BigInt(v); for (let i = 0; i < 8; i++) { this.b.push(Number(x & 0xffn)); x >>= 8n; } return this; }
  i64(v: number) { return this.u64(BigInt(v) & 0xffffffffffffffffn); }
  i128(v: bigint) { let x = v & ((1n << 128n) - 1n); for (let i = 0; i < 16; i++) { this.b.push(Number(x & 0xffn)); x >>= 8n; } return this; }
  u32(v: number) { this.b.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); return this; }
  u16(v: number) { this.b.push(v & 255, (v >> 8) & 255); return this; }
  u8(v: number) { this.b.push(v & 255); return this; }
  bool(v: boolean) { return this.u8(v ? 1 : 0); }
  str(s: string) { const e = Buffer.from(s, "utf8"); this.u32(e.length); this.b.push(...e); return this; }
  out() { return Uint8Array.from(this.b); }
}
const pk = () => Keypair.generate().publicKey.toBase58();
const WSOL = "So11111111111111111111111111111111111111112";
const TRADE = [189, 219, 127, 211, 78, 230, 97, 238];
const CREATE = [27, 114, 169, 77, 222, 235, 99, 118];
const COMPLETE = [95, 114, 97, 156, 212, 46, 152, 8];
const BUY = [103, 244, 82, 31, 44, 245, 119, 119];
const CPOOL = [177, 49, 12, 210, 160, 118, 167, 116];
const TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
function trade(o: { mint: string; user: string; isBuy: boolean; sol: bigint; tokens: bigint; vSol: bigint; vTok: bigint; rSol: bigint; rTok: bigint; creator: string; quote?: string; full?: boolean }) {
  const w = new W().disc(TRADE).pk(o.mint).u64(o.sol).u64(o.tokens).bool(o.isBuy).pk(o.user).i64(1_790_000_000).u64(o.vSol).u64(o.vTok).u64(o.rSol).u64(o.rTok);
  if (o.full === false) return w.out();
  w.pk(pk()).u64(95).u64(1000).pk(o.creator).u64(30).u64(300).bool(true).u64(0).u64(0).u64(0).i64(0).str("buy").bool(false).u64(0).u64(0).u64(0).u64(0);
  w.u32(2).pk(pk()).u16(5000).pk(pk()).u16(5000); // shareholders
  w.pk(o.quote ?? "11111111111111111111111111111111").u64(0).u64(0).u64(0).u64(0).u64(0).u64(0);
  return w.out();
}
(async () => {
  const PE = await import("../src/lib/pumpevents");
  const FH = await import("../src/lib/firehose");
  const WL = await import("../src/lib/wallets");
  const TA = await import("../src/lib/tapeall");
  const SOL = await import("../src/lib/solana");
  const fs = await import("fs");

  // ---- decoding
  const mint = pk(), user = pk(), creator = pk();
  const base = { mint, user, isBuy: true, sol: 1_500_000_000n, tokens: 35_000_000_000_000n, vSol: 60_000_000_000n, vTok: 536_666_666_666_666n, rSol: 30_000_000_000n, rTok: 256_766_666_666_666n, creator };
  const ev = PE.decodeEvent(trade(base)) as any;
  ok(ev?.kind === "trade" && ev.mint === mint && ev.user === user && ev.isBuy && ev.sol === 1_500_000_000n && ev.creator === creator && PE.isSolQuote(ev.quoteMint), "TradeEvent: every field in IDL order, through the shareholder list to the quote mint");
  const short = PE.decodeEvent(trade({ ...base, full: false })) as any;
  ok(short?.kind === "trade" && short.mint === mint && short.creator == null, "an older, shorter TradeEvent still decodes (what it carries)");
  const usdc = PE.decodeEvent(trade({ ...base, quote: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })) as any;
  ok(!PE.isSolQuote(usdc.quoteMint), "a curve quoted in another token is recognised (no SOL price from it)");
  // the curve matches lib/solana.ts viewCurve on the same reserves
  const cv = PE.curveOf(ev);
  const ref = SOL.viewCurve({ vTok: base.vTok, vSol: base.vSol, rTok: base.rTok, rSol: base.rSol, supply: 1_000_000_000_000_000n, complete: false, solQuote: true } as any);
  ok(Math.abs(cv.progress - ref.progress) < 0.02 && Math.abs(cv.mcapSol - ref.mcapSol) < 0.02 && cv.realSol === ref.realSol, `curve view = the rats' own (progress ${cv.progress}%, ${cv.mcapSol} SOL mc)`);
  // both delivery paths, each event once
  const tb = trade(base);
  const b64 = Buffer.from(tb).toString("base64");
  const both = PE.eventsOf([`Program log: Instruction: Buy`, `Program data: ${b64}`], [{ data: Uint8Array.from([...TAG, ...tb]) }]);
  ok(both.length === 1, "an event in the logs and as a self-CPI instruction counts once");
  ok(PE.eventsOf([], [{ data: Uint8Array.from([...TAG, ...trade(base)]) }]).length === 1, "self-CPI events alone are read");
  const cre = PE.decodeEvent(new W().disc(CREATE).str("Stream").str("STREAM").str("ipfs://x").pk(mint).pk(pk()).pk(user).pk(creator).i64(1_790_000_000).u64(1n).u64(1n).u64(1n).u64(1_000_000_000_000_000n).out()) as any;
  ok(cre?.kind === "create" && cre.symbol === "STREAM" && cre.creator === creator && cre.supply === 1_000_000_000_000_000n, "CreateEvent");
  const comp = PE.decodeEvent(new W().disc(COMPLETE).pk(user).pk(mint).pk(pk()).i64(1_790_000_100).out()) as any;
  ok(comp?.kind === "complete" && comp.mint === mint, "CompleteEvent");
  const pool = pk();
  const buy = new W().disc(BUY).i64(1_790_000_200).u64(10_000_000_000n).u64(0).u64(0).u64(0).u64(200_000_000_000_000n).u64(85_000_000_000n).u64(4_300_000_000n).u64(0).u64(0).u64(0).u64(0).u64(0).u64(0).pk(pool).pk(user).pk(pk()).pk(pk()).pk(pk()).pk(pk()).pk(creator).out();
  const sw = PE.decodeEvent(buy) as any;
  ok(sw?.kind === "swap" && sw.isBuy && sw.pool === pool && sw.user === user && sw.creator === creator && sw.poolQuote === 85_000_000_000n, "PumpSwap BuyEvent");
  const cp = PE.decodeEvent(new W().disc(CPOOL).i64(1).u16(0).pk(creator).pk(mint).pk(WSOL).u8(6).u8(9).u64(0).u64(0).u64(206_900_000_000_000n).u64(84_990_000_000n).u64(0).u64(0).u64(0).u8(255).pk(pool).out()) as any;
  ok(cp?.kind === "createPool" && cp.baseMint === mint && cp.pool === pool, "PumpSwap CreatePoolEvent");

  // ---- what the worker gets
  const got: any = { trades: [], curves: [], pools: [], creates: [], completes: [] };
  const h = { trade: (t: any) => got.trades.push(t), curve: (m: string, v: any) => got.curves.push([m, v]), pool: (m: string, q: any) => got.pools.push([m, q]), create: (c: any) => got.creates.push(c), complete: (m: string) => got.completes.push(m) };
  FH.handleTx([ev], [], h);
  ok(got.trades[0]?.venue === "curve" && got.trades[0].sol === 1.5 && got.trades[0].prog === cv.progress && got.curves[0][0] === mint, "a curve trade: the trade (with its curve %) and the curve update");
  FH.handleTx([usdc], [], h);
  ok(got.trades.length === 1, "non-SOL curves are skipped");
  // v0.1.82: the price is read after the swap (reserves before it + what moved) and only from the coin's canonical pool
  const mint2 = pk();
  const { canonicalPool } = await import("../src/lib/pool");
  const pool2 = canonicalPool(mint2);
  const buy2 = PE.decodeEvent(new W().disc(BUY).i64(1_790_000_200).u64(10_000_000_000n).u64(0).u64(0).u64(0).u64(200_000_000_000_000n).u64(85_000_000_000n).u64(4_300_000_000n).u64(0).u64(0).u64(0).u64(0).u64(4_300_000_000n).u64(0).pk(pool2).pk(user).pk(pk()).pk(pk()).pk(pk()).pk(pk()).pk(creator).out()) as any;
  FH.handleTx([buy2], [WSOL, mint2, WSOL], h);
  ok(got.trades[1]?.venue === "pool" && got.trades[1].mint === mint2 && got.pools[0][0] === mint2 && Math.abs(got.pools[0][1].mcSol - 446.52) < 0.01 && got.pools[0][1].real === 89.3, "a PumpSwap trade: its coin found from the transaction, pool price after the swap 446.52 SOL mc, 89.3 SOL in the pool");
  FH.handleTx([cp], [], h);
  FH.handleTx([sw], [WSOL, pk(), pk()], h);
  ok(got.trades[2]?.mint === mint, "a pool created on the stream is mapped to its coin (even when the transaction holds other tokens)");
  ok(!(await FH.startFirehose(h)), "without SHYFT_GRPC_URL and SHYFT_GRPC_TOKEN the firehose stays off");

  // ---- WALLETS
  WL._walletsReset();
  const smart = pk();
  const t0 = 1_900_000_000_000;
  const coins = Array.from({ length: 10 }, () => pk());
  coins.forEach((m, i) => {
    WL.walletCreate(m, creator, t0 + i);
    WL.walletTrade({ mint: m, user: smart, isBuy: true, sol: 0.5, at: t0 + i, venue: "curve" }, 12);
    WL.walletTrade({ mint: m, user: creator, isBuy: true, sol: 2, at: t0 + i, venue: "curve" }, 12); // the dev: never scored
    WL.walletTrade({ mint: m, user: pk(), isBuy: true, sol: 0.5, at: t0 + i, venue: "curve" }, 45); // late: not early
  });
  coins.slice(0, 7).forEach((m) => WL.walletComplete(m, t0 + 3600_000));
  WL.walletSweep(t0 + 4 * 3600_000);
  const st = WL._walletStat(smart)!;
  ok(st.n === 10 && st.hits === 7, "early buyer scored on 10 coins: 7 migrated, 3 missed (3 hours, no migration)");
  ok(!WL._walletStat(creator), "the dev is never scored as a buyer");
  ok(WL.isProven(smart), "7 of 10: proven (lower bound well above 3x the base rate)");
  const fresh = pk();
  WL.walletCreate(fresh, creator, t0 + 5 * 3600_000);
  WL.walletTrade({ mint: fresh, user: smart, isBuy: true, sol: 0.3, at: t0 + 5 * 3600_000, venue: "curve" }, 60);
  ok(WL.provenBuyers(fresh) === 1, "a proven wallet buying a new coin is counted on it (any curve %)");
  const v = WL.walletsView();
  ok(v.proven === 1 && v.top[0].n === 10 && !/^[1-9A-HJ-NP-Za-km-z]{32,}$/.test(v.top[0].w), "view: proven count and the top list (addresses shortened)");

  // ---- TAPE ALL
  TA._tapeReset();
  const m3 = pk();
  TA.tapeCreate(m3, creator);
  const now = t0 + 10_000;
  for (let i = 0; i < 30; i++) TA.tapeTrade({ mint: m3, user: pk(), isBuy: true, sol: i === 0 ? 2.5 : 0.2, at: now - 30_000 + i * 500 });
  TA.tapeTrade({ mint: m3, user: pk(), isBuy: false, sol: 1, at: now - 5_000 });
  TA.tapeTrade({ mint: m3, user: creator, isBuy: false, sol: 0.5, at: now - 4_000 });
  const f = TA.tapeFeatures(m3, now);
  ok(f.u60 === 30 && f.wh === 1 && f.ds && f.bs60 === 0.85, `last minute: 30 buyers, one 2+ SOL buy, dev sold, ${Math.round((f.bs60 ?? 0) * 100)}% of SOL buying`);
  TA.tapeSweep(now + 200_000);
  ok(TA.tapeSize() === 0, "coins that stopped trading are forgotten");

  // ---- GRID and the wiring
  const g = await import("../src/lib/grid");
  const ids = g.PREDS.map((p) => p.id);
  ok(["pw1", "pw2", "u25", "bs70", "wh"].every((x) => ids.includes(x)), "GRID filters: proven wallets, buyers, buy share, whales");
  const c0: any = { pw: null, u60: null, bs60: null, wh: null };
  ok(g.PREDS.filter((p) => ["pw1", "pw2", "u25", "bs70", "wh"].includes(p.id)).every((p) => !p.ok(c0)), "unknown (no firehose then) never passes");
  const gs = fs.readFileSync(new URL("../src/lib/grid.ts", import.meta.url), "utf8");
  ok(/pw: num\(tp\.pw\),\n\s+u60: num\(tp\.u60\),\n\s+bs60: num\(tp\.bs60\),\n\s+wh: num\(tp\.wh\),/.test(gs), "GRID reads them from history (stored with every call)");
  const dg = fs.readFileSync(new URL("../src/lib/digger.ts", import.meta.url), "utf8");
  ok(/const fx = TAPE_EXTRA \?/.test(dg) && /\.\.\.\(fx \|\| \{\}\)/.test(dg), "every King call stores the firehose read with it");
  const gl = fs.readFileSync(new URL("../src/lib/gridlive.ts", import.meta.url), "utf8");
  ok(/"pw1", "pw2", "u25", "bs70", "wh"\]\); \/\/ v0\.1\.81/.test(gl) && /const fx = LIVE_FX \? LIVE_FX\(mint\) : null;/.test(gl), "every-launch books can use them live");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/if \(!fireLive\(\)\) gridLiveCurve\(mint, v as any\);/.test(wk) && /curve: \(mint, v\) => gridLiveCurve\(mint, v as any\)/.test(wk), "GRID LIVE is fed by the firehose when it is up (the old streams when it is not), never twice");
  ok(/walletsSave\(archivePool\(\)\)/.test(wk) && /walletsLoad\(archivePool\(\)\)/.test(wk), "wallet scores saved to and loaded from Postgres");
  const ar = fs.readFileSync(new URL("../src/lib/archive.ts", import.meta.url), "utf8");
  ok(/create table if not exists wallet_scores \(wallet text primary key/.test(ar), "archive table wallet_scores");
  // Postgres round trip (in-memory)
  const { newDb } = await import("pg-mem");
  const db = newDb();
  db.public.none(`create table wallet_scores (wallet text primary key, n integer not null, hits integer not null, sol real, updated_at timestamptz not null default now());`);
  const { Pool } = db.adapters.createPg();
  const pg = new Pool();
  const saved = await WL.walletsSave(pg);
  WL._walletsReset();
  const loaded = await WL.walletsLoad(pg);
  ok(saved >= 1 && loaded >= 1 && WL._walletStat(smart)?.hits === 7, `scores survive a restart (${saved} saved, ${loaded} loaded)`);

  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
