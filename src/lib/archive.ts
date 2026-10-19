// The archive (v0.1.55, roadmap step 3). Redis is the desk's short-term memory: positions, queues, the latest calls,
// capped lists. Everything worth learning from is also written here, to Postgres, for good:
//   launches  every launch with its outcome, King and nano call, minute-1 read and tape (one row, updated as it changes)
//   ticks     curve snapshots of followed launches (at most one per coin every 10 seconds), for REPLAY
//   trades    every buy and sell of every book (paper, live, ghost), tagged with the build and the settings fingerprint
//   trips     every closed round trip with its result, tagged with the build and settings it was opened under
// Worker only, and only with DATABASE_URL set (Railway's Postgres, on the private network). Without it every call here
// does nothing and the desk runs exactly as before. Writes are queued in memory and sent in batches every 5 seconds;
// a failed batch is retried, and the queues are capped so a database outage can never grow the worker's memory.
import { createHash } from "crypto";
import { BUILD } from "@/config/build";

type Row = Record<string, unknown>;
const on = () => process.env.RATNET_WORKER === "1" && !!process.env.DATABASE_URL;

let pool: any = null;
let ready = false;
let initErr = "";
const Q = { launches: new Map<string, Row>(), ticks: [] as Row[], trades: [] as Row[], trips: [] as Row[], early: [] as Row[] };
const CAP = { ticks: 60_000, trades: 20_000, trips: 5_000, launches: 20_000, early: 10_000 };
export const archiveStats = { written: { launches: 0, ticks: 0, trades: 0, trips: 0, early: 0 }, fails: 0, dropped: 0, lastError: "", lastAt: 0 };

const SCHEMA = `
create table if not exists launches (
  mint text primary key, symbol text, name text, creator text, created_at timestamptz, dev_buy_sol real,
  outcome text, resolved_at timestamptz, bond_secs integer, peak real,
  call_score real, call_verdict text, nano_score real, nano_verdict text, early_score real, early_verdict text,
  data jsonb, updated_at timestamptz default now()
);
create index if not exists launches_created on launches (created_at);
create table if not exists ticks (mint text not null, at timestamptz not null, progress real, mc_sol real, real_sol real, complete boolean);
create index if not exists ticks_mint_at on ticks (mint, at);
create index if not exists ticks_at on ticks (at);
alter table ticks add column if not exists pool boolean;
create table if not exists wallet_scores (wallet text primary key, n integer not null, hits integer not null, sol real, updated_at timestamptz not null default now());
create index if not exists wallet_scores_n on wallet_scores (n);
create table if not exists dune_chunks (id text primary key, at timestamptz not null default now(), rows integer, n bigint, hits bigint, credits real);
create table if not exists trades (
  id text primary key, book text, mint text, symbol text, side text, at timestamptz, sol real, cost real, tokens double precision,
  px double precision, mc real, reason text, pnl_sol real, pnl_pct real, sig text, build text, cfg text
);
create index if not exists trades_at on trades (at);
create table if not exists trips (
  book text, mint text, symbol text, opened_at timestamptz, closed_at timestamptz, cost_sol real, back_sol real,
  pnl_sol real, pnl_pct real, how text, king real, nano real, peak_x real, exit_reason text, build text, cfg text, data jsonb,
  primary key (book, mint, opened_at)
);
create index if not exists trips_closed on trips (closed_at);
create index if not exists trips_build on trips (build);
create table if not exists early_reads (mint text primary key, at timestamptz not null, created_at timestamptz, f jsonb);
create index if not exists early_reads_at on early_reads (at);
create table if not exists early_reads2 (mint text not null, sec integer not null, at timestamptz not null, created_at timestamptz, f jsonb, primary key (mint, sec));
create index if not exists early_reads2_at on early_reads2 (sec, at);
`;

/** Connect and create the tables (worker boot). Safe to call when DATABASE_URL is missing: it does nothing. */
export async function archiveInit() {
  if (!on() || ready) return ready;
  initErr = "";
  try {
    // pg is CommonJS: under the worker's ESM loader the import puts it on .default (v0.1.56: "Pool is not a constructor")
    const mod: any = (globalThis as any).__rnPg || (await import("pg")); // test hook: an in-memory Postgres
    const Pool = mod.Pool || mod.default?.Pool;
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    pool.on("error", (e: any) => (archiveStats.lastError = String(e?.message || e).slice(0, 120)));
    await pool.query(SCHEMA);
    ready = true;
  } catch (e: any) {
    initErr = String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/g, "[db]").slice(0, 120);
    archiveStats.lastError = initErr;
    await pool?.end?.().catch?.(() => null);
    pool = null;
  }
  return ready;
}
export const archiveReady = () => ready;
/** v0.1.81: the archive's connection pool (WALLETS keeps its scores here), or null. */
export const archivePool = () => (ready ? pool : null);

/** A short fingerprint of the desk settings a trade was made under (equal settings, equal fingerprint). */
export function cfgTag(cfg: unknown) {
  if (!cfg) return "";
  return createHash("sha1").update(JSON.stringify(cfg)).digest("hex").slice(0, 8);
}
export { BUILD };

// v0.1.68: Postgres rejects JSON with a \u0000 or a lone surrogate (half an emoji cut by a .slice in a coin name or
// a post): "invalid input syntax for type json". One such row failed its whole batch, the batch was retried forever,
// and on 11 Oct 79K rows were stuck behind it with 17K failed writes. Strings are cleaned before they are stored.
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export const cleanStr = (s: string) => s.replace(BAD_CHARS, "");
export const safeJson = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "string" ? cleanStr(v) : v));
const ts = (ms: number | null | undefined) => (ms && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const push = (q: Row[], row: Row, cap: number) => {
  if (q.length >= cap) q.splice(0, q.length - cap + 1);
  q.push(row);
};

// ---- launches: one row per coin, re-written only when something that matters changed
const SIG = new Map<string, string>();
export function archiveLaunch(rec: any) {
  if (!on() || !rec?.mint) return;
  const sig = `${rec.call ? 1 : 0}${rec.early ? 1 : 0}${rec.tape ? 1 : 0}|${rec.outcome || ""}|${Object.keys(rec.cp || {}).length}|${rec.call?.nano?.score ?? ""}`;
  if (SIG.get(rec.mint) === sig) return;
  if (SIG.size > 50_000) SIG.clear();
  SIG.set(rec.mint, sig);
  if (Q.launches.size >= CAP.launches && !Q.launches.has(rec.mint)) return;
  const heavy = rec.call || rec.early || rec.tape || rec.outcome === "BONDED";
  Q.launches.set(rec.mint, {
    mint: rec.mint, symbol: String(rec.symbol || "").slice(0, 32), name: String(rec.name || "").slice(0, 64), creator: rec.creator || null,
    created_at: ts(rec.createdAt), dev_buy_sol: num(rec.devBuySol), outcome: rec.outcome || null, resolved_at: ts(rec.resolvedAt),
    bond_secs: num(rec.bondSecs) != null ? Math.round(rec.bondSecs) : null, peak: num(rec.peak),
    call_score: num(rec.call?.score), call_verdict: rec.call?.verdict ?? null, nano_score: num(rec.call?.nano?.score), nano_verdict: rec.call?.nano?.verdict ?? null,
    early_score: num(rec.early?.score), early_verdict: rec.early?.verdict ?? null,
    // the full picture only for coins with something to learn from (a read, a call, a tape or a bond); dead launches keep the columns
    data: heavy ? safeJson({ cp: rec.cp, call: rec.call, early: rec.early, tape: rec.tape, g: rec.g, meta: rec.meta, wire: rec.wire, pulse: rec.pulse, devN: rec.devN, devB: rec.devB, socials: { x: !!rec.twitter, tg: !!rec.telegram, web: !!rec.website } }) : null,
  });
}

// ---- v0.1.115 EARLY: every launch read at 2 minutes old (lib/early.ts), before any call
const EARLY_COLS = ["mint", "sec", "at", "created_at", "f"];
/** v0.1.117: one row per launch and reading age (early_reads2). */
export function archiveEarly(mint: string, at: number, createdAt: number, f: unknown, sec = 120) {
  if (!on() || !mint) return;
  push(Q.early, { mint, sec, at: ts(at), created_at: ts(createdAt), f: safeJson(f) }, CAP.early);
}

// ---- curve ticks: at most one per coin every 10 seconds (a change is kept, the next one waits)
const TICK_AT = new Map<string, number>();
export function archiveTick(mint: string, v: { progress: number; mcapSol: number; realSol: number; complete: boolean }, now = Date.now()) {
  if (!on()) return;
  const last = TICK_AT.get(mint) || 0;
  if (now - last < 10_000 && !v.complete) return;
  if (TICK_AT.size > 20_000) TICK_AT.clear();
  TICK_AT.set(mint, now);
  push(Q.ticks, { mint, at: ts(now), progress: num(v.progress), mc_sol: num(v.mcapSol), real_sol: num(v.realSol), complete: !!v.complete, pool: false }, CAP.ticks);
}

// v0.1.72: prices in the canonical PumpSwap pool for 6 hours after a migration (lib/after.ts). The senders do their
// millions in volume here, after the curve; GRID needs these paths to test holding through the migration.
// One every 15 seconds in the first 30 minutes, then one a minute.
const POOL_AT = new Map<string, number>();
export function archivePoolTick(mint: string, v: { mcSol: number; real: number }, migratedAt: number, now = Date.now()) {
  if (!on() || !(v.mcSol > 0)) return;
  const gap = now - migratedAt < 30 * 60_000 ? 15_000 : 60_000;
  if (now - (POOL_AT.get(mint) || 0) < gap) return;
  if (POOL_AT.size > 5_000) POOL_AT.clear();
  POOL_AT.set(mint, now);
  push(Q.ticks, { mint, at: ts(now), progress: 100, mc_sol: num(v.mcSol), real_sol: num(v.real), complete: true, pool: true }, CAP.ticks);
}

// v0.1.89: RUNNER paths. Every King BOND call (and every call already 30%+ up the curve) is followed for a day from
// the firehose, one price a minute once its first hour is over (the curve stream covers the first hour, AFTER the
// first 6 hours in the pool). GRID tests the runner exits on these.
const RUN_TRACK = new Map<string, number>(); // mint -> call time
const RUN_AT = new Map<string, number>();
export const RUN_TRACK_MS = 24 * 3600_000;
// v0.1.100 (audit): the tracked calls are kept in Redis too. Only in memory, every deploy stopped the paths of the day's
// calls after their first hour, and GRID scored runner exits on prices that simply ended
const RUN_KEY = "rn:archive:runtrack";
export function runTrack(mint: string, callAt: number) {
  if (RUN_TRACK.size > 20_000) for (const [m, at] of RUN_TRACK) if (Date.now() - at > RUN_TRACK_MS) (RUN_TRACK.delete(m), RUN_AT.delete(m));
  RUN_TRACK.set(mint, callAt);
  import("./redis")
    .then(({ redis }) => redis().zadd(RUN_KEY, { score: callAt, member: `${mint}|${callAt}` }))
    .catch(() => null);
}
/** Worker boot: the last day's tracked calls back into memory (older ones are dropped from Redis too). */
export async function loadRunTrack(now = Date.now()) {
  const { redis } = await import("./redis");
  const r = redis();
  await r.zremrangebyscore(RUN_KEY, 0, now - RUN_TRACK_MS).catch(() => 0);
  const rows = ((await r.zrange<string[]>(RUN_KEY, now - RUN_TRACK_MS, now, { byScore: true }).catch(() => [])) || []) as string[];
  for (const row of rows) {
    const [m, at] = String(row).split("|");
    if (m && Number(at) > 0) RUN_TRACK.set(m, Number(at));
  }
  return RUN_TRACK.size;
}
export const runTracked = () => RUN_TRACK.size;
export function archiveRunTick(mint: string, v: { mcSol: number; real: number; progress: number; pool: boolean; complete?: boolean }, now = Date.now()) {
  const at = RUN_TRACK.get(mint);
  if (at == null || !on() || !(v.mcSol > 0)) return false;
  if (now - at > RUN_TRACK_MS) return (RUN_TRACK.delete(mint), RUN_AT.delete(mint), false);
  if (now - at < 62 * 60_000) return false;
  if (now - (RUN_AT.get(mint) || 0) < 60_000) return false;
  RUN_AT.set(mint, now);
  push(Q.ticks, { mint, at: ts(now), progress: num(v.pool ? 100 : v.progress), mc_sol: num(v.mcSol), real_sol: num(v.real), complete: !!(v.pool || v.complete), pool: !!v.pool }, CAP.ticks);
  return true;
}

// ---- trades and trips
export function archiveTrades(trades: any[] | undefined, ghost: boolean) {
  if (!on() || !trades?.length) return;
  for (const t of trades) {
    push(Q.trades, {
      id: `${ghost ? "g" : ""}${t.id}`, book: ghost ? "ghost" : t.live ? "live" : "paper", mint: t.mint, symbol: String(t.symbol || "").slice(0, 32), side: t.side,
      at: ts(t.at), sol: num(t.sol), cost: num(t.cost), tokens: num(t.tokens), px: num(t.px), mc: num(t.mc), reason: String(t.reason || "").slice(0, 300),
      pnl_sol: num(t.pnlSol), pnl_pct: num(t.pnlPct), sig: t.sig || null, build: t.v || BUILD, cfg: t.cfg || null,
    }, CAP.trades);
  }
}
export function archiveTrip(t: { book: "paper" | "live" | "ghost"; mint: string; symbol: string; openedAt: number; closedAt: number; costSol: number; backSol: number; how?: string; king?: number | null; nano?: number | null; peakX?: number | null; reason: string; build?: string; cfg?: string; data?: unknown }) {
  if (!on()) return;
  const pnl = t.backSol - t.costSol;
  push(Q.trips, {
    book: t.book, mint: t.mint, symbol: String(t.symbol || "").slice(0, 32), opened_at: ts(t.openedAt), closed_at: ts(t.closedAt), cost_sol: t.costSol, back_sol: t.backSol,
    pnl_sol: pnl, pnl_pct: t.costSol > 0 ? (pnl / t.costSol) * 100 : null, how: t.how || "direct", king: num(t.king), nano: num(t.nano), peak_x: num(t.peakX),
    exit_reason: String(t.reason || "").slice(0, 300), build: t.build || "before 0.1.55", cfg: t.cfg || null, data: t.data ? safeJson(t.data) : null,
  }, CAP.trips);
}

// ---- writer: one batch per table every 5 seconds, as a single multi-row insert
async function insert(table: string, cols: string[], rows: Row[], conflict: string) {
  if (!rows.length) return;
  const vals: unknown[] = [];
  const tuples = rows.map((r, i) => `(${cols.map((c, j) => {
    const v = r[c] ?? null;
    vals.push(typeof v === "string" ? cleanStr(v) : v);
    return `$${i * cols.length + j + 1}`;
  }).join(",")})`);
  await pool.query(`insert into ${table} (${cols.join(",")}) values ${tuples.join(",")} ${conflict}`, vals);
}
const LAUNCH_COLS = ["mint", "symbol", "name", "creator", "created_at", "dev_buy_sol", "outcome", "resolved_at", "bond_secs", "peak", "call_score", "call_verdict", "nano_score", "nano_verdict", "early_score", "early_verdict", "data"];
const TICK_COLS = ["mint", "at", "progress", "mc_sol", "real_sol", "complete", "pool"];
const TRADE_COLS = ["id", "book", "mint", "symbol", "side", "at", "sol", "cost", "tokens", "px", "mc", "reason", "pnl_sol", "pnl_pct", "sig", "build", "cfg"];
const TRIP_COLS = ["book", "mint", "symbol", "opened_at", "closed_at", "cost_sol", "back_sol", "pnl_sol", "pnl_pct", "how", "king", "nano", "peak_x", "exit_reason", "build", "cfg", "data"];

let flushing = false;
// v0.1.68: a row Postgres refuses for its content (not the connection, not a full disk) is dropped and counted, never
// retried forever; each table is written on its own, so one table's problem no longer stops the others
const isDataError = (e: any) => /invalid input|syntax|unicode|out of range|violates|value too long/i.test(String(e?.message || e));
async function insertSafe(table: string, cols: string[], rows: Row[], conflict: string) {
  try {
    await insert(table, cols, rows, conflict);
    return { ok: rows.length, dropped: 0 };
  } catch (e) {
    if (!isDataError(e)) throw e;
    let ok = 0, dropped = 0;
    for (const r of rows) {
      try {
        await insert(table, cols, [r], conflict);
        ok++;
      } catch (e2) {
        if (!isDataError(e2)) throw e2;
        dropped++;
      }
    }
    return { ok, dropped };
  }
}
/** Send what is queued (worker, every 5 seconds). Batches of at most 500 rows (Postgres allows 65,535 parameters). */
export async function archiveFlush() {
  if (!ready || flushing) return;
  flushing = true;
  const take = <T,>(q: T[], n: number) => q.splice(0, n);
  let failed = false;
  const fail = (e: any) => {
    failed = true;
    archiveStats.fails++;
    archiveStats.lastError = String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/g, "[db]").slice(0, 120);
  };
  try {
    if (Q.launches.size) {
      const rows = Array.from(Q.launches.values()).slice(0, 500);
      for (const r of rows) Q.launches.delete(String(r.mint));
      try {
        const res = await insertSafe("launches", LAUNCH_COLS, rows, `on conflict (mint) do update set ${LAUNCH_COLS.filter((c) => c !== "mint" && c !== "created_at").map((c) => `${c} = coalesce(excluded.${c}, launches.${c})`).join(", ")}, updated_at = now()`);
        archiveStats.written.launches += res.ok;
        archiveStats.dropped = (archiveStats.dropped || 0) + res.dropped;
      } catch (e) {
        for (const r of rows) if (!Q.launches.has(String(r.mint))) Q.launches.set(String(r.mint), r);
        fail(e);
      }
    }
    for (const [name, q, cols, conflict] of [
      ["trades", Q.trades, TRADE_COLS, "on conflict (id) do nothing"],
      ["trips", Q.trips, TRIP_COLS, "on conflict (book, mint, opened_at) do nothing"],
      ["ticks", Q.ticks, TICK_COLS, ""],
      ["early", Q.early, EARLY_COLS, "on conflict (mint, sec) do nothing"],
    ] as [keyof typeof archiveStats.written, Row[], string[], string][]) {
      const rows = take(q, 500);
      if (!rows.length) continue;
      try {
        const res = await insertSafe(name === "early" ? "early_reads2" : name, cols, rows, conflict);
        archiveStats.written[name] += res.ok;
        archiveStats.dropped = (archiveStats.dropped || 0) + res.dropped;
      } catch (e) {
        q.unshift(...rows);
        fail(e);
      }
    }
    if (!failed) archiveStats.lastAt = Date.now();
  } finally {
    flushing = false;
  }
}

/** Results per build and book over the last 30 days, plus the archive's size (published to Redis for the site). */
export async function archiveBoard() {
  if (!ready) return null;
  const [byBuild, sizes] = await Promise.all([
    pool.query(`select book, build, count(*)::int as n, count(*) filter (where pnl_sol > 0)::int as wins, sum(pnl_sol) as pnl,
      sum(cost_sol) as staked, avg(pnl_pct) as avg_pct, max(closed_at) as last
      from trips where closed_at > now() - interval '30 days' group by book, build order by max(closed_at) desc limit 40`),
    pool.query(`select (select count(*) from launches)::int as launches, (select count(*) from ticks)::int as ticks, (select count(*) from trades)::int as trades, (select count(*) from trips)::int as trips`),
  ]);
  const r = (x: unknown, d: number) => (x == null ? null : Math.round(Number(x) * 10 ** d) / 10 ** d);
  const rows = byBuild.rows.map((x: any) => ({ ...x, pnl: r(x.pnl, 4) ?? 0, staked: r(x.staked, 4) ?? 0, avg_pct: r(x.avg_pct, 1) }));
  return { at: Date.now(), rows, sizes: sizes.rows[0] };
}

/** Ticks are the bulk: keep 10 days of them (v0.1.68, was 30: the disk filled on 11 Oct). Everything else is kept. */
export async function archivePrune() {
  if (!ready) return;
  await pool.query(`delete from ticks where at < now() - interval '10 days'`).catch(() => null);
  await pool.query(`delete from early_reads where at < now() - interval '21 days'`).catch(() => null); // v0.1.115
  await pool.query(`delete from early_reads2 where at < now() - interval '21 days'`).catch(() => null); // v0.1.117
}

export function archiveView() {
  return { on: on(), ready, error: initErr || archiveStats.lastError, queued: Q.launches.size + Q.ticks.length + Q.trades.length + Q.trips.length + Q.early.length, ...archiveStats };
}

/** REPLAY over the archive (v0.1.59): every King call with its curve path, every entry rule x exit setting. */
/** v0.1.71: GRID, the big strategy search (lib/grid.ts). */
/**
 * v0.1.124b: GRID LIVE's paper trips from the archive (book "grid:<key>"), the newest per book first, at most `per`
 * per book. The worker merges them in at boot, so a restart never shortens a strategy's record again (19 Oct: the
 * shared Redis list was trimmed by the parked EARLY books and the 2x runner came back with 63 of its 121 trips).
 */
export async function archiveGridTrips(days = 14, per = 400) {
  if (!ready) return null;
  const r = await pool.query(
    `select book, mint, symbol, opened_at, closed_at, pnl_sol, pnl_pct, exit_reason from (
       select *, row_number() over (partition by book order by closed_at desc) as rn from trips
       where book like 'grid:%' and closed_at > now() - ($1 || ' days')::interval) x
     where rn <= $2`,
    [String(days), per],
  );
  return (r.rows || []).map((x: any) => ({ k: String(x.book).slice(5), mint: x.mint, symbol: x.symbol, openedAt: new Date(x.opened_at).getTime(), closedAt: new Date(x.closed_at).getTime(), pnl: Number(x.pnl_sol) || 0, pnlPct: Number(x.pnl_pct) || 0, why: String(x.exit_reason || "") }));
}

export async function archiveGrid(days = 14, opts: { nulls?: number; nullHist?: number[] } = {}) {
  if (!ready) return null;
  const { loadGrid, runGrid } = await import("./grid");
  const t0 = Date.now();
  const coins = await loadGrid(pool, days);
  const loadMs = Date.now() - t0;
  return { ...(await runGrid(coins, opts)), loadMs };
}

/** v0.1.115: the EARLY search (every launch read at 2 minutes, lib/early.ts): its own scores, its own checks. */
export async function archiveEarlyGrid(days = 10, opts: { nulls?: number; nullHist?: number[] } = {}, sec = 120) {
  if (!ready) return null;
  const { runGrid } = await import("./grid");
  const { loadEarly } = await import("./early");
  const t0 = Date.now();
  const coins = await loadEarly(pool, days, 12_000, sec);
  const loadMs = Date.now() - t0;
  if (coins.length < 300) return { early: true, sec, coins: coins.length, loadMs, why: `${coins.length} reads at ${sec}s with a path so far (300 needed)` } as any;
  return { early: true, sec, ...(await runGrid(coins, { ...opts, fitScore: false })), loadMs };
}

export async function archiveReplay(days = 14) {
  if (!ready) return null;
  const { loadCalls, runReplay } = await import("./replay");
  return runReplay(await loadCalls(pool, days));
}
