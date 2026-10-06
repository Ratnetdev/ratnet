// META: the narrative of the moment, and copycats.
// Research (arXiv 2609.10246): copycat coins graduate at 0.86% vs 9.2% for originals, so cloning a recent winner is a
// negative signal, while sharing a word with what is bonding right now (the hot meta) is tracked as a positive one.
// Two day-buckets per key keep a rolling ~24 to 48h window at a fixed number of Redis commands per run.

import { dayKey, redis } from "./redis";

const STOP = new Set(["the", "and", "for", "coin", "token", "sol", "solana", "pump", "fun", "official", "inu", "meme", "new", "with", "this", "that", "you", "are", "from"]);
const TTL = 60 * 60 * 24 * 3;
const MK = {
  wl: (d: string) => `rn:mw:l:${d}`, // word -> launches
  wb: (d: string) => `rn:mw:b:${d}`, // word -> bonds
  tl: (d: string) => `rn:mt:l:${d}`, // ticker -> launches
  tb: (d: string) => `rn:mt:b:${d}`, // ticker -> bonds
};

export function words(name: string, symbol: string) {
  const out = new Set<string>();
  for (const w of `${name} ${symbol}`.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3 && w.length <= 20 && !STOP.has(w)) out.add(w);
  return Array.from(out).slice(0, 6);
}
export const tick = (s: string) => (s || "").trim().toUpperCase().slice(0, 16);

type Pipe = { hincrby: (k: string, f: string, n: number) => unknown; expire: (k: string, s: number) => unknown };

export function metaLaunch(p: Pipe, name: string, symbol: string) {
  const d = dayKey();
  for (const w of words(name, symbol)) p.hincrby(MK.wl(d), w, 1);
  if (symbol) p.hincrby(MK.tl(d), tick(symbol), 1);
  p.expire(MK.wl(d), TTL);
  p.expire(MK.tl(d), TTL);
}

export function metaBond(p: Pipe, name: string, symbol: string) {
  const d = dayKey();
  for (const w of words(name, symbol)) p.hincrby(MK.wb(d), w, 1);
  if (symbol) p.hincrby(MK.tb(d), tick(symbol), 1);
  p.expire(MK.wb(d), TTL);
  p.expire(MK.tb(d), TTL);
}

export type Meta = { lift: number; hot: string | null; dup: number; copy: boolean };

/** Meta features for many launches at once (8 Redis commands total). */
export async function readMeta(items: { mint: string; name: string; symbol: string }[], baseBond = 0.01): Promise<Record<string, Meta>> {
  const out: Record<string, Meta> = {};
  if (!items.length) return out;
  const r = redis();
  const d0 = dayKey();
  const d1 = dayKey(Date.now() - 86400_000);
  const ws = Array.from(new Set(items.flatMap((i) => words(i.name, i.symbol))));
  const ts = Array.from(new Set(items.map((i) => tick(i.symbol)).filter(Boolean)));
  const p = r.pipeline();
  for (const d of [d0, d1]) {
    p.hmget(MK.wl(d), ...(ws.length ? ws : ["~"]));
    p.hmget(MK.wb(d), ...(ws.length ? ws : ["~"]));
    p.hmget(MK.tl(d), ...(ts.length ? ts : ["~"]));
    p.hmget(MK.tb(d), ...(ts.length ? ts : ["~"]));
  }
  const res = ((await p.exec()) as any[]).map((x) => x || {});
  const sum = (a: number, b: number, f: string) => Number(res[a][f] || 0) + Number(res[b][f] || 0);
  for (const it of items) {
    let lift = 1;
    let hot: string | null = null;
    for (const w of words(it.name, it.symbol)) {
      const L = sum(0, 4, w);
      const B = sum(1, 5, w);
      if (B < 2) continue; // a word needs at least two bonds to count as a meta
      const l = (B + 0.05) / (L + 5) / baseBond;
      if (l > lift) {
        lift = l;
        hot = w;
      }
    }
    const t = tick(it.symbol);
    out[it.mint] = { lift: Math.round(Math.min(lift, 50) * 100) / 100, hot, dup: t ? sum(2, 6, t) : 0, copy: t ? sum(3, 7, t) > 0 : false };
  }
  return out;
}
