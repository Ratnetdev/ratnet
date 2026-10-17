// v0.1.103 ORIGIN: the original or a copy, the alpha or a beta.
//
// Measured (Szwajcok et al. 2026, 15.2M pump.fun coins): originals graduate at 9.2%, copycats at 0.86%. Traders say the
// same: the first coin of a meme wins, betas reach ~10% of the alpha. Creators: serial launch factories do worse after
// their first coin; low-automation creators graduate up to ~14x the base rate.
//
// Every launch (both feeds, at its create) goes into a 7-day index by name, by ticker and, once dug, by image (pump.fun
// images are IPFS content ids: the same picture re-uploaded has the same id). From it, at the King's call:
//   rank   1 = the first coin of its name, ticker and image in 7 days; 2+ = how many came before it (a copy)
//   cr     the creator's launches in the 7 days before this one (0 = a first launch, 10+ = a launch factory)
//   alpha  1 = the biggest coin of its name/ticker group right now (a group of 2+ in the last 48h); 0 = not
//   beta   1 = under 10% of that group's biggest coin; 0 = not
// Unknown stays null and never passes a rule. Older calls get rank and cr from the archive (computed in time order,
// nothing from after the coin's creation); alpha and beta exist only from this build on (they need live prices).
import { norm } from "./seer";

const WEEK = 7 * 86400_000;
const RECENT = 48 * 3600_000; // alpha/beta compare a coin with its group's coins of the last 48h
type Ent = { m: string; t: number };
const GROUPS = new Map<string, Ent[]>(); // "n:name" | "t:ticker" | "i:image" -> coins, in creation order
const CREATORS = new Map<string, number[]>(); // creator -> creation times
const KEYS = new Map<string, { t: number; k: string[]; c?: string }>(); // mint -> its creation time, group keys, creator
const MC = new Map<string, number>(); // mint -> last market cap (SOL) seen on the firehose
const HIST = new Map<string, { rank: number; cr: number }>(); // archive calls: their origin as of their creation
let loaded = false;
let lastPrune = 0;
export const originStats = { loaded: false, rows: 0, hist: 0, loadMs: 0, error: "", index: 0 };

export type Og = { rank: number; cr: number; alpha: 0 | 1 | null; beta: 0 | 1 | null };

const keysOf = (name: string, symbol: string) => {
  const k: string[] = [];
  const n = norm(name);
  const t = norm(symbol);
  if (n.length >= 3) k.push(`n:${n}`);
  if (t.length >= 2) k.push(`t:${t}`);
  return k;
};
/** pump.fun images: https://.../ipfs/<cid> (or ipfs://<cid>). Only a content id counts: the same id is the same bytes. */
export function cidOf(image: string): string | null {
  const m = String(image || "").match(/(?:ipfs\/|ipfs:\/\/)([A-Za-z0-9]{40,80})/);
  return m ? m[1] : null;
}

function insert(arr: Ent[], e: Ent) {
  // feeds can deliver a little out of order: keep creation order
  let i = arr.length;
  while (i > 0 && arr[i - 1].t > e.t) i--;
  arr.splice(i, 0, e);
}
/** Coins of these groups created before t (7-day window), counted once each. */
function before(keys: string[], mint: string, t: number) {
  const seen = new Set<string>();
  for (const k of keys)
    for (const e of GROUPS.get(k) || []) {
      if (e.t >= t) break;
      if (e.m !== mint && e.t > t - WEEK) seen.add(e.m);
    }
  return seen.size;
}
function crBefore(creator: string, t: number) {
  if (!creator) return 0;
  let n = 0;
  for (const x of CREATORS.get(creator) || []) if (x < t && x > t - WEEK) n++;
  return n;
}
function add(mint: string, name: string, symbol: string, creator: string, t: number) {
  if (KEYS.has(mint)) return false;
  const k = keysOf(name, symbol);
  KEYS.set(mint, { t, k, c: creator || undefined });
  for (const key of k) {
    const a = GROUPS.get(key);
    if (a) insert(a, { m: mint, t });
    else GROUPS.set(key, [{ m: mint, t }]);
  }
  if (creator) {
    const c = CREATORS.get(creator);
    if (c) c.push(t);
    else CREATORS.set(creator, [t]);
  }
  return true;
}
/** Drop what is older than 7 days (relative to `now`). */
export function originPrune(now = Date.now()) {
  const cut = now - WEEK;
  for (const [k, a] of GROUPS) {
    let i = 0;
    while (i < a.length && a[i].t < cut) i++;
    if (i === a.length) GROUPS.delete(k);
    else if (i) a.splice(0, i);
  }
  for (const [c, ts] of CREATORS) {
    const keep = ts.filter((x) => x >= cut);
    if (!keep.length) CREATORS.delete(c);
    else if (keep.length !== ts.length) CREATORS.set(c, keep);
  }
  for (const [m, v] of KEYS) if (v.t < cut) KEYS.delete(m), MC.delete(m);
  originStats.index = KEYS.size;
}

/** A new launch (worker: both feeds, at the create). Idempotent per coin. */
export function originSee(mint: string, name: string, symbol: string, creator: string, at: number) {
  if (!mint) return;
  add(mint, name, symbol, creator, at);
  if (at - lastPrune > 3600_000) (lastPrune = at), originPrune(at);
}
/** The dig read the coin's image: same content id as an earlier coin = a copy of its picture. */
export function originImage(mint: string, image: string) {
  const cid = cidOf(image);
  const v = KEYS.get(mint);
  if (!cid || !v || v.k.some((k) => k.startsWith("i:"))) return;
  const key = `i:${cid}`;
  v.k.push(key);
  const a = GROUPS.get(key);
  if (a) insert(a, { m: mint, t: v.t });
  else GROUPS.set(key, [{ m: mint, t: v.t }]);
}
/** Market caps from the firehose (every trade), for the coins in the index. */
export function originMc(mint: string, mcSol: number | undefined) {
  if (mcSol && mcSol > 0 && KEYS.has(mint)) MC.set(mint, mcSol);
}

/** The origin read at the King's call (worker). null until the index is loaded or for a coin it never saw. */
export function originAt(mint: string, creator?: string | null, now = Date.now()): Og | null {
  const v = KEYS.get(mint);
  if (!loaded || !v) return null;
  const rank = before(v.k, mint, v.t) + 1;
  // alpha/beta: the group = same name or ticker (not image: a picture is often reused across unrelated names)
  let mx = 0;
  let n = 0;
  for (const k of v.k) {
    if (k.startsWith("i:")) continue;
    for (const e of GROUPS.get(k) || []) {
      if (e.m === mint || e.t < now - RECENT) continue;
      n++;
      mx = Math.max(mx, MC.get(e.m) || 0);
    }
  }
  const mine = MC.get(mint) || 0;
  const known = n > 0 && mx > 0 && mine > 0;
  return { rank, cr: crBefore(creator || v.c || "", v.t), alpha: known ? (mine >= mx ? 1 : 0) : null, beta: known ? (mine < mx * 0.1 ? 1 : 0) : null };
}
/** Older calls (GRID): their rank and creator count, as of their creation. */
export const originHist = (mint: string) => HIST.get(mint) || null;
export const originLoaded = () => loaded;
/** v0.1.110: a coin's creation time, if the index has it (every-launch books need it for the DexScreener read). */
export const originCreated = (mint: string) => KEYS.get(mint)?.t ?? null;

/**
 * Worker boot: read 21 days of launches from the archive in time order (pages of 20K). Calls from the 14 days GRID
 * tests get their origin as of their creation (only coins before them count); the last 7 days stay as the live index.
 */
export async function originLoad(pool: any, now = Date.now(), days = 21, page = 20_000) {
  const t0 = Date.now();
  if (!pool) return (originStats.error = "no archive: origin stays unknown"), 0;
  let from = new Date(now - days * 86400_000).toISOString();
  let lastMint = "";
  let rows = 0;
  try {
    for (;;) {
      const r = await pool.query(
        `select mint, name, symbol, creator, created_at, (data->'call') is not null as called from launches
         where (created_at, mint) > ($1::timestamptz, $2) and created_at <= $3 order by created_at, mint limit $4`,
        [from, lastMint, new Date(now).toISOString(), page],
      );
      for (const x of r.rows) {
        const t = new Date(x.created_at).getTime();
        if (!x.mint || !Number.isFinite(t)) continue;
        const fresh = add(String(x.mint), String(x.name || ""), String(x.symbol || ""), String(x.creator || ""), t);
        if (fresh && x.called) {
          const v = KEYS.get(String(x.mint))!;
          HIST.set(String(x.mint), { rank: before(v.k, String(x.mint), t) + 1, cr: crBefore(String(x.creator || ""), t) });
        }
      }
      rows += r.rows.length;
      if (r.rows.length < page) break;
      const last = r.rows[r.rows.length - 1];
      from = new Date(last.created_at).toISOString();
      lastMint = String(last.mint);
      originPrune(new Date(last.created_at).getTime()); // the window slides with the rows
      await new Promise((ok) => setTimeout(ok, 50)); // let the worker breathe between pages
    }
    originPrune(now);
  } catch (e: any) {
    originStats.error = String(e?.message || e).slice(0, 120);
  }
  loaded = true;
  Object.assign(originStats, { loaded: true, rows, hist: HIST.size, loadMs: Date.now() - t0, index: KEYS.size });
  return rows;
}

/** Tests only. */
export function _originReset(isLoaded = true) {
  GROUPS.clear();
  CREATORS.clear();
  KEYS.clear();
  MC.clear();
  HIST.clear();
  loaded = isLoaded;
  lastPrune = 0;
}
