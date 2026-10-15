// v0.1.81: WALLETS. Every wallet that buys a pump.fun coin early (curve under 30%, 0.05 SOL or more, not the dev) is
// scored on what happened next: did the coin migrate? Fed by the FIREHOSE (every curve trade), resolved on the
// migration (hit) or 3 hours without one (miss). A wallet is "proven" once it has 6+ scored early buys and the lower
// bound of its hit rate (Wilson, 95%) is at least 3x the base rate of all early buys (8% at the least). Scores are kept
// in Postgres (wallet_scores) so they survive restarts and grow every day; Dune history can seed them (v0.1.82).
export const EARLY_PROG = 30;
export const MIN_SOL = 0.05;
export const RESOLVE_MS = 3 * 3600_000;
const MAX_BUYERS = 150; // early buyers kept per coin
const MAX_MINTS = 80_000;

type Early = { at: number; prog: number; sol: number };
type MintE = { created: number; creator?: string; buyers: Map<string, Early>; proven: Set<string> };
export type WStat = { n: number; hits: number; sol: number; at: number; dirty?: boolean };

const MINTS = new Map<string, MintE>();
const STATS = new Map<string, WStat>();
const BASE = { n: 0, hits: 0 };
export const walletStats = { buys: 0, resolved: 0, hits: 0, loaded: 0, saved: 0 };

export function wilsonLo(k: number, n: number, z = 1.96) {
  if (!n) return 0;
  const p = k / n;
  const d = 1 + (z * z) / n;
  return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d);
}
export const baseRate = () => (BASE.n >= 500 ? BASE.hits / BASE.n : 0.022); // King's base rate until enough resolved
export function isProven(w: string) {
  const s = STATS.get(w);
  if (!s || s.n < 6) return false;
  return wilsonLo(s.hits, s.n) >= Math.max(0.08, 3 * baseRate());
}
const entry = (mint: string, at: number) => {
  let m = MINTS.get(mint);
  if (!m) {
    if (MINTS.size >= MAX_MINTS) MINTS.delete(MINTS.keys().next().value as string); // oldest, unscored
    m = { created: at, buyers: new Map(), proven: new Set() };
    MINTS.set(mint, m);
  }
  return m;
};

export function walletCreate(mint: string, creator: string, at = Date.now()) {
  entry(mint, at).creator = creator;
}
/** A curve trade (FIREHOSE). `prog` is the curve % after the trade. */
export function walletTrade(t: { mint: string; user: string; isBuy: boolean; sol: number; at: number; venue: string; creator?: string }, prog: number) {
  if (t.venue !== "curve" || !t.isBuy) return;
  const m = entry(t.mint, t.at);
  if (t.creator && !m.creator) m.creator = t.creator;
  if (t.user === m.creator) return;
  if (isProven(t.user) && m.proven.size < 50) m.proven.add(t.user);
  if (prog >= EARLY_PROG || t.sol < MIN_SOL || m.buyers.has(t.user) || m.buyers.size >= MAX_BUYERS) return;
  m.buyers.set(t.user, { at: t.at, prog, sol: t.sol });
  walletStats.buys++;
}
function resolve(mint: string, hit: boolean, now: number) {
  const m = MINTS.get(mint);
  if (!m) return;
  MINTS.delete(mint);
  for (const [w, e] of m.buyers) {
    const s = STATS.get(w) || { n: 0, hits: 0, sol: 0, at: now };
    s.n++;
    if (hit) s.hits++;
    s.sol = Math.round((s.sol + e.sol) * 1000) / 1000;
    s.at = now;
    s.dirty = true;
    STATS.set(w, s);
    BASE.n++;
    if (hit) BASE.hits++;
  }
  walletStats.resolved++;
  if (hit) walletStats.hits++;
}
export const walletComplete = (mint: string, now = Date.now()) => resolve(mint, true, now);
/** Every few minutes: coins 3 hours old without a migration are misses. */
export function walletSweep(now = Date.now()) {
  let n = 0;
  for (const [mint, m] of MINTS) {
    if (now - m.created < RESOLVE_MS) break; // insertion order = age order
    resolve(mint, false, now);
    n++;
  }
  return n;
}
/** Proven wallets that bought this coin so far (any curve %). */
export const provenBuyers = (mint: string) => MINTS.get(mint)?.proven.size ?? 0;

/** Postgres: wallet_scores. Load the scored wallets at boot, save the changed ones every few minutes. */
export async function walletsLoad(pool: any) {
  if (!pool) return 0;
  const r = await pool.query(`select wallet, n, hits, sol from wallet_scores where n >= 3 order by updated_at desc limit 400000`).catch(() => ({ rows: [] }));
  for (const x of r.rows) STATS.set(x.wallet, { n: Number(x.n), hits: Number(x.hits), sol: Number(x.sol) || 0, at: Date.now() });
  const b = await pool.query(`select coalesce(sum(n),0) as n, coalesce(sum(hits),0) as hits from wallet_scores`).catch(() => ({ rows: [] }));
  if (b.rows[0]) (BASE.n = Number(b.rows[0].n) || 0), (BASE.hits = Number(b.rows[0].hits) || 0);
  walletStats.loaded = r.rows.length;
  return r.rows.length;
}
export async function walletsSave(pool: any) {
  if (!pool) return 0;
  const dirty = [...STATS.entries()].filter(([, s]) => s.dirty && s.n >= 2);
  let n = 0;
  for (let i = 0; i < dirty.length; i += 500) {
    const part = dirty.slice(i, i + 500);
    const vals: unknown[] = [];
    const rows = part.map(([w, s], j) => {
      vals.push(w, s.n, s.hits, s.sol);
      return `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4}, now())`;
    });
    const ok = await pool
      .query(`insert into wallet_scores (wallet, n, hits, sol, updated_at) values ${rows.join(",")} on conflict (wallet) do update set n = excluded.n, hits = excluded.hits, sol = excluded.sol, updated_at = now()`, vals)
      .then(() => true)
      .catch(() => false);
    if (ok) for (const [, s] of part) (s.dirty = false), n++;
  }
  // memory: wallets that never scored twice and have not bought in 2 days are dropped (they are in Postgres if n >= 2)
  const old = Date.now() - 2 * 86400_000;
  if (STATS.size > 600_000) for (const [w, s] of STATS) if (s.n < 2 && s.at < old) STATS.delete(w);
  walletStats.saved += n;
  return n;
}
export function walletsView() {
  const base = baseRate();
  const scored = [...STATS.entries()].filter(([, s]) => s.n >= 6);
  const proven = scored.filter(([w]) => isProven(w));
  const top = proven
    .map(([w, s]) => ({ w: `${w.slice(0, 4)}…${w.slice(-4)}`, n: s.n, hits: s.hits, rate: Math.round((s.hits / s.n) * 1000) / 10, lo: Math.round(wilsonLo(s.hits, s.n) * 1000) / 10 }))
    .sort((a, b) => b.lo - a.lo)
    .slice(0, 20);
  return { at: Date.now(), wallets: STATS.size, scored: scored.length, proven: proven.length, base: Math.round(base * 1000) / 10, pending: MINTS.size, ...walletStats, top };
}
/** Tests. */
export function _walletsReset() {
  MINTS.clear();
  STATS.clear();
  BASE.n = 0;
  BASE.hits = 0;
  Object.assign(walletStats, { buys: 0, resolved: 0, hits: 0, loaded: 0, saved: 0 });
}
export const _walletStat = (w: string) => STATS.get(w);
