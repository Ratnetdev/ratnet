import { K, dayKey, redis } from "./redis";
import type { Call, FeedItem } from "./digger";
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
    baseRate: pct(bonded, resolved),
    calls: n(s.calls),
    callsLate: n(s.calls_late),
    callsToday: n(today?.calls),
    bond: { n: n(s.bond_n), res: n(s.bond_res), hit: n(s.bond_hit), rate: pct(n(s.bond_hit), n(s.bond_res)) },
    watch: { n: n(s.watch_n), res: n(s.watch_res), bonded: n(s.watch_bonded), rate: pct(n(s.watch_bonded), n(s.watch_res)) },
    dust: { n: n(s.dust_n), res: n(s.dust_res), hit: n(s.dust_hit), rate: pct(n(s.dust_hit), n(s.dust_res)) },
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
  const [work, last, litterCount] = await Promise.all([
    r.hgetall<Record<string, number>>(K.work(round)),
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
      last: last?.[rat.name] || null,
    })),
    scouts: last ? Object.entries(last).filter(([k]) => k.startsWith("SCOUT")).map(([name, v]) => ({ name, last: v })) : [],
  };
}
