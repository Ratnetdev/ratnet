// v0.1.82: 90 days of WALLETS history from Dune (DUNE_API_KEY, Railway only). The live firehose scores early buyers
// from 15 Oct 22:00 UTC on (wallets.ts LIVE_FROM); this scores the same way on pump.fun's own decoded events before it,
// so proven wallets exist from day one instead of after weeks:
//   early buy  = a buy of 0.05+ SOL while the curve is under 30% (after the buy), not by the coin's creator, the first
//                such buy per wallet per coin, the first 150 early buyers per coin (as wallets.ts)
//   hit        = the coin completed its curve (migrated) within 3 hours of its creation; else a miss (as wallets.ts)
// Run in 5-day chunks, newest first, by the worker. Each chunk's totals are added to Postgres (wallet_scores) in one
// transaction with its marker (dune_chunks), so a restart never adds a chunk twice. Spending is capped
// (DUNE_MAX_CREDITS, default 8,000 of the Plus plan's 25,000 a month): a chunk that would go over it is not started.
//
// Tables (Dune's decoded pump.fun program, checked on dune.com/data 16 Oct): pumpdotfun_solana.pump_evt_createevent,
// pump_evt_tradeevent, pump_evt_completeevent. The trade table carries both the old camelCase columns (isBuy,
// solAmount, virtualTokenReserves) and the current snake_case ones (is_buy, sol_amount, real_token_reserves): both
// are read.
import { LIVE_FROM, walletsAddHistory, walletsLoad } from "./wallets";

const API = "https://api.dune.com/api/v1";
export const DAYS = 90;
export const CHUNK_DAYS = 5; // small enough to finish well inside Dune's time limits
const INITIAL_REAL = 793_100_000_000_000; // pump.fun's initial real token reserves (raw, 6 decimals)
const VIRTUAL_GAP = 279_900_000_000_000; // virtual minus real token reserves on a pump.fun curve
export const EARLY_REAL_MIN = Math.round(INITIAL_REAL * 0.7); // curve under 30% = real token reserves above 70% of the start
const POLL_MS = 10_000;
const MAX_WAIT_MS = 45 * 60_000;
const PAGE = 20_000;

export const duneState = { on: false, running: false, chunks: 0, done: 0, rows: 0, credits: 0, error: "", at: 0, stopped: "" };

export type Chunk = { id: string; from: Date; to: Date };
/** The chunks between LIVE_FROM - 90 days and LIVE_FROM, newest first. */
export function chunks(end = LIVE_FROM, days = DAYS, size = CHUNK_DAYS): Chunk[] {
  const out: Chunk[] = [];
  for (let i = 0; i < Math.ceil(days / size); i++) {
    const to = new Date(end - i * size * 86400_000);
    const from = new Date(Math.max(end - days * 86400_000, end - (i + 1) * size * 86400_000));
    out.push({ id: `w:${from.toISOString().slice(0, 16)}`, from, to });
  }
  return out;
}

const ts = (d: Date) => `TIMESTAMP '${d.toISOString().slice(0, 19).replace("T", " ")}'`;
const dt = (d: Date) => `DATE '${d.toISOString().slice(0, 10)}'`;

/** The SQL for one chunk: coins created in [from, to), every early buyer scored on the coin's outcome. */
export function chunkSql(c: Chunk) {
  const end3 = new Date(c.to.getTime() + 3 * 3600_000);
  const SOL_QUOTE = `('11111111111111111111111111111111', 'So11111111111111111111111111111111111111112')`;
  return `
WITH c AS (
  SELECT mint, COALESCE(creator, "user") AS creator, MIN(evt_block_time) AS t0
  FROM pumpdotfun_solana.pump_evt_createevent
  WHERE evt_block_date >= ${dt(c.from)} AND evt_block_date <= ${dt(c.to)}
    AND evt_block_time >= ${ts(c.from)} AND evt_block_time < ${ts(c.to)}
    AND (quote_mint IS NULL OR quote_mint IN ${SOL_QUOTE})
  GROUP BY mint, COALESCE(creator, "user")
),
m AS (
  SELECT mint, MIN(evt_block_time) AS tc
  FROM pumpdotfun_solana.pump_evt_completeevent
  WHERE evt_block_date >= ${dt(c.from)} AND evt_block_date <= ${dt(end3)}
    AND evt_block_time >= ${ts(c.from)} AND evt_block_time < ${ts(end3)}
  GROUP BY mint
),
b AS (
  SELECT t.mint, t."user" AS w, COALESCE(CAST(t.sol_amount AS DOUBLE), CAST(t.solAmount AS DOUBLE)) / 1e9 AS sol,
    t.evt_block_slot AS slot, t.evt_tx_index AS ix, COALESCE(t.evt_inner_instruction_index, 0) AS ii
  FROM pumpdotfun_solana.pump_evt_tradeevent t
  JOIN c ON c.mint = t.mint
  WHERE t.evt_block_date >= ${dt(c.from)} AND t.evt_block_date <= ${dt(end3)}
    AND t.evt_block_time >= ${ts(c.from)} AND t.evt_block_time < ${ts(end3)}
    AND t.evt_block_time < c.t0 + INTERVAL '3' HOUR
    AND COALESCE(t.is_buy, t.isBuy) = true
    AND COALESCE(CAST(t.sol_amount AS DOUBLE), CAST(t.solAmount AS DOUBLE)) >= 50000000
    AND t."user" <> c.creator
    AND COALESCE(CAST(t.real_token_reserves AS DOUBLE), COALESCE(CAST(t.virtual_token_reserves AS DOUBLE), CAST(t.virtualTokenReserves AS DOUBLE)) - ${VIRTUAL_GAP}) > ${EARLY_REAL_MIN}
),
f AS (
  SELECT mint, w, sol, slot, ix, ii, ROW_NUMBER() OVER (PARTITION BY mint, w ORDER BY slot, ix, ii) AS k FROM b
),
r AS (
  SELECT mint, w, sol, ROW_NUMBER() OVER (PARTITION BY mint ORDER BY slot, ix, ii) AS q FROM f WHERE k = 1
)
SELECT r.w AS wallet,
  COUNT(*) AS n,
  SUM(CASE WHEN m.tc IS NOT NULL AND m.tc < c.t0 + INTERVAL '3' HOUR THEN 1 ELSE 0 END) AS hits,
  ROUND(SUM(r.sol), 3) AS sol
FROM r
JOIN c ON c.mint = r.mint
LEFT JOIN m ON m.mint = r.mint
WHERE r.q <= 150
GROUP BY r.w`.trim();
}

type Fetch = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
const key = () => (process.env.DUNE_API_KEY || "").trim();
const maxCredits = () => Math.max(500, Number(process.env.DUNE_MAX_CREDITS || 8_000));

async function call(f: Fetch, path: string, init?: any) {
  const res = await f(`${API}${path}`, { ...(init || {}), headers: { "X-Dune-Api-Key": key(), "Content-Type": "application/json", ...(init?.headers || {}) } });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Dune ${res.status}: ${String(j?.error || j?.message || "request failed").slice(0, 160)}`);
  return j;
}

export type Row = { wallet: string; n: number; hits: number; sol: number };
/** Rows Dune returned, checked: a wallet address, 1+ buys, hits within 0..n. Anything else is refused whole. */
export function cleanRows(raw: any[]): Row[] {
  const out: Row[] = [];
  for (const x of raw) {
    const wallet = String(x?.wallet ?? "");
    const n = Number(x?.n);
    const hits = Number(x?.hits);
    const sol = Number(x?.sol) || 0;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet) || !Number.isInteger(n) || !Number.isInteger(hits) || n < 1 || hits < 0 || hits > n) throw new Error(`unexpected row from Dune: ${JSON.stringify(x).slice(0, 120)}`);
    out.push({ wallet, n, hits, sol: Math.round(sol * 1000) / 1000 });
  }
  return out;
}

/** One chunk on Dune: execute, wait, read every page. Returns the rows and what it cost. */
export async function runChunk(c: Chunk, f: Fetch = fetch as any, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  const ex = await call(f, "/sql/execute", { method: "POST", body: JSON.stringify({ sql: chunkSql(c), performance: "medium" }) });
  const id = String(ex?.execution_id || "");
  if (!id) throw new Error("Dune returned no execution id");
  const t0 = Date.now();
  let st: any = null;
  for (;;) {
    st = await call(f, `/execution/${id}/status`);
    if (st?.is_execution_finished || /COMPLETED|FAILED|CANCELLED|EXPIRED/.test(String(st?.state || ""))) break;
    if (Date.now() - t0 > MAX_WAIT_MS) throw new Error("Dune query still running after 45 minutes");
    await sleep(POLL_MS);
  }
  const credits = Number(st?.execution_cost_credits) || 0;
  if (!/COMPLETED/.test(String(st?.state || ""))) throw new Error(`Dune query ${String(st?.state || "failed").replace("QUERY_STATE_", "").toLowerCase()}: ${String(st?.error?.message || "").slice(0, 160)}`);
  const rows: Row[] = [];
  let offset = 0;
  for (let i = 0; i < 1000; i++) {
    const page = await call(f, `/execution/${id}/results?limit=${PAGE}&offset=${offset}`);
    rows.push(...cleanRows(page?.result?.rows || []));
    if (page?.next_offset == null) break;
    offset = Number(page.next_offset);
  }
  return { rows, credits };
}

/** Add one chunk to Postgres with its marker, in one transaction. false = this chunk was already added. */
export async function applyChunk(pool: any, c: Chunk, rows: Row[], credits: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // the marker first: a chunk already added fails here (primary key), before a single score is touched
    try {
      await client.query(`insert into dune_chunks (id, rows, n, hits, credits) values ($1, $2, $3, $4, $5)`, [c.id, rows.length, rows.reduce((a, x) => a + x.n, 0), rows.reduce((a, x) => a + x.hits, 0), credits]);
    } catch (e: any) {
      await client.query("ROLLBACK").catch(() => null);
      if (e?.code === "23505" || /duplicate key|unique/i.test(String(e?.message || ""))) return false;
      throw e;
    }
    for (let i = 0; i < rows.length; i += 1000) {
      const part = rows.slice(i, i + 1000);
      const vals: unknown[] = [];
      const sql = part.map((x, j) => (vals.push(x.wallet, x.n, x.hits, x.sol), `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4}, now())`));
      await client.query(`insert into wallet_scores (wallet, n, hits, sol, updated_at) values ${sql.join(",")} on conflict (wallet) do update set n = wallet_scores.n + excluded.n, hits = wallet_scores.hits + excluded.hits, sol = coalesce(wallet_scores.sol, 0) + coalesce(excluded.sol, 0), updated_at = now()`, vals);
    }
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * The whole backfill (worker boot, once DUNE_API_KEY and Postgres are there). Chunks already in dune_chunks are
 * skipped. Stops on the first error (shown on the desk's WALLETS panel) or at the credit cap.
 */
export async function duneBackfill(pool: any, f: Fetch = fetch as any, sleep?: (ms: number) => Promise<unknown>) {
  if (!key() || !pool || duneState.running) return duneState;
  duneState.on = true;
  duneState.running = true;
  duneState.error = "";
  duneState.stopped = "";
  try {
    const all = chunks();
    duneState.chunks = all.length;
    const done = await pool.query(`select id, rows, credits from dune_chunks`);
    const have = new Map<string, any>((done.rows || []).map((x: any) => [String(x.id), x]));
    duneState.done = all.filter((c) => have.has(c.id)).length;
    duneState.credits = [...have.values()].reduce((a, x) => a + (Number(x.credits) || 0), 0);
    duneState.rows = [...have.values()].reduce((a, x) => a + (Number(x.rows) || 0), 0);
    let worst = 0;
    for (const c of all) {
      if (have.has(c.id)) continue;
      // the next chunk must fit under the cap, judged by the most expensive one so far
      if (duneState.credits + worst > maxCredits()) {
        duneState.stopped = `credit cap: ${Math.round(duneState.credits)} of ${maxCredits()} used`;
        break;
      }
      const { rows, credits } = await runChunk(c, f, sleep as any);
      worst = Math.max(worst, credits);
      // without a reported cost the cap cannot work: this chunk is kept, the rest waits (shown on the panel)
      const unknownCost = !(credits > 0);
      const added = await applyChunk(pool, c, rows, credits);
      if (added) {
        walletsAddHistory(rows);
        duneState.done++;
        duneState.rows += rows.length;
        duneState.credits += credits;
      }
      duneState.at = Date.now();
      if (unknownCost) {
        duneState.stopped = "Dune did not report what the chunk cost: stopped after it, so the credit cap stays real";
        break;
      }
    }
    // wallets that now have 3+ scored buys in Postgres come into memory
    await walletsLoad(pool);
  } catch (e: any) {
    duneState.error = String(e?.message || e).replace(/api_key=\S+/gi, "").slice(0, 200);
  } finally {
    duneState.running = false;
    duneState.at = Date.now();
  }
  return duneState;
}
