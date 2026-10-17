// v0.1.104 ATTENTION: who is paying for this coin to be seen.
//
// DexScreener sells a token profile (the "paid" badge) and boosts. Traders read both as a team spending money on a coin;
// nobody has measured whether it predicts anything (research for the signals plan: unmeasured anywhere). So these are
// features GRID tests, not triggers.
//
// Two reads, both from DexScreener's free public API (no key):
//   live   every 10s the latest token profiles and boosts (token-profiles/latest/v1, token-boosts/latest/v1): a coin's
//          paid profile and boost amounts with the time we first saw them. Read at the King's call (no waiting).
//   truth  for every call worth testing, the coin's order history (orders/v1/solana/<mint>): each paid profile and
//          boost with its payment time. Queued after the call (never slows it) and backfilled for 14 days of calls, so
//          GRID tests on history at once. A rule reads only orders paid before the call (no look ahead).
// The live read's misses are counted against the truth (dxStats.live), so we know how far to trust it.
// Not in this build (checked): pump.fun's coin API (livestream, king of the hill, replies) now needs a login token and
// answered 404 to a plain read; GMGN has no open API. Both would break without warning.
import { redis } from "./redis";

const API = "https://api.dexscreener.com";
const HIST_KEY = "rn:dx:h"; // mint -> { p: first paid profile time | null, b: [[time, amount]...], at }
const TIMEOUT = 5000;
export type DxTruth = { p: number | null; b: [number, number][]; at: number };
export type Dx = { paid: 0 | 1 | null; boost: number | null };

const LIVE = new Map<string, { p: number | null; b: [number, number][]; tot: number }>(); // poller memory
let pollFrom = 0; // the poller's first successful read: coins created before it are unknown live
const Q: string[] = [];
const QSET = new Set<string>();
export const dxStats = { polls: 0, pollErr: "", seenProfiles: 0, seenBoosts: 0, fetched: 0, fetchErr: "", queue: 0, backfill: 0, live: { checked: 0, paidTruth: 0, paidLive: 0 } };

const isPump = (x: any) => x && x.chainId === "solana" && /pump$/.test(String(x.tokenAddress || ""));
async function getJson(path: string) {
  const r = await fetch(`${API}${path}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT) } as any);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

/** One live read (worker, every 10s): new paid profiles and boost increases on pump.fun coins. */
export async function dxPoll(now = Date.now(), get = getJson) {
  try {
    const [profiles, boosts] = await Promise.all([get("/token-profiles/latest/v1"), get("/token-boosts/latest/v1")]);
    for (const x of (Array.isArray(profiles) ? profiles : []).filter(isPump)) {
      const v = LIVE.get(x.tokenAddress) || { p: null, b: [], tot: 0 };
      if (v.p == null) (v.p = now), dxStats.seenProfiles++;
      LIVE.set(x.tokenAddress, v);
    }
    for (const x of (Array.isArray(boosts) ? boosts : []).filter(isPump)) {
      const v = LIVE.get(x.tokenAddress) || { p: null, b: [], tot: 0 };
      const tot = Number(x.totalAmount) || 0;
      if (tot > v.tot) v.b.push([now, tot - v.tot]), (v.tot = tot), dxStats.seenBoosts++;
      LIVE.set(x.tokenAddress, v);
    }
    if (LIVE.size > 20_000) for (const k of [...LIVE.keys()].slice(0, 5_000)) LIVE.delete(k);
    if (!pollFrom) pollFrom = now;
    dxStats.polls++;
    dxStats.pollErr = "";
  } catch (e: any) {
    dxStats.pollErr = String(e?.message || e).slice(0, 80);
  }
}

/** The live read at the call. Unknown (null) when the poller was not running since the coin was created. */
export function dxLive(mint: string, createdAt: number, t: number): Dx | null {
  if (!pollFrom || createdAt < pollFrom) return null;
  const v = LIVE.get(mint);
  if (!v) return { paid: 0, boost: 0 };
  return { paid: v.p != null && v.p <= t ? 1 : 0, boost: v.b.filter(([at]) => at <= t).reduce((a, [, n]) => a + n, 0) };
}

/** A coin's order history -> what was paid before time t. */
export function dxAt(o: DxTruth | null | undefined, t: number): Dx | null {
  if (!o) return null;
  return { paid: o.p != null && o.p <= t ? 1 : 0, boost: (o.b || []).filter(([at]) => at <= t).reduce((a, [, n]) => a + n, 0) };
}
/** DexScreener's orders answer -> first paid profile time and boosts (cancelled or rejected orders were not paid). */
export function dxParse(j: any, now = Date.now()): DxTruth {
  const ok = (s: any) => !/cancel|reject/i.test(String(s || ""));
  const prof = ((j?.orders || []) as any[]).filter((o) => o && o.type === "tokenProfile" && ok(o.status)).map((o) => Number(o.paymentTimestamp)).filter((x) => x > 0);
  const b = ((j?.boosts || []) as any[]).map((x) => [Number(x.paymentTimestamp), Number(x.amount) || 0] as [number, number]).filter(([t, n]) => t > 0 && n > 0).sort((a, z) => a[0] - z[0]);
  return { p: prof.length ? Math.min(...prof) : null, b, at: now };
}

/** After a call worth testing (digger): fetch its order history in the background. */
export function dxQueue(mint: string, front = true) {
  if (!mint || QSET.has(mint)) return;
  QSET.add(mint);
  if (front) Q.unshift(mint);
  else Q.push(mint);
  if (Q.length > 20_000) QSET.delete(Q.pop()!);
  dxStats.queue = Q.length;
}
/** Worker, every 2s: one order history (30 a minute, under DexScreener's 60). */
export async function dxDrain(get = getJson, now = Date.now()) {
  const mint = Q.shift();
  dxStats.queue = Q.length;
  if (!mint) return null;
  QSET.delete(mint);
  try {
    const o = dxParse(await get(`/orders/v1/solana/${mint}`), now);
    await redis().hset(HIST_KEY, { [mint]: o });
    dxStats.fetched++;
    // how good is the live read? (paid before the call per the truth, and did the poller see it in time)
    const call: any = await redis().get(`rn:call:${mint}`).catch(() => null);
    const live = call?.sx?.dx;
    if (call?.at && live) {
      dxStats.live.checked++;
      if (dxAt(o, call.at)?.paid) {
        dxStats.live.paidTruth++;
        if (live.paid === 1) dxStats.live.paidLive++;
      }
    }
    return o;
  } catch (e: any) {
    dxStats.fetchErr = `${mint.slice(0, 6)}: ${String(e?.message || e).slice(0, 60)}`;
    if (/429/.test(String(e?.message))) dxQueue(mint, false); // rate limited: try again later
    return null;
  }
}

/** Worker boot: queue the calls of the last 14 days GRID tests and has no order history for yet. */
export async function dxBackfill(pool: any, days = 14) {
  if (!pool) return 0;
  const have = new Set(Object.keys(((await redis().hgetall<Record<string, unknown>>(HIST_KEY).catch(() => null)) || {}) as object));
  const r = await pool.query(
    `select mint, data->'call' as call from launches where created_at > now() - ($1 || ' days')::interval and data->'call' is not null order by created_at desc`,
    [String(days)],
  );
  let n = 0;
  for (const x of r.rows) {
    const c = typeof x.call === "string" ? JSON.parse(x.call) : x.call;
    if (!c || c.farm || have.has(x.mint)) continue;
    const worth = (Number(c.progress) || 0) >= 4 || (c.verdict && c.verdict !== "DUST") || (c.nano?.verdict && c.nano.verdict !== "DUST") || (c.v1v && c.v1v !== "DUST");
    if (!worth) continue;
    dxQueue(x.mint, false);
    n++;
  }
  dxStats.backfill = n;
  return n;
}

/** GRID: every coin's order history (worker; a few thousand small rows). */
export async function dxHistAll(): Promise<Record<string, DxTruth>> {
  return (((await redis().hgetall<Record<string, DxTruth>>(HIST_KEY).catch(() => null)) || {}) as Record<string, DxTruth>);
}

/** Tests only. */
export function _dxReset() {
  LIVE.clear();
  Q.length = 0;
  QSET.clear();
  pollFrom = 0;
  Object.assign(dxStats, { polls: 0, pollErr: "", seenProfiles: 0, seenBoosts: 0, fetched: 0, fetchErr: "", queue: 0, backfill: 0, live: { checked: 0, paidTruth: 0, paidLive: 0 } });
}
