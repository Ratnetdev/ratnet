// Owned locks. A plain SET NX + DEL has two classic bugs: the TTL can run out while a slow pass (a swap waiting for
// confirmation) is still working, and the final DEL then deletes the *next* holder's lock, so two desks trade at once.
// Here every holder has a random token, renews its TTL while it works, and releases only its own lock (compare-and-
// delete in one Lua script).
import { randomBytes } from "crypto";
import { redis } from "./redis";

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const RENEW = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

export type Lock = { key: string; token: string };

export async function acquire(key: string, ttlMs: number): Promise<Lock | null> {
  const token = `t${randomBytes(9).toString("hex")}`;
  const ok = await redis().set(key, token, { nx: true, px: ttlMs } as any);
  return ok ? { key, token } : null;
}

/** Extend the TTL. False means the lock was lost (expired and taken): stop working at once. */
export async function renew(l: Lock, ttlMs: number) {
  const n = await redis().eval(RENEW, [l.key], [l.token, String(ttlMs)]).catch(() => 0);
  return Number(n) === 1;
}

export async function release(l: Lock) {
  await redis().eval(RELEASE, [l.key], [l.token]).catch(() => 0);
}

/** True while this process still holds the lock (checked with one GET, for right before an irreversible step). */
export async function holds(l: Lock) {
  const v = await redis().get<string>(l.key).catch(() => null);
  return v === l.token;
}

export type Held = { lock: Lock; lost: () => boolean };

/**
 * Run `fn` under an owned lock that renews itself every third of its TTL for as long as `fn` runs, then is released.
 * Returns `busy` when someone else holds it. `held.lost()` turns true the moment a renewal finds the lock gone, so long
 * work can stop before it does something a second holder would also do.
 */
export async function withLock<T>(key: string, ttlMs: number, fn: (h: Held) => Promise<T>): Promise<T | { skipped: "busy" }> {
  const l = await acquire(key, ttlMs);
  if (!l) return { skipped: "busy" };
  let lost = false;
  const t = setInterval(() => {
    renew(l, ttlMs).then((ok) => {
      if (!ok) lost = true;
    });
  }, Math.max(1000, Math.floor(ttlMs / 3)));
  try {
    return await fn({ lock: l, lost: () => lost });
  } finally {
    clearInterval(t);
    await release(l);
  }
}
