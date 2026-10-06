// BUZZ: are people talking about it?
// Research: pump.fun comments are faked by bot clusters (arXiv 2609.10246), so reply counts are ignored.
// What we read instead: X posts mentioning the contract address (optional, needs X_BEARER_TOKEN; X bills per post read,
// so only desk candidates and open positions are checked, each at most once a minute) and paid DexScreener signals
// (an active boost or a paid profile means someone is spending money on the coin).

import { redis } from "./redis";

const KEY = (m: string) => `rn:buzz:${m}`;

export type Buzz = { x15: number | null; at: number };

/** X posts mentioning the CA in the last 15 minutes. null when X is not configured or the read failed. */
export async function xMentions(mint: string): Promise<number | null> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return null;
  const r = redis();
  const c = await r.get<Buzz>(KEY(mint));
  if (c && Date.now() - c.at < 60_000) return c.x15;
  let x15: number | null = null;
  try {
    const start = new Date(Date.now() - 15 * 60_000).toISOString();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`https://api.x.com/2/tweets/counts/recent?query=${encodeURIComponent(mint)}&granularity=minute&start_time=${start}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (res.ok) {
      const j = await res.json();
      x15 = Number(j?.meta?.total_tweet_count ?? (j?.data || []).reduce((a: number, d: any) => a + Number(d.tweet_count || 0), 0));
    }
  } catch {}
  await r.set(KEY(mint), { x15, at: Date.now() }, { ex: 3600 });
  return x15;
}
