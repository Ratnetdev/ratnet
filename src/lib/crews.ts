// v0.1.128 CREWS (after CRAWLNET's "if 5 top traders who follow each other all buy the same coin, she counts them as
// one"). Wallets worth watching (proven, earners, FOMO) that keep buying the same coin within a few seconds of each
// other are one crew: copy-traders, one person's side wallets, a group chat. A crew counts as ONE buyer, so a coin
// can't look like "5 proven wallets bought" when it is one person with five wallets.
//
// Built from the firehose alone (no chain reads): two watched wallets that bought the same coin within CO_SEC seconds
// of each other on CREW_MIN different coins are joined. Joins are kept (Redis) and rebuilt at boot.

export const CO_SEC = 3;
export const CREW_MIN = 3; // shared quick buys before two wallets are one crew
// v0.1.130: no crew grows past CREW_MAX (20 Oct: bots chained 1,755 wallets into one crew, which made every proven buyer
// "one crew"); bots never join (lib/smartbuy.ts)
export const CREW_MAX = 20;
const PAIRS_MAX = 300_000;
const EDGES_MAX = 50_000;

const RECENT = new Map<string, { w: string; at: number }[]>(); // mint -> watched buyers in the last CO_SEC
const PAIRS = new Map<string, { n: number; last: string }>(); // "a|b" -> shared quick buys (distinct coins)
const PARENT = new Map<string, string>();
const SIZE = new Map<string, number>(); // root -> wallets in its crew
let EDGES: [string, string][] = [];
export const crewStats = { pairs: 0, joins: 0, crews: 0 };

export function crewFind(w: string): string {
  let r = w;
  let g = 0;
  while (PARENT.has(r) && PARENT.get(r) !== r && g++ < 64) r = PARENT.get(r)!;
  // path halving
  let x = w;
  while (PARENT.has(x) && PARENT.get(x) !== r && g++ < 128) {
    const nx = PARENT.get(x)!;
    PARENT.set(x, r);
    x = nx;
  }
  return r;
}
function union(a: string, b: string) {
  const ra = crewFind(a);
  const rb = crewFind(b);
  if (ra === rb) return false;
  const sa = SIZE.get(ra) || 1;
  const sb = SIZE.get(rb) || 1;
  if (sa + sb > CREW_MAX) return false;
  if (!PARENT.has(ra)) PARENT.set(ra, ra);
  PARENT.set(rb, ra);
  SIZE.set(ra, sa + sb);
  SIZE.delete(rb);
  return true;
}

/** A buy by a watched wallet. */
export function crewBuy(mint: string, w: string, at: number) {
  let a = RECENT.get(mint);
  if (!a) {
    a = [];
    RECENT.set(mint, a);
    if (RECENT.size > 20_000) RECENT.delete(RECENT.keys().next().value as string);
  }
  while (a.length && at - a[0].at > CO_SEC * 1000) a.shift();
  for (const o of a) {
    if (o.w === w) continue;
    const k = o.w < w ? `${o.w}|${w}` : `${w}|${o.w}`;
    const p = PAIRS.get(k) || { n: 0, last: "" };
    if (p.last === mint) continue; // one count per coin
    p.n++;
    p.last = mint;
    PAIRS.set(k, p);
    if (PAIRS.size > PAIRS_MAX) PAIRS.delete(PAIRS.keys().next().value as string);
    if (p.n === CREW_MIN) {
      const [x, y] = k.split("|");
      if (union(x, y)) crewStats.joins++;
      EDGES.push([x, y]);
      if (EDGES.length > EDGES_MAX) EDGES = EDGES.slice(-EDGES_MAX);
    }
  }
  if (!a.some((o) => o.w === w)) a.push({ w, at });
  crewStats.pairs = PAIRS.size;
}

/** How many independent buyers: wallets in the same crew count once. */
export function independent(ws: Iterable<string>): number {
  const s = new Set<string>();
  for (const w of ws) s.add(crewFind(w));
  return s.size;
}

export const crewEdges = () => EDGES;
export function crewLoad(edges: [string, string][]) {
  for (const [a, b] of edges || []) if (a && b && union(a, b)) crewStats.joins++;
  EDGES = (edges || []).slice(-EDGES_MAX);
}
export function crewView() {
  const size = new Map<string, number>();
  for (const w of PARENT.keys()) {
    const r = crewFind(w);
    size.set(r, (size.get(r) || 0) + 1);
  }
  const crews = [...size.values()].filter((n) => n >= 2);
  crewStats.crews = crews.length;
  return { pairs: PAIRS.size, joins: crewStats.joins, crews: crews.length, wallets: crews.reduce((a, n) => a + n, 0), biggest: crews.sort((a, z) => z - a).slice(0, 5) };
}
export function _crewReset() {
  RECENT.clear();
  PAIRS.clear();
  PARENT.clear();
  SIZE.clear();
  EDGES = [];
  crewStats.pairs = crewStats.joins = crewStats.crews = 0;
}
