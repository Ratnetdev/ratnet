// v0.1.40: page summaries the worker builds once and every server instance reads as one small key. Before, each
// Vercel instance built the agent boards, HOUND's view and the Hall of Fame itself from the raw data (whole wallet
// books, lesson hashes, 160 runs...), every few seconds, for every region the CDN missed in.
// When the worker is down (no fresh summary), a page builds the summary itself as before.
import { redis } from "./redis";
import { memo } from "./memo";
import { bwMul } from "./bwgov";

const KEY = (name: string) => `rn:site:${name}`;

export async function publishSite(name: string, build: () => Promise<unknown>, ttlSec = 600) {
  const v = await build();
  await redis().set(KEY(name), { at: Date.now(), v }, { ex: ttlSec });
  return v;
}

/** The worker's summary when it is at most `maxAgeMs` old, else built here. Read at most every `memoMs`. */
export async function readSite<T>(name: string, memoMs: number, maxAgeMs: number, build: () => Promise<T>): Promise<T> {
  return memo(`site:${name}`, memoMs, async () => {
    const got = await redis().get<{ at: number; v: T }>(KEY(name)).catch(() => null);
    // v0.1.41: in saving mode the worker publishes less often, so "old" stretches with it (the pages used to rebuild
    // everything themselves exactly when bandwidth was short)
    if (got && Date.now() - Number(got.at) < maxAgeMs * bwMul() && got.v != null) return got.v;
    return build();
  });
}
