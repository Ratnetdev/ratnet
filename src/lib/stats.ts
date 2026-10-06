import { sealFor } from "./receipts";
import { whyOf } from "./why";
import { K, dayKey, redis } from "./redis";
import type { Call, FeedItem, Grad, Launch } from "./digger";
import { loadModel } from "./digger";
import { NANO_MIN } from "./nano";
import { getMarket, type Mkt } from "./market";
import { getCurves, solUsd } from "./solana";
import { poolUsd, readPools } from "./pool";
import { runViews, RunView } from "./runner";
import { getSettings } from "./settings";
import { allRats, isActive, roundOf, roundStart } from "./rats";
import { ROUND_MS } from "@/config/site";

const n = (v: unknown) => Number(v || 0);
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export async function getStats() {
  const r = redis();
  const [st, today, dueCount, since] = await Promise.all([
    r.hgetall<Record<string, number>>(K.stat),
    r.hgetall<Record<string, number>>(K.day(dayKey())),
    r.zcard(K.due),
    r.get<number>("rn:epoch:at"),
  ]);
  const s = st || {};
  const resolved = n(s.resolved);
  const bonded = n(s.bonded);
  return {
    since: since ? Number(since) : null, // the clean public record starts here
    dug: n(s.dug),
    dugToday: n(today?.dug),
    tracking: n(dueCount),
    resolved,
    bonded,
    alive: n(s.alive),
    died: n(s.died),
    baseRate: pct(bonded, n(s.dug)),
    calls: n(s.calls),
    callsLate: n(s.calls_late),
    callsMissed: n(s.calls_missed),
    callsToday: n(today?.calls),
    // BOND rate = bonded so far / all counted BOND calls. Pending calls count as misses until they bond,
    // so the number can only go up as calls resolve. No early 100% from bonds resolving first.
    bond: { n: n(s.bond_n), res: n(s.bond_res), hit: n(s.bond_hit), rate: pct(n(s.bond_hit), n(s.bond_n)) },
    watch: { n: n(s.watch_n), res: n(s.watch_res), bonded: n(s.watch_bonded), rate: pct(n(s.watch_bonded), n(s.watch_res)) },
    dust: { n: n(s.dust_n), res: n(s.dust_res), hit: n(s.dust_hit), rate: pct(n(s.dust_hit), n(s.dust_res)) },
    nano: {
      bond: { n: n(s.nbond_n), res: n(s.nbond_res), hit: n(s.nbond_hit), rate: pct(n(s.nbond_hit), n(s.nbond_n)) },
      watch: { n: n(s.nwatch_n), res: n(s.nwatch_res), bonded: n(s.nwatch_bonded), rate: pct(n(s.nwatch_bonded), n(s.nwatch_res)) },
      dust: { n: n(s.ndust_n), res: n(s.ndust_res), hit: n(s.ndust_hit), rate: pct(n(s.ndust_hit), n(s.ndust_res)) },
    },
    // honest scoreboard: BOND calls graded at their 2-hour label only (no pending), and how many of all bonds were caught
    honest: (() => {
      const ln = n(s.lbond_n), lh = n(s.lbond_hit), lb = n(s.lbonded);
      const vers = Array.from(new Set(Object.keys(s).filter((k) => k.startsWith("lb:")).map((k) => k.split(":")[1])));
      return {
        n: ln,
        hit: lh,
        prec: pct(lh, ln),
        bonds: lb,
        recall: pct(lh, lb),
        byVersion: vers.map((v) => ({ v, n: n((s as any)[`lb:${v}:n`]), hit: n((s as any)[`lb:${v}:hit`]), prec: pct(n((s as any)[`lb:${v}:hit`]), n((s as any)[`lb:${v}:n`])) })).sort((a, b) => a.v.localeCompare(b.v)),
      };
    })(),
    gaps: n(s.gaps),
    burnedRat: n(s.burned),
    sniffs: n(s.sniffs),
  };
}

export async function getFeed(limit = 40) {
  return ((await redis().lrange<FeedItem>(K.feed, 0, limit - 1)) || []) as FeedItem[];
}

export async function getCalls(limit = 60, offset = 0): Promise<Call[]> {
  const r = redis();
  const mints = (await r.zrange<string[]>(K.calls, offset, offset + limit - 1, { rev: true })) || [];
  if (!mints.length) return [];
  const calls = await r.mget<(Call | null)[]>(...mints.map((m) => K.call(m)));
  return calls.filter((c): c is Call => !!c).map((c) => ({ ...c, parts: undefined, nc: undefined }));
}

/** The latest counted BOND calls (King or nano), newest first. */
export async function getBondCalls(limit = 8): Promise<Call[]> {
  const r = redis();
  const mints = ((await r.lrange<string>("rn:bondcalls", 0, limit - 1)) || []) as string[];
  if (!mints.length) return [];
  const calls = await r.mget<(Call | null)[]>(...mints.map((m) => K.call(m)));
  return calls.filter((c): c is Call => !!c).map((c) => ({ ...c, parts: undefined, nc: undefined }));
}

export async function getResolvedCalls(limit = 40): Promise<Call[]> {
  return ((await redis().lrange<Call>(K.callRes, 0, limit - 1)) || []) as Call[];
}

export async function getRatBoard() {
  const s = await getSettings();
  const rats = await allRats();
  const r = redis();
  const round = roundOf();
  const [work, workAll, last, litterCount] = await Promise.all([
    r.hgetall<Record<string, number>>(K.work(round)),
    r.hgetall<Record<string, number>>(K.workAll),
    r.hgetall<Record<string, { mint: string; symbol: string; at: number; kind: string }>>(K.ratLast),
    r.get<number>(K.litterCount(s.litter.n)),
  ]);
  return {
    settings: s,
    round: { id: round, startsAt: roundStart(round), endsAt: roundStart(round) + ROUND_MS },
    litter: { ...s.litter, spawned: Math.min(n(litterCount), s.litter.size) },
    rats: rats.map((rat) => ({
      ...rat,
      active: isActive(rat, s),
      work: n(work?.[rat.name]),
      workAll: n(workAll?.[rat.name]),
      last: last?.[rat.name] || null,
    })),
    scouts: last ? Object.entries(last).filter(([k]) => k.startsWith("SCOUT")).map(([name, v]) => ({ name, last: v })) : [],
  };
}

export type RadarRow = {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  createdAt: number;
  pNow: number;
  peak: number;
  mcapNow: number;
  devN: number;
  devB: number;
  socials: number;
  call: { score: number; verdict: string; nano: { score: number; verdict: string } | null } | null;
  mkt?: Mkt | null;
  mcUsd?: number | null;
};

export async function getRadar(limit = 15): Promise<RadarRow[]> {
  const r = redis();
  const flat = (await r.zrange<(string | number)[]>(K.radar, 0, limit - 1, { rev: true, withScores: true })) || [];
  const mints: string[] = [];
  const pNow: Record<string, number> = {};
  for (let i = 0; i < flat.length; i += 2) {
    mints.push(String(flat[i]));
    pNow[String(flat[i])] = Number(flat[i + 1]);
  }
  if (!mints.length) return [];
  const [recs, peaks] = await Promise.all([r.mget<(Launch | null)[]>(...mints.map((m) => K.launch(m))), r.zmscore(K.peak, mints)]);
  const peakOf: Record<string, number> = {};
  mints.forEach((m, i) => (peakOf[m] = Number(peaks?.[i] ?? 0)));
  const [mkt, sol, cv] = await Promise.all([getMarket(mints).catch(() => ({} as Record<string, Mkt | null>)), solUsd(), getCurves(mints).catch(() => ({} as Record<string, any>))]);
  return recs
    .filter((l): l is Launch => !!l && !l.outcome)
    .map((l) => ({
      mint: l.mint,
      symbol: l.symbol,
      name: l.name,
      image: l.image,
      createdAt: l.createdAt,
      pNow: pNow[l.mint] ?? l.pNow ?? l.p0,
      peak: Math.max(peakOf[l.mint] || 0, l.peak ?? 0, pNow[l.mint] ?? 0),
      mcapNow: l.mcapNow ?? l.mcap0,
      devN: l.devN ?? 0,
      devB: l.devB ?? 0,
      socials: [l.twitter, l.telegram, l.website].filter(Boolean).length,
      call: l.call ? { score: l.call.score, verdict: l.call.verdict, nano: l.call.nano } : null,
      mkt: mkt[l.mint] ?? null,
      // the curve itself is the truth for coins still on it (one RPC call for the whole radar)
      mcUsd: sol && cv[l.mint]?.mcapSol ? Math.round(cv[l.mint].mcapSol * sol) : mkt[l.mint]?.mc ?? (sol && l.mcapNow ? Math.round(l.mcapNow * sol) : null),
    }));
}

export async function getGrads(limit = 30): Promise<(Grad & { run?: RunView })[]> {
  const grads = ((await redis().lrange<Grad>(K.grads, 0, limit - 1)) || []) as Grad[];
  const views = await runViews(grads.map((g) => g.mint)).catch(() => ({} as Record<string, RunView>));
  return grads.map((g) => (views[g.mint] ? { ...g, run: views[g.mint] } : g));
}

export async function getCoin(mint: string) {
  const r = redis();
  const [launch, call, live, peak] = await Promise.all([
    r.get<Launch>(K.launch(mint)),
    r.get<Call>(K.call(mint)),
    r.zscore(K.radar, mint),
    r.zscore(K.peak, mint),
  ]);
  if (launch && !launch.outcome) {
    if (live != null) launch.pNow = Number(live);
    if (peak != null) launch.peak = Math.max(launch.peak ?? 0, Number(peak));
  }
  // market cap straight from the chain (curve or canonical pool); DexScreener only adds volume and flow
  const onPool = !!launch && (launch.outcome === "BONDED" || !!launch.completeAt);
  const [mktAll, runs, chain, sol] = await Promise.all([
    getMarket([mint]).catch(() => ({} as Record<string, Mkt | null>)),
    runViews([mint]).catch(() => ({} as Record<string, RunView>)),
    (onPool ? readPools([mint]).then((x) => ({ pool: x[mint] ?? null, curve: null })) : getCurves([mint]).then((x) => ({ pool: null, curve: x[mint] ?? null }))).catch(() => ({ pool: null, curve: null })),
    solUsd().catch(() => null),
  ]);
  let mkt = mktAll[mint] ?? null;
  const supply = launch?.supply || 1e9;
  const mcChain = sol ? (chain.pool ? poolUsd(chain.pool, sol, supply) : chain.curve && !chain.curve.complete ? chain.curve.mcapSol * sol : 0) : 0;
  if (mcChain > 0) mkt = { ...(mkt || { v5: 0, v1: 0, v24: 0, c5: null, c1: null, liq: null, b1: 0, s1: 0, dex: onPool ? "pumpswap" : "pumpfun", url: `https://dexscreener.com/solana/${mint}`, pn: null, bo: 0, pf: false }), mc: Math.round(mcChain), ...(chain.pool ? { liq: Math.round(chain.pool.sol * 2 * (sol || 0)) } : {}) };
  if (launch) {
    // the desk-only bits stay private: insider token accounts are not needed on the page
    if (launch.tape) launch.tape = { ...launch.tape, insiders: [], early: [] };
  }
  const c0 = call || launch?.call || null;
  // the numbers behind a call (v0 points, nano pulls, the feature vector) are admin only
  const c = c0 ? ({ ...c0, x: [], parts: undefined, nc: undefined } as Call) : null;
  if (launch?.call) launch.call = c!;
  if (c && !c.why && launch) c.why = whyOf({ ...launch, progress: c.progress, progress0: launch.p0, twitter: !!launch.twitter, telegram: !!launch.telegram, website: !!launch.website, tape: launch.tape ?? null, g: launch.g ?? null, meta: launch.meta ?? null });
  const seal = c?.counted ? await sealFor(c.at).catch(() => null) : null;
  return { launch, call: c, mkt, run: runs[mint] ?? null, seal: seal ? { hour: seal.hour, sig: seal.sig, sha: seal.sha, n: seal.n } : null };
}

export async function getNano() {
  const [model, log] = await Promise.all([loadModel(), redis().lrange(K.nanoLog, 0, -1)]);
  return { model, log: log || [], min: NANO_MIN };
}

export type Bucket = { lo: number; n: number; b: number; rate: number | null };
export type HourRow = { h: number; d: number; b: number; bn: number; bh: number; nbn: number; nbh: number };

/** Everything the site needs to prove the score means something. */
export async function getProof() {
  const r = redis();
  const now = Date.now();
  const hours = Array.from({ length: 24 }, (_, i) => Math.floor(now / 3600_000) * 3600_000 - (23 - i) * 3600_000);
  const p = r.pipeline();
  p.hgetall(K.calib);
  p.hgetall(K.stat);
  for (const h of hours) p.hgetall(K.hr(new Date(h).toISOString().slice(0, 13)));
  const res = (await p.exec()) as (Record<string, unknown> | null)[];
  const calib = res[0] || {};
  const st = res[1] || {};
  const mk = (pre: string): Bucket[] =>
    Array.from({ length: 10 }, (_, i) => {
      const nn = n(calib[`${pre}${i}n`]);
      const bb = n(calib[`${pre}${i}b`]);
      return { lo: i * 10, n: nn, b: bb, rate: pct(bb, nn) };
    });
  const hourly: HourRow[] = hours.map((h, i) => {
    const x = res[i + 2] || {};
    return { h, d: n(x.d), b: n(x.b), bn: n(x.bn), bh: n(x.bh), nbn: n(x.nbn), nbh: n(x.nbh) };
  });
  const grads = await getGrads(120);
  const receipts = grads.filter((g) => g.v0?.verdict === "BOND" && g.v0.counted && g.lead != null).slice(0, 8);
  return {
    v0: mk("v"),
    nano: mk("n"),
    hourly,
    leadAvg: n(st.lead_n) ? Math.round(n(st.lead_sum) / n(st.lead_n)) : null,
    leadN: n(st.lead_n),
    receipts,
  };
}
