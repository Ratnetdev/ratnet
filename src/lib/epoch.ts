// Data epochs. When a bug polluted what the rats learned (v0.1.5: curves that hit 100% but never migrated were counted
// as graduations), a new epoch wipes everything derived from those labels exactly once and the models relearn from
// clean data: the HISTORIAN replays the past again with the migration proof, live lessons flow into fresh models.
// Never touched: rats, litters, burns, payout rounds, sniffs, settings, the desk wallet and its paper book, dev launch counts.
import { K, dayKey, hourKey, redis } from "./redis";
import { putLaunch } from "./launches";
import { GK, HGK } from "./graph";
import { readPools, migrated } from "./pool";
import type { Launch } from "./digger";

export const EPOCH = "v0.1.5";
const LOCK = "rn:lock:epoch";
export const EPOCH_AT = "rn:epoch:at"; // when the current clean record started
const SCAN = "rn:epoch:scan"; // cursor of the background relabel of stored coin records

const RUNNER = ["rn:runner", "rn:run:pre", "rn:run:post", "rn:run:postcur", "rn:run:emp", "rn:run:log", "rn:run:best", "rn:run:fin"];
const HIST = ["rn:h:state2", "rn:h:q2", "rn:h:log"];
const KEEP_STATS = ["burned", "sniffs"];

export async function epochReady() {
  return (await redis().get<string>(K.epoch)) === EPOCH;
}

/** Runs at the start of every dig. Cheap when the epoch is current (one GET). */
export async function ensureEpoch(): Promise<Record<string, unknown> | null> {
  const r = redis();
  const cur = await r.get<string>(K.epoch);
  if (cur === EPOCH) {
    await r.set(EPOCH_AT, Date.now(), { nx: true }); // the public record counts from here
    return relabelStep();
  }
  const got = await r.set(LOCK, Date.now(), { nx: true, ex: 120 });
  if (!got) return { epoch: "resetting" };
  const now = Date.now();
  const st = ((await r.hgetall<Record<string, number>>(K.stat)) || {}) as Record<string, number>;
  const kept: Record<string, number> = {};
  for (const k of KEEP_STATS) if (st[k] != null) kept[k] = Number(st[k]);

  const days = Array.from({ length: 5 }, (_, i) => dayKey(now - i * 86400_000));
  const hours = Array.from({ length: 24 * 5 }, (_, i) => hourKey(now - i * 3600_000));
  const keys = [
    K.stat, K.calib, K.calls, K.callRes, K.grads, K.near, K.idx, K.idxT, K.feed, K.devB,
    K.nano, K.nano1, K.nanoLog, "rn:replay", "rn:nano:ver",
    GK.cN, GK.cB, GK.cM, GK.sN, GK.sB, GK.sM,
    HGK.cN, HGK.cB, HGK.cM, HGK.sN, HGK.sB, HGK.sM,
    ...HIST, ...RUNNER,
    K.deskLearn, K.deskShadow, K.deskAfter, K.deskStalk, K.deskVet,
    ...days.flatMap((d) => [K.day(d), `rn:mw:l:${d}`, `rn:mw:b:${d}`, `rn:mt:l:${d}`, `rn:mt:b:${d}`]),
    ...hours.flatMap((h) => [K.hr(h), K.resolvedHour(h)]),
  ];
  for (let i = 0; i < keys.length; i += 100) await r.del(...keys.slice(i, i + 100));
  const p = r.pipeline();
  if (Object.keys(kept).length) p.hset(K.stat, kept);
  p.set(SCAN, "0");
  p.set(K.epoch, EPOCH);
  p.set(EPOCH_AT, now);
  p.lpush(K.feed, { kind: "resolve", rat: "LEDGER", mint: "", symbol: "", name: "", at: now, text: `${EPOCH}: graduations now need proof of migration. scoreboard and models restarted on clean data, the historian is replaying the past` });
  await p.exec();
  await r.del(LOCK);
  return { epoch: EPOCH, reset: keys.length };
}

/** Background pass over stored coin records: a "bonded" coin without its canonical pool is relabelled as not bonded. */
async function relabelStep(): Promise<Record<string, unknown> | null> {
  const r = redis();
  const cur = await r.get<string>(SCAN);
  if (cur == null || cur === "done") return null;
  const [next, keys] = (await (r as any).scan(cur, { match: "rn:launch:*", count: 400 })) as [string | number, string[]];
  const recs = keys.length ? ((await r.mget<(Launch | null)[]>(...keys)) as (Launch | null)[]) : [];
  const bonded = recs.filter((x): x is Launch => !!x && x.outcome === "BONDED");
  let fixed = 0;
  if (bonded.length) {
    const pools = await readPools(bonded.map((x) => x.mint));
    const p = r.pipeline();
    for (const rec of bonded) {
      if (migrated(pools[rec.mint]) || (pools[rec.mint]?.sol ?? 0) > 0.5) continue;
      rec.outcome = "DIED";
      rec.stuck = true;
      delete rec.bondSecs;
      putLaunch(p, rec, { keepTtl: true });
      fixed++;
    }
    await p.exec();
  }
  await r.set(SCAN, String(next) === "0" ? "done" : String(next));
  return { relabelled: fixed, scanned: keys.length };
}
