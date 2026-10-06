import { K, dayKey, redis } from "./redis";
import type { Call, FeedItem, Grad, Launch } from "./digger";
import { loadModel } from "./digger";
import { NANO_MIN } from "./nano";
import { getSettings } from "./settings";
import { allRats, isActive, roundOf, roundStart } from "./rats";
import { ROUND_MS } from "@/config/site";

const n = (v: unknown) => Number(v || 0);
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export async function getStats() {
  const r = redis();
  const [st, today, dueCount] = await Promise.all([
    r.hgetall<Record<string, number>>(K.stat),
    r.hgetall<Record<string, number>>(K.day(dayKey())),
    r.zcard(K.due),
  ]);
  const s = st || {};
  const resolved = n(s.resolved);
  const bonded = n(s.bonded);
  return {
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
  return calls.filter((c): c is Call => !!c);
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
    }));
}

export async function getGrads(limit = 30): Promise<Grad[]> {
  return ((await redis().lrange<Grad>(K.grads, 0, limit - 1)) || []) as Grad[];
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
  return { launch, call: call || launch?.call || null };
}

export async function getNano() {
  const [model, log] = await Promise.all([loadModel(), redis().lrange(K.nanoLog, 0, -1)]);
  return { model, log: log || [], min: NANO_MIN };
}
