// v0.1.82: GRID LIVE keeps strategies close to the exam, the firehose answers curve and pool reads (and is checked
// against two real PumpSwap transactions), the rats' tapes come from the firehose, WALLETS saves deltas, the Dune
// backfill, RESEARCHER. Run: npx tsx sim/v082test.ts
import { Keypair } from "@solana/web3.js";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const pk = () => Keypair.generate().publicKey.toBase58();
(async () => {
  const fs = await import("fs");
  const L = await import("../src/lib/gridlive");
  const g = await import("../src/lib/grid");

  // ================================================================ 1. GRID LIVE: close to the exam keeps trading
  const st = (o: any) => ({ n: 0, wins: 0, winRate: 0, avgPct: 0, pnl: 0, pfLessBest: 0, passed: false, ...o });
  ok(L.dropReason(st({ n: 30, wins: 14, winRate: 47, avgPct: 13.8, pnl: 0.2187, pfLessBest: 1.19, total: 30 })) === null, "the hot strategy at 30 trips (47% won, +0.219 SOL, PF 1.19) keeps trading");
  ok(/30 trips without passing/.test(String(L.dropReason(st({ n: 30, wins: 10, winRate: 33, avgPct: 2, pnl: 0.05, pfLessBest: 1.1, total: 30 })))), "under 40% won at 30: dropped as before");
  ok(/30 trips without passing/.test(String(L.dropReason(st({ n: 30, wins: 13, winRate: 43, avgPct: -1, pnl: -0.01, pfLessBest: 0.95, total: 30 })))), "losing at 30: dropped as before");
  ok(/60 trips without passing/.test(String(L.dropReason(st({ n: 30, wins: 14, winRate: 47, avgPct: 5, pnl: 0.08, pfLessBest: 1.1, total: 60 })))), "60 trips in total: dropped");
  // past 30 trips, passing also needs every trip together in profit
  const tr = (k: string, pnl: number, i: number) => ({ k, mint: `m${i}`, symbol: "X", openedAt: i, closedAt: i + 1, pnl, pnlPct: (pnl / 0.0525) * 100, why: "t" });
  const goodLast30 = Array.from({ length: 30 }, (_, i) => tr("k", i % 2 ? 0.02 : -0.006, i));
  const lp = L.liveStat(goodLast30);
  ok(lp.passed && lp.total === 30, `30 good trips pass (${lp.winRate}% won, +${lp.pnl} SOL, PF ${lp.pfLessBest})`);
  const badStart = [...goodLast30, ...Array.from({ length: 15 }, (_, i) => tr("k", -0.04, 100 + i))];
  const ls = L.liveStat(badStart);
  ok(!ls.passed && ls.n === 30 && ls.total === 45 && (ls.totalPnl ?? 0) < 0, "the same last 30 after a losing start: no pass (negative over all 45)");

  // revive: the hot strategy dropped at 30 under v0.1.81 comes back, from its key alone
  L.gridLiveReset();
  const exit = { initials: 1.5, trail: 0.25, stop: 0.25, timeMin: 60, mig: "hold" as const };
  const hotKey = g.keyOf("p70+r5", "now", exit);
  const b = L.bookFromKey(hotKey, 5);
  ok(!!b && b.label === "curve 70%+ (near migration) + curve +5 pts in the minute before, buy at the call" && b.filter === "p70+r5" && b.mode === "now" && JSON.stringify(b.exit) === JSON.stringify(exit) && b.grid.explore === true, "a book rebuilt from its key: GRID's own label, entry and exit, exploring (45 trips)");
  ok(L.bookFromKey(`any:${hotKey}`, 5) === null && L.bookFromKey("zz|now|1.5/0.25/0.25/60/hold", 5) === null && L.bookFromKey("p70|nope|1.5/0.25/0.25/60/hold", 5) === null, "never a twin, an unknown rule or an unknown entry");
  // the hot strategy's real record on 15 Oct: 30 trips, 14 won, +0.2187 SOL
  // 14 wins (one 3x runner) and 16 losses: +0.2187 SOL, PF 1.19 without the best trade
  const hot = Array.from({ length: 30 }, (_, i) => tr(hotKey, i === 0 ? 0.15 : i < 14 ? 0.0331 : -0.0226, i));
  const cold = Array.from({ length: 30 }, (_, i) => tr("bond|now|2/0.25/0.25/15/sell", -0.01, 200 + i));
  const young = Array.from({ length: 12 }, (_, i) => tr("p15|now|2/0.25/0.25/15/sell", 0.01, 300 + i));
  L._setTrips([...hot, ...cold, ...young] as any);
  const hs = L.liveStat(hot);
  ok(hs.winRate === 47 && Math.abs(hs.pnl - 0.2187) < 0.001 && hs.pfLessBest === 1.19 && !hs.passed, `the hot record: ${hs.winRate}% won, +${hs.pnl} SOL, PF ${hs.pfLessBest}, not passed`);
  const msgs: string[] = [];
  const t1 = await L.gridLiveTend(async (t) => msgs.push(t));
  // v0.1.85: the young one (12 trips, in profit, nothing against it) comes back too; the cold one never
  ok(t1.revived.length === 2 && t1.revived[0] === hotKey && t1.revived[1] === "p15|now|2/0.25/0.25/15/sell", "gridLiveTend brings back the hot strategy and the young one in profit (never the cold one)");
  ok(msgs.some((m) => /back in the race/.test(m)), "Telegram says so");
  const t2 = await L.gridLiveTend(async (t) => msgs.push(t));
  ok(t2.revived.length === 0 && L.gridLiveBooks().filter((x) => x.key === hotKey).length === 1, "once (it is trading again)");

  // ================================================================ 2. PumpSwap events against mainnet
  const PE = await import("../src/lib/pumpevents");
  const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/pumpswap-mainnet.json", import.meta.url), "utf8"));
  for (const e of fx.events) {
    const ev: any = PE.decodeEvent(Uint8Array.from(Buffer.from(e.hex, "hex")));
    const a = PE.poolAfter(ev);
    ok(ev?.kind === "swap" && ev.isBuy === e.isBuy && String(ev.poolBase) === e.vaultsBefore.base && String(ev.poolQuote) === e.vaultsBefore.quote, `${e.isBuy ? "buy" : "sell"}: the event's pool reserves are the vaults BEFORE the swap`);
    ok(String(a.base) === e.vaultsAfter.base && String(a.quote) === e.vaultsAfter.quote, `${e.isBuy ? "buy" : "sell"}: reserves after the swap match the vaults after it exactly`);
    ok(String(ev.vq) === e.vq && String(ev.supply) === e.supply, `${e.isBuy ? "buy" : "sell"}: virtual quote reserves (${(Number(e.vq) / 1e9).toFixed(2)} SOL) and supply read`);
  }

  // ================================================================ 3. the firehose's state cache
  const FC = await import("../src/lib/firecache");
  const FH = await import("../src/lib/firehose");
  const { canonicalPool } = await import("../src/lib/pool");
  FC._fcReset();
  const m1 = pk();
  const cv = { progress: 40, mcapSol: 80, realSol: 20, complete: false, priceSol: 8e-8, supply: 1e9 };
  ok(!FC.fcCurveTrade(m1, cv, 5) || FC.fcCurve(m1) === null, "nothing is trusted before the firehose connects");
  FC.fcConnected(Date.now());
  FC.fcCurveTrade(m1, cv, 10);
  ok(FC.fcCurve(m1)?.progress === 40, "a trade on this connection answers the coin's curve");
  FC.fcCurveTrade(m1, { ...cv, progress: 35 }, 9);
  ok(FC.fcCurve(m1)?.progress === 40, "an older transaction never overwrites a newer one");
  FC.fcCurveTrade(m1, { ...cv, progress: 45 }, 11);
  ok(FC.fcCurve(m1)?.progress === 45, "a newer one does");
  // v0.1.85: a curve stays exact until its next trade (10 minutes at most, a guard against a missed message)
  const fut = Date.now() + FC.MAX_AGE_MS + 1;
  FC.fcBeat(fut);
  ok(FC.fcCurve(m1, fut) !== null, "quiet for over 60s: a curve is still trusted (it only changes with a trade)");
  const fut2 = Date.now() + FC.CURVE_MAX_AGE_MS + 1;
  FC.fcBeat(fut2);
  ok(FC.fcCurve(m1, fut2) === null, "quiet for over 10 minutes: checked against the chain again");
  FC.fcBeat(Date.now());
  const readAt = Date.now();
  FC.fcCurveTrade(m1, { ...cv, progress: 50 }, 12, readAt + 5);
  FC.fcCurveBase(m1, { ...cv, progress: 41 }, readAt);
  ok(FC.fcCurve(m1)?.progress === 50, "a chain read that was in flight while a trade landed does not overwrite the trade");
  const m2 = pk();
  FC.fcCurveBase(m2, { ...cv, progress: 22 }, Date.now());
  ok(FC.fcCurve(m2)?.progress === 22, "a coin with no trade yet: its chain read is kept until its next trade");
  FC.fcConnected(Date.now());
  ok(FC.fcCurve(m1) === null && FC.fcCurve(m2) === null, "a reconnect: nothing from before the gap is trusted");
  FC.fcDown();
  FC.fcCurveTrade(m1, cv, 20);
  ok(FC.fcCurve(m1) === null, "down: every read goes to the chain");

  // handleTx: canonical pools only, prices after the swap, the cache filled
  FC._fcReset();
  FC.fcConnected(Date.now());
  const mint = "55Vr2VpSwxsDkB6uGGHAvRv86K6zax2Zb4TT8ivwDEzW"; // the sell in the fixture, on its canonical pool
  const sell: any = PE.decodeEvent(Uint8Array.from(Buffer.from(fx.events[0].hex, "hex")));
  ok(canonicalPool(mint) === sell.pool, "the fixture's sell is on the coin's canonical pool");
  const got: any = { trades: [], pools: [] };
  const h = { trade: (t: any) => got.trades.push(t), pool: (m: string, q: any) => got.pools.push([m, q]) };
  FH.handleTx([sell], ["So11111111111111111111111111111111111111112", mint], h, undefined, Date.now(), 1);
  const after = { tok: Number(fx.events[0].vaultsAfter.base) / 1e6, sol: Number(fx.events[0].vaultsAfter.quote) / 1e9, vq: Number(fx.events[0].vq) / 1e9 };
  const px = (after.sol + after.vq) / after.tok;
  ok(got.pools.length === 1 && Math.abs(got.pools[0][1].mcSol - Math.round(px * 1e9 * 100) / 100) < 1e-9 && got.pools[0][1].real === Math.round(after.sol * 100) / 100, `pool price after the swap with its virtual reserves: ${Math.round(px * 1e9)} SOL mc`);
  const fp = FC.fcPool(mint);
  ok(!!fp && fp.pool === sell.pool && Math.abs(fp.px - px) < 1e-15 && Math.abs(fp.sol - after.sol) < 1e-9, "the pool read is cached exactly as lib/pool.ts reads it (real SOL, tokens, price with virtual reserves)");
  ok(got.trades[0]?.mcSol === got.pools[0][1].mcSol, "the trade carries the same price");
  // the same swap on a pool that is not the coin's canonical one: a trade, never a price
  const other = pk();
  got.trades.length = 0;
  got.pools.length = 0;
  FH.handleTx([{ ...sell, pool: pk() }], ["So11111111111111111111111111111111111111112", other], h, undefined, Date.now(), 2);
  ok(got.trades.length === 1 && got.trades[0].mint === other && got.trades[0].mcSol === undefined && got.pools.length === 0 && FC.fcPool(other) === null, "a swap on another pool for the coin: counted as a trade, never as its price");

  // readPools and getCurves answer from the cache (no chain read, no Redis read)
  const P = await import("../src/lib/pool");
  const S = await import("../src/lib/solana");
  const curveMint = pk();
  FC.fcCurveTrade(curveMint, { ...cv, progress: 61 }, 3);
  const before = { pr: P.poolFire.hits, cr: S.curveFire.hits };
  const rp = await P.readPools([mint]);
  const rc = await S.getCurves([curveMint]);
  ok(rp[mint]?.pool === sell.pool && P.poolFire.hits === before.pr + 1 && P.poolFire.reads === 0, "readPools: answered by the firehose");
  ok(rc[curveMint]?.progress === 61 && S.curveFire.hits === before.cr + 1 && S.curveFire.reads === 0, "getCurves: answered by the firehose");

  // ================================================================ 4. the rats' tapes from the firehose
  const SL = await import("../src/lib/streamlog");
  const T = await import("../src/lib/tape");
  const born = pk(), dev = pk();
  const t0 = Date.now() - 50_000;
  SL.logCreate(born, dev, t0, 0, 0, true);
  SL.logTrade({ mint: born, w: dev, buy: true, sol: 1, tok: 30_000_000, mcSol: 31, pool: "pump", real: 1 });
  for (let i = 0; i < 25; i++) SL.logTrade({ mint: born, w: pk(), buy: true, sol: 0.3, tok: 8_000_000, mcSol: 33 + i, pool: "pump", real: 1 + i * 0.3 });
  SL.logCreate(born, dev, t0 + 1200, 1, 30_000_000); // PumpPortal's create, a second later
  const lg = SL.streamLog(born, t0 + 1200);
  ok(!!lg && lg.full && lg.trades.length === 26, "PumpPortal's later create does not wipe the firehose's log (26 trades kept)");
  const tp = await T.readTape(born, dev, t0 + 1200);
  ok(tp?.src === "stream" && tp.n === 26, "the rats' tape is built from it: no chain read");
  ok(SL.streamQuote(born)?.real === 8.2, "quotes carry the curve's real SOL from the firehose");
  ok(SL.logsGap() >= 1 && !SL.streamLog(born, t0 + 1200), "after a firehose gap the log no longer counts as complete (the chain is read)");

  // ================================================================ 5. WALLETS: saves add, the line with Dune
  const WL = await import("../src/lib/wallets");
  WL._walletsReset();
  const { newDb } = await import("pg-mem");
  const db = newDb();
  const ar = fs.readFileSync(new URL("../src/lib/archive.ts", import.meta.url), "utf8");
  ok(/create table if not exists dune_chunks \(id text primary key/.test(ar), "archive table dune_chunks (the backfill's markers)");
  db.public.none(`create table wallet_scores (wallet text primary key, n integer not null, hits integer not null, sol real, updated_at timestamptz not null default now());
    create table dune_chunks (id text primary key, at timestamptz not null default now(), rows integer, n bigint, hits bigint, credits real);`);
  const { Pool } = db.adapters.createPg();
  const pg = new Pool();
  const w1 = pk();
  // a wallet with 2 buys in Postgres (never loaded: loading starts at 3)
  await pg.query(`insert into wallet_scores (wallet, n, hits, sol) values ($1, 2, 1, 0.4)`, [w1]);
  await WL.walletsLoad(pg);
  ok(!WL._walletStat(w1), "a wallet with 2 scored buys is not loaded");
  const T0 = WL.LIVE_FROM + 3600_000;
  const coins = [pk(), pk()];
  for (const c of coins) {
    WL.walletCreate(c, dev, T0);
    WL.walletTrade({ mint: c, user: w1, isBuy: true, sol: 0.2, at: T0, venue: "curve" }, 10);
  }
  WL.walletComplete(coins[0], T0 + 600_000);
  WL.walletSweep(T0 + 4 * 3600_000);
  ok(WL._walletStat(w1)?.n === 2 && WL._walletStat(w1)?.dn === 2, "two live buys scored (one hit, one miss)");
  await WL.walletsSave(pg);
  const row = (await pg.query(`select n, hits from wallet_scores where wallet = $1`, [w1])).rows[0];
  ok(Number(row.n) === 4 && Number(row.hits) === 2, "saved as an addition: 2 in Postgres + 2 live = 4 (v0.1.81 would have overwritten it with 2)");
  ok(WL._walletStat(w1)?.dn === 0, "nothing left to save");
  await WL.walletsLoad(pg);
  ok(WL._walletStat(w1)?.n === 4 && WL._walletStat(w1)?.abs === true, "reloaded: memory now holds Postgres' count");
  // coins on Dune's side of the line, or seen mid-life, are never scored live
  const early = pk(), mid = pk(), w2 = pk();
  WL.walletCreate(early, dev, WL.LIVE_FROM - 60_000);
  WL.walletTrade({ mint: early, user: w2, isBuy: true, sol: 0.2, at: WL.LIVE_FROM - 60_000, venue: "curve" }, 10);
  WL.walletTrade({ mint: mid, user: w2, isBuy: true, sol: 0.2, at: T0, venue: "curve" }, 10); // no create seen
  WL.walletComplete(early, WL.LIVE_FROM);
  WL.walletComplete(mid, T0 + 1000);
  ok(!WL._walletStat(w2), "a coin created before the line (Dune scores it) or never seen created: not scored live");

  // ================================================================ 6. Dune
  const DN = await import("../src/lib/dune");
  const cs = DN.chunks();
  ok(cs.length === 18 && cs[0].to.getTime() === WL.LIVE_FROM && cs[17].from.getTime() === WL.LIVE_FROM - 90 * 86400_000, "18 chunks of 5 days, newest first, ending exactly where live scoring starts");
  ok(cs.every((c, i) => i === 0 || c.to.getTime() === cs[i - 1].from.getTime()) && new Set(cs.map((c) => c.id)).size === 18, "no gap, no overlap, unique ids");
  const sql = DN.chunkSql(cs[0]);
  ok(/pumpdotfun_solana\.pump_evt_createevent/.test(sql) && /pumpdotfun_solana\.pump_evt_tradeevent/.test(sql) && /pumpdotfun_solana\.pump_evt_completeevent/.test(sql), "Dune's decoded pump.fun tables");
  ok(/COALESCE\(t\.is_buy, t\.isBuy\)/.test(sql) && /COALESCE\(CAST\(t\.sol_amount AS DOUBLE\), CAST\(t\.solAmount AS DOUBLE\)\)/.test(sql), "both column generations read (snake_case and camelCase)");
  ok(sql.includes(`>= 50000000`) && sql.includes(`> ${DN.EARLY_REAL_MIN}`) && DN.EARLY_REAL_MIN === 555_170_000_000_000 && /t\."user" <> c\.creator/.test(sql), "early = 0.05+ SOL, curve under 30% after the buy, never the creator");
  ok(/PARTITION BY mint, w ORDER BY slot, ix, ii\) AS k/.test(sql) && /WHERE k = 1/.test(sql) && /r\.q <= 150/.test(sql), "first early buy per wallet per coin, the first 150 early buyers per coin");
  ok(/m\.tc < c\.t0 \+ INTERVAL '3' HOUR/.test(sql) && /evt_block_time < c\.t0 \+ INTERVAL '3' HOUR/.test(sql), "hit = migrated within 3 hours of creation (as live)");
  ok(sql.includes("TIMESTAMP '2026-10-15 22:00:00'") && sql.includes("TIMESTAMP '2026-10-10 22:00:00'"), "the newest chunk: 10 Oct 22:00 to 15 Oct 22:00 UTC");
  let threw = "";
  try {
    DN.cleanRows([{ wallet: "not a wallet", n: 1, hits: 0, sol: 1 }]);
  } catch (e: any) {
    threw = e.message;
  }
  ok(/unexpected row/.test(threw), "a row that is not what was asked for stops the chunk");
  try {
    threw = "";
    DN.cleanRows([{ wallet: pk(), n: 2, hits: 3, sol: 1 }]);
  } catch (e: any) {
    threw = e.message;
  }
  ok(/unexpected row/.test(threw), "more hits than buys stops the chunk");

  // the whole flow against a fake Dune
  const wA = w1, wB = pk(), wC = pk(), wD = pk();
  const calls: string[] = [];
  let costs = [12.5, 14];
  let exec = 0;
  const fakeDune = (pages: any[][]) => async (url: string, init?: any) => {
    calls.push(`${init?.method || "GET"} ${url.replace("https://api.dune.com/api/v1", "")}`);
    const j = (x: any) => ({ ok: true, status: 200, json: async () => x });
    if (url.endsWith("/sql/execute")) {
      ok(init.headers["X-Dune-Api-Key"] === "test-key" && JSON.parse(init.body).performance === "medium", exec === 0 ? "the API key goes in its header, medium engine" : "next chunk");
      return j({ execution_id: `E${++exec}`, state: "QUERY_STATE_PENDING" });
    }
    if (/\/status$/.test(url)) {
      const n = calls.filter((c) => c.includes(`/execution/E${exec}/status`)).length;
      return j(n < 2 ? { state: "QUERY_STATE_EXECUTING", is_execution_finished: false } : { state: "QUERY_STATE_COMPLETED", is_execution_finished: true, execution_cost_credits: costs[(exec - 1) % costs.length] });
    }
    const off = Number(new URL(url).searchParams.get("offset"));
    const page = pages[off ? 1 : 0];
    return j({ result: { rows: page }, next_offset: off ? undefined : 2 });
  };
  process.env.DUNE_API_KEY = "test-key";
  process.env.DUNE_MAX_CREDITS = "1000";
  const page1 = [{ wallet: wA, n: 3, hits: 2, sol: 0.9 }, { wallet: wB, n: 6, hits: 4, sol: 2.1 }];
  const page2 = [{ wallet: wC, n: 1, hits: 0, sol: 0.1 }];
  const rc1 = await DN.runChunk(cs[0], fakeDune([page1, page2]) as any, async () => {});
  ok(rc1.rows.length === 3 && rc1.credits === 12.5, "a chunk: executed, waited for, every page read, its cost kept");
  ok(await DN.applyChunk(pg, cs[0], rc1.rows, rc1.credits), "added to Postgres with its marker");
  ok(!(await DN.applyChunk(pg, cs[0], rc1.rows, rc1.credits)), "the same chunk twice: refused (nothing added twice)");
  const rA = (await pg.query(`select n, hits from wallet_scores where wallet = $1`, [wA])).rows[0];
  ok(Number(rA.n) === 7 && Number(rA.hits) === 4, "history added to what was there (4 live + 3 history = 7)");
  // the full backfill: chunk 0 is done, the rest run until the cap
  calls.length = 0;
  exec = 0;
  costs = [300];
  WL._walletsReset();
  await WL.walletsLoad(pg);
  const before7 = WL._walletStat(wA)?.n;
  const beforeB = WL._walletStat(wB)?.n;
  const ds = await DN.duneBackfill(pg, fakeDune([page1, [{ wallet: wD, n: 1, hits: 1, sol: 0.3 }]]) as any, async () => {});
  ok(!ds.error && ds.stopped.startsWith("credit cap") && ds.done === 4 && Math.round(ds.credits) === 913, `stops before the cap: 3 more chunks at 300 credits, a 4th would pass 1,000 (${ds.done}/18, ${Math.round(ds.credits)} credits)`);
  ok(before7 === 7 && beforeB === 6 && WL._walletStat(wA)?.n === 16 && WL._walletStat(wB)?.n === 24, "loaded wallets get the history in memory too (7 + 3x3 = 16, 6 + 3x6 = 24)");
  ok(WL._walletStat(wD)?.n === 3 && WL._walletStat(wD)?.abs === true, "a wallet that reached 3 scored buys through the history is loaded");
  const rB = (await pg.query(`select n from wallet_scores where wallet = $1`, [wB])).rows[0];
  ok(Number(rB.n) === 24, "Postgres and memory agree");
  ok(WL.isProven(wB), "a wallet with 16 hits in 24 early buys is proven from history alone");
  // a missing cost stops after one chunk (the cap must stay real)
  costs = [0];
  delete process.env.DUNE_MAX_CREDITS;
  const ds2 = await DN.duneBackfill(pg, fakeDune([[], []]) as any, async () => {});
  ok(ds2.done === 5 && /did not report/.test(ds2.stopped), "Dune reporting no cost: stops after that chunk");
  // an error is reported, nothing half-added
  const bad = async (url: string) => ({ ok: url.endsWith("/sql/execute") ? false : true, status: 402, json: async () => ({ error: "This request would exceed your configured limits" }) });
  const ds3 = await DN.duneBackfill(pg, bad as any, async () => {});
  ok(/Dune 402/.test(ds3.error) && ds3.done === 5, "a Dune error is shown, the chunks done stay done");
  delete process.env.DUNE_API_KEY;

  // ================================================================ 7. RESEARCHER
  const RS = await import("../src/lib/researcher");
  ok(RS.normFilter("r5+p70") === "p70+r5" && RS.normFilter("p70") === "p70" && RS.normFilter("all") === "all", "filters in GRID's own order (the record joins GRID's)");
  ok(RS.normFilter("p70+p70") === null && RS.normFilter("p70+r5+bond") === null && RS.normFilter("moon") === null && RS.normFilter("") === null, "no repeats, no triples, nothing off the menu");
  ok(typeof RS.checkIdea({ filter: "p70", mode: "warp", exit: 1, why: "x" }) === "string" && typeof RS.checkIdea({ filter: "p70", mode: "now", exit: 99, why: "x" }) === "string" && typeof RS.checkIdea({ filter: "p70", mode: "now", exit: 1, why: "" }) === "string", "unknown entry, exit or no reason: refused");
  const okIdea: any = RS.checkIdea({ filter: "r5+p70", mode: "d15", exit: 3, why: "close to passing" });
  ok(typeof okIdea === "object" && okIdea.key === g.keyOf("p70+r5", "d15", g.GEXITS[3]) && okIdea.label === "curve 70%+ (near migration) + curve +5 pts in the minute before, buy on a 15% dip (within 10 min)", "a good idea: GRID's key and label");
  // a pass with the model mocked
  L.gridLiveReset();
  await R.set("rn:grid:view", { at: Date.now(), coins: 2000, trainN: 1400, testN: 600, rows: [{ key: hotKey, filter: "p70+r5", mode: "now", exit, train: { n: 50, winRate: 40, avgPct: 3 }, test: { n: 20, winRate: 45, avgPct: 4, pfLessBest: 1.3 }, pass: true }], explore: [], base: [], senders: { lifts: [] } });
  await R.set(L.LIVE_VIEW, { books: [], past: [] });
  process.env.ANTHROPIC_API_KEY = "sk-test";
  let sent: any = null;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_u: string, init: any) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ ideas: [{ filter: "r5+p70", mode: "d15", exit: 3, why: "dip entries cut the -25% stops" }, { filter: "p70+r5", mode: "d15", exit: 3, why: "dup" }, { filter: "moon", mode: "now", exit: 1, why: "x" }, { filter: "bond", mode: "c10", exit: 7, why: "senders were BOND" }, { filter: "sm", mode: "now", exit: 0, why: "smart wallets" }, { filter: "p35", mode: "h2", exit: 9, why: "mid curve" }, { filter: "u20", mode: "now", exit: 2, why: "buyers" }] }) }] }) } as any;
  };
  const tg: string[] = [];
  const rr: any = await RS.researchPass(async (t) => tg.push(t));
  ok(/MENU/.test(sent.messages[0].content[0].text) && /p70\+r5\|now/.test(sent.messages[0].content[0].text) && sent.max_tokens === 4000, "the model gets the menu and GRID's evidence");
  ok(rr.added.length === 4 && L.gridLiveBooks().filter((x) => x.by === "researcher").length === 4, "4 books at most");
  ok(rr.refused.some((x: string) => /not on the menu/.test(x)) && !rr.added.includes(undefined), "off-menu ideas refused");
  const rb = L.gridLiveBooks().find((x) => x.by === "researcher")!;
  ok(rb.grid.explore && rb.why === "dip entries cut the -25% stops", "its books are exploring (45 trips) and carry the reason");
  ok(tg.length === 1 && /RESEARCHER/.test(tg[0]), "Telegram names them");
  sent = null;
  const rr2: any = await RS.researchPass();
  ok(rr2.full === true && sent === null, "no free slot: no call at all (no cost)");
  const books = await L.gridLiveSetBooks(Array.from({ length: 20 }, (_, i) => ({ key: `bond|now|2/0.25/0.25/15/sell#${i}`, filterLabel: "King BOND", filter: "bond", mode: "now", modeLabel: "at the call", exit: { ...exit, initials: 2, timeMin: 15, mig: "sell" }, test: { n: 40, avgPct: 3 }, pass: false })) as any);
  ok(books.filter((x: any) => !x.parent && !x.by).length === 16 && books.filter((x: any) => x.by === "researcher").length === 4, "GRID still fills its 16; RESEARCHER has its own 4");
  (globalThis as any).fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
  const llm = fs.readFileSync(new URL("../src/lib/llm.ts", import.meta.url), "utf8");
  ok(/model = llmModel\(\)\): Promise<string \| null>/.test(llm), "ask() takes a model (RESEARCH_MODEL), MIND keeps its own");

  // ================================================================ 8. wiring
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/logCreate\(c\.mint, c\.creator, c\.at, 0, 0, true\)/.test(wk) && /logTrade\(\{ mint: t\.mint, w: t\.user/.test(wk) && /if \(!fireLive\(\)\) logTrade\(/.test(wk), "the firehose logs every launch and trade; PumpPortal's trades only while it is down");
  ok(/connected: \(\) => \{\n\s+const n = logsGap\(\);/.test(wk), "a firehose reconnect marks older logs incomplete");
  ok(/duneBackfill\(archivePool\(\)\)/.test(wk) && /if \(process\.env\.DUNE_API_KEY\)/.test(wk), "the Dune backfill runs after the scores load, only with DUNE_API_KEY");
  ok(/rn:research:at/.test(wk) && /RESEARCH_EVERY_MS/.test(wk), "RESEARCHER at most hourly, across restarts");
  const fh = fs.readFileSync(new URL("../src/lib/firehose.ts", import.meta.url), "utf8");
  ok(/const ord = Number\(u\.transaction\.slot \|\| 0\) \* 100_000 \+ \(Number\(tx\.index\) \|\| 0\);/.test(fh), "transactions ordered by slot and index (Yellowstone: transaction.slot, transaction.transaction.index)");
  const yd = fs.readFileSync(new URL("../node_modules/@triton-one/yellowstone-grpc/dist/types/grpc/geyser.d.ts", import.meta.url), "utf8");
  ok(/interface SubscribeUpdateTransaction \{\n\s+transaction: SubscribeUpdateTransactionInfo \| undefined;\n\s+slot: string;/.test(yd) && /interface SubscribeUpdateTransactionInfo \{[^}]*index: string;/.test(yd), "the client's own types have those fields");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
