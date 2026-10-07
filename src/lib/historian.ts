// HISTORIAN: digs the old tunnels. Replays past pump.fun launches so the models start trained instead of waiting weeks.
//
// Order: today first, then yesterday, then the day before, and so on. The most recent market teaches first.
//
// Rules that keep it honest (research pitfall: leakage makes backtests look brilliant and live trading fail):
// 1. Features are rebuilt exactly as the live rats see them at minute 1 and minute 5: the curve state from the last
//    transaction before the cut, and the tape from the trades before the cut. Nothing after the cut is read.
// 2. Walking backwards means the dev, cluster and smart-wallet records for a past launch are not knowable "before" it,
//    so replayed lessons mask those record features (they learn curve, tape, farm, meta and season) and carry a
//    "replayed from history" flag. The records themselves still go into the live tables: for live calls, all of
//    history is the past.
// 3. Label: bonded within 2h, the same window the live models learn on.
// 4. Prequential: every past launch is scored by the current model BEFORE it learns from it (honest backtest).
// 5. Sampling: every bonded launch plus 1 in `sample` of the rest, weighted back up so the base rate stays right.
// 6. Seasons: older lessons weigh less (half-life in days), and every lesson carries its regime (SOL trend,
//    launch rate), so a late-2024 lesson never speaks as loud as last week.
// Post-bond runs come from GeckoTerminal hourly candles and teach the runner model the milestone ladder.

import { PublicKey } from "@solana/web3.js";
import { historianCapped } from "./rpcday";
import { acquire, holds, release, renew } from "./lock";
import { CHECKPOINTS, PUMP_MINT_AUTHORITY } from "@/config/site";
import { K, hourKey, redis } from "./redis";
import { canonicalPool, migrated, readPools } from "./pool";
import { lane, laneOpen } from "./solana";
import { epochReady } from "./epoch";
import { agentLog } from "./agents";
import { bondingCurvePda, conn, fetchOffchain, getCurves, limitedFetch, parseCreateTx, pmap, safeErr } from "./solana";
import { buildTape, parsedTxs, parseTrade, progressFromSol, Tape, Trade } from "./tape";
import { creditMillion, creditResolve, funderOf, GK } from "./graph";
import { features, nanoScore, NANO_MIN } from "./nano";
import { score, verdictOf } from "./king";
import { applyNano, loadModel, LABEL_MS, type NanoOp } from "./digger";
import { applyRunnerOps, features as runFeatures, MILESTONES, MILLION, RK, Run, type RunnerOp } from "./runner";
import { ensureSolHistory, RG, regimeAt, seasonNow } from "./regime";
import { getSettings } from "./settings";
import { curveMcSol, learnHistory, peakIn } from "./catcher";
import { solUsd } from "./solana";

export const HK = {
  state: "rn:h:state2",
  queue: "rn:h:q2", // list: launches waiting for a deep read
  log: "rn:h:log",
  lock: "rn:lock:hist",
};

export type HState = {
  phase: "scan" | "done";
  startedAt: number;
  until: number; // newest time replayed (where the live rats took over)
  from: number; // oldest time to reach
  clock: number; // createdAt of the last scanned launch (moves backwards)
  cursor: string | null; // signature to page back from
  sigs: string[]; // current page, newest first
  pos: number;
  days: Record<string, { scanned: number; bonded: number }>;
  scanned: number;
  bonded: number;
  deep: number;
  lessons: number;
  runnerLessons: number;
  catchLessons?: number;
  bt: { v0n: number; v0hit: number; nn: number; nhit: number; base: number; baseHit: number };
  errors: number;
  lastError?: string;
  // bonds first: pump.fun's migration account, paged back in time (every bonded coin, without parsing every launch)
  mCursor?: string | null;
  mSigs?: string[];
  mPos?: number;
  mDone?: boolean;
  mFound?: number;
  mClock?: number;
};

type Job = { mint: string; curve: string; creator: string; createdAt: number; name: string; symbol: string; uri: string; devBuySol: number; w: number; bondedNow: boolean; fromMig?: boolean; bondAt?: number };
const MIGRATION_ACCOUNT = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg"; // pump.fun's migration account (signs every graduation)
const SEEN = "rn:h:seen"; // mints already queued for a deep read

const RENT = 0.0016;
const CUT1 = CHECKPOINTS.t1;
const CUT5 = CHECKPOINTS.t5;

async function loadState(days: number): Promise<HState> {
  const r = redis();
  const s = await r.get<HState>(HK.state);
  if (s) {
    // the window can be widened from /admin at any time
    const from = s.until - days * 86400_000;
    if (from < s.from) {
      s.from = from;
      if (s.phase === "done") s.phase = "scan";
    }
    return s;
  }
  // start where the live rats started (the first day with digs), else an hour ago; walk back from there
  let until = Date.now() - 3600_000;
  for (let back = 40; back >= 0; back--) {
    const d = new Date(Date.now() - back * 86400_000).toISOString().slice(0, 10);
    const dug = await r.hget<number>(K.day(d), "dug");
    if (Number(dug || 0) > 0) {
      // the first hour the rats dug that day
      until = Date.parse(`${d}T00:00:00Z`);
      for (let h = 0; h < 24; h++) {
        const t = until + h * 3600_000;
        if (Number((await r.hget<number>(K.hr(hourKey(t)), "d")) || 0) > 0) {
          until = t;
          break;
        }
      }
      break;
    }
  }
  return {
    phase: "scan",
    startedAt: Date.now(),
    until,
    from: until - days * 86400_000,
    clock: until,
    cursor: null,
    sigs: [],
    pos: 0,
    days: {},
    scanned: 0,
    bonded: 0,
    deep: 0,
    lessons: 0,
    runnerLessons: 0,
    bt: { v0n: 0, v0hit: 0, nn: 0, nhit: 0, base: 0, baseHit: 0 },
    errors: 0,
  };
}

export async function oldestSigs(address: string, untilMs: number, max = 3000): Promise<{ signature: string; slot: number; blockTime: number | null; err: unknown }[]> {
  const url = process.env.HELIUS_RPC_URL;
  if (url) {
    try {
      const out: any[] = [];
      let token: string | undefined;
      for (let i = 0; i < 4 && out.length < max; i++) {
        // through the shared RPC limiter (it used to bypass it, unpaced and with no deadline: one stalled call could
        // freeze the historian for good)
        const res = await limitedFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransactionsForAddress", params: [address, { transactionDetails: "signatures", sortOrder: "asc", limit: 1000, ...(token ? { paginationToken: token } : {}) }] }),
          cache: "no-store",
        });
        const j: any = await res.json();
        const data: any[] = j?.result?.data || (Array.isArray(j?.result) ? j.result : []);
        if (!data.length) break;
        out.push(...data);
        const lastT = (data[data.length - 1].blockTime || 0) * 1000;
        token = j?.result?.paginationToken;
        if (!token || lastT > untilMs) break;
      }
      if (out.length) return out.filter((x) => (x.blockTime || 0) * 1000 <= untilMs);
    } catch {}
  }
  // fallback: page back from the newest (fine for curves that never got busy; capped for big ones)
  let before: string | undefined;
  const all: any[] = [];
  for (let i = 0; i < 25; i++) {
    const page = await conn().getSignaturesForAddress(new PublicKey(address), { before, limit: 1000 });
    all.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return all.reverse().filter((x) => (x.blockTime || 0) * 1000 <= untilMs);
}

/** Replay one launch at minute 1 and minute 5, from history only. */

/** Replay one launch at minute 1 and minute 5, from history only. Record features are masked (see rule 2). */
/** A bond found through the migration account: read its launch (the curve's first transaction) to fill the job. */
async function fillJob(job: Job): Promise<Job | null> {
  if (job.createdAt) return job;
  const first = (await oldestSigs(job.curve, Date.now(), 1000)).find((x) => !x.err);
  if (!first) return null;
  const tx = await conn().getParsedTransaction(first.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
  const l = tx ? parseCreateTx(first.signature, tx) : null;
  if (!l || l.mint !== job.mint) return null;
  return { ...job, createdAt: l.createdAt, creator: l.creator, name: l.name, symbol: l.symbol, uri: l.uri, devBuySol: l.devBuySol };
}

async function replay(job0: Job, mins = { t1: 3, t5: 5 }) {
  const job = await fillJob(job0);
  if (!job) return null;
  const sigs = (await oldestSigs(job.curve, job.createdAt + CUT5 + 5000)).filter((x) => !x.err);
  if (!sigs.length) return null;
  const createSlot = sigs[0].slot;
  const in1 = sigs.filter((x) => (x.blockTime || 0) * 1000 <= job.createdAt + CUT1);
  const in5 = sigs.filter((x) => (x.blockTime || 0) * 1000 <= job.createdAt + CUT5);
  const in0 = sigs.filter((x) => (x.blockTime || 0) * 1000 <= job.createdAt + 15_000);
  // the same sample the live read takes (lib/tape.ts SAMPLE: the first 28 trades and the newest 14 at that moment),
  // for each look on its own. Before v0.1.28 the minute-5 tape mixed in minute-1 trades and took 10 recent, not 14
  const s1 = new Set([...in1.slice(0, 28), ...in1.slice(-14)].map((x) => x.signature));
  const s5 = new Set([...in5.slice(0, 28), ...in5.slice(-14)].map((x) => x.signature));
  const pick = Array.from(new Set([...s1, ...s5, ...in0.slice(-1).map((x) => x.signature)]));
  const txs = await parsedTxs(pick);
  const bySig: Record<string, any> = {};
  pick.forEach((s, i) => (bySig[s] = txs[i]));
  const curveAt = (list: typeof sigs) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const tx = bySig[list[i].signature];
      if (!tx?.meta) continue;
      const keys = tx.transaction.message.accountKeys;
      const ci = keys.findIndex((k: any) => k.pubkey.toBase58() === job.curve);
      if (ci >= 0) return progressFromSol((tx.meta.postBalances[ci] || 0) / 1e9 - RENT);
    }
    return null;
  };
  const p0 = curveAt(in0) ?? 0;
  const p1 = curveAt(in1);
  const p5 = curveAt(in5);
  const tradesOf = (set: Set<string>) => Array.from(set).map((sg) => parseTrade(bySig[sg], job.curve, job.mint)).filter((t): t is Trade => !!t && Math.abs(t.sol) > 1e-6);
  const tape1: Tape | null = in1.length ? buildTape(tradesOf(s1), in1.length, createSlot, job.creator, job.createdAt, job.createdAt + CUT1) : null;
  const tape5: Tape | null = in5.length ? buildTape(tradesOf(s5), in5.length, createSlot, job.creator, job.createdAt, job.createdAt + CUT5) : null;
  const [off, rg] = await Promise.all([fetchOffchain(job.uri, 2000), regimeAt(job.createdAt).catch(() => null)]);
  const common = {
    curve0: p0,
    devBuySol: job.devBuySol,
    twitter: !!off?.twitter,
    telegram: !!off?.telegram,
    website: !!off?.website,
    description: off?.description || "",
    symbol: job.symbol,
    name: job.name,
    devN: 0, // masked: walking backwards, the dev's earlier record is not known yet
    devB: 0,
    createdAt: job.createdAt,
    rg,
    hist: true,
  };
  // same rule as live (lib/digger.ts processDue): trades are only read for curves past the settings' minimum, so a
  // quiet coin shows "no tape" in both places
  const x5 = p5 != null ? features({ ...common, curve5: p5, tape: p5 >= mins.t5 ? tape5 : null }) : null;
  const x1 = p1 != null ? features({ ...common, curve5: p1, tape: p1 >= mins.t1 ? tape1 : null }) : null;
  const v0 = p5 != null ? score({ progress: p5, progress0: p0, twitter: common.twitter, telegram: common.telegram, website: common.website, description: common.description, symbol: job.symbol, name: job.name, devBuySol: job.devBuySol, farm: !!tape5?.farm?.farm }) : null;
  return { x5, x1, p5, v0, tape5 };
}

/**
 * When the coin bonded: the time of its migration tx. Bonds found through the migration account carry it already.
 * Before v0.1.28 this was the curve's newest signature, which is any later activity (dust sent to the curve hours on):
 * a coin that bonded in 40 minutes could be labelled "not within 2h", and the models learned from wrong labels.
 */
async function bondTime(job: Job) {
  if (job.bondAt) return job.bondAt;
  const s = (await conn().getSignaturesForAddress(new PublicKey(job.curve), { limit: 6 })).filter((x) => !x.err);
  for (const x of s.slice(0, 3)) {
    const tx: any = await conn().getParsedTransaction(x.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    if ((tx?.meta?.logMessages || []).some((l: string) => /Instruction: Migrate/i.test(l))) return (tx.blockTime || x.blockTime || 0) * 1000 || null;
  }
  // no migrate log among the newest: the oldest of the recent ones is the closest bound (never the newest)
  const last = s[s.length - 1];
  return last?.blockTime ? last.blockTime * 1000 : null;
}

/** Post-bond run from GeckoTerminal hourly candles: first time each milestone was crossed. */
async function postRun(mint: string): Promise<{ t: number; mc: number }[] | null> {
  try {
    const get = async (u: string) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(u, { signal: ctrl.signal, cache: "no-store", headers: { accept: "application/json" } });
      clearTimeout(t);
      return res.ok ? res.json() : null;
    };
    // candles of the canonical migration pool only (never a side pool someone opened with a few dollars)
    const pool = canonicalPool(mint);
    const o: any = await get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/hour?limit=1000&currency=usd&token=${mint}`);
    const list: number[][] = o?.data?.attributes?.ohlcv_list || [];
    return list.map((c) => ({ t: c[0] * 1000, mc: Number(c[2]) * 1e9 })).sort((a, b) => a.t - b.t);
  } catch {
    return null;
  }
}

/** One historian session (runs next to the desk inside the minute cron). */
export async function historianSession(budgetMs = 45_000) {
  // spare RPC capacity only: the desk and the rats always go first (see lowLane in lib/solana.ts)
  if (!(await epochReady())) return { history: "waiting for the data reset" };
  return lane.run(3, () => historianInner(budgetMs));
}

async function historianInner(budgetMs: number) {
  const r = redis();
  const s = await getSettings();
  const cfg = s.history;
  if (!cfg.on) return { history: "off" };
  // its daily share of the RPC plan (HISTORIAN_CALLS_PER_DAY): spare capacity is not free capacity, every call is billed
  if (await historianCapped()) return { history: "daily cap reached" };
  if (!laneOpen(3)) return { history: "paused: daily chain budget on pace" };
  const lk = await acquire(HK.lock, 120_000);
  if (!lk) return { history: "busy" };
  const lkRenew = setInterval(() => renew(lk, 120_000).catch(() => false), 30_000);
  const t0 = Date.now();
  let st: Awaited<ReturnType<typeof loadState>>;
  try {
    st = await loadState(cfg.days);
  } catch (e) {
    clearInterval(lkRenew);
    await release(lk);
    throw e;
  }
  const log: string[] = [];
  try {
    ensureSolHistory().catch(() => {});
    const model = await loadModel();
    const model1 = await loadModel(K.nano1);
    const nanoOps: NanoOp[] = [];
    let dirty = false;
    let runDirty = false;
    const runnerOps: RunnerOp[] = [];
    const half = Math.max(1, cfg.halfLife || 21);

    while (st.phase === "scan" && Date.now() - t0 < budgetMs) {
      const qlen = (await r.llen(HK.queue)) || 0;
      // --- 0. bonds first: every graduation from pump.fun's migration account, newest first. Bonds are the rare
      // lessons the models need most; this finds a month of them with ~1 call per bond instead of parsing every launch
      if (!st.mDone && qlen < Math.max(cfg.deepPerRun, 16) * 6) {
        if ((st.mPos ?? 0) >= (st.mSigs?.length ?? 0)) {
          const raw = await conn().getSignaturesForAddress(new PublicKey(MIGRATION_ACCOUNT), { before: st.mCursor ?? undefined, limit: 1000 });
          if (!raw.length) st.mDone = true;
          else {
            st.mCursor = raw[raw.length - 1].signature;
            const oldestT = (raw[raw.length - 1].blockTime || 0) * 1000;
            // only the replay window: graduations after `until` belong to the live rats (before v0.1.28 the scan
            // started at the newest bond and taught the historian coins the live lane was already learning from)
            st.mSigs = raw.filter((x) => !x.err && (x.blockTime || 0) * 1000 >= st.from && (x.blockTime || 0) * 1000 <= st.until).map((x) => x.signature);
            st.mPos = 0;
            st.mClock = oldestT;
            if (oldestT < st.from && !st.mSigs.length) st.mDone = true;
          }
        }
        const mchunk = (st.mSigs || []).slice(st.mPos ?? 0, (st.mPos ?? 0) + 80);
        st.mPos = (st.mPos ?? 0) + mchunk.length;
        const failed: string[] = [];
        if (mchunk.length) {
          const WSOL_M = "So11111111111111111111111111111111111111112";
          const found = await pmap(mchunk, 16, async (sig) => {
            try {
              const tx: any = await conn().getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
              const logs: string[] = tx?.meta?.logMessages || [];
              if (!logs.some((l) => /Instruction: Migrate/i.test(l))) return null;
              const bal: any[] = [...(tx?.meta?.postTokenBalances || []), ...(tx?.meta?.preTokenBalances || [])];
              const mint = bal.map((b) => String(b.mint || "")).find((m) => m && m !== WSOL_M && m.endsWith("pump")) || bal.map((b) => String(b.mint || "")).find((m) => m && m !== WSOL_M);
              return mint ? { mint, at: (tx?.blockTime || 0) * 1000 } : null;
            } catch {
              // rate-limited or timed out: read it again later (before v0.1.24 a failed read skipped that bond for good,
              // which is how a burst of 429s left the bond scan at 0 found)
              failed.push(sig);
              return null;
            }
          });
          if (failed.length) {
            st.mSigs = [...failed, ...(st.mSigs || []).slice(st.mPos ?? 0)];
            st.mPos = 0;
            // mostly failing: the plan is saturated, give it a breather instead of hammering it
            if (failed.length * 2 > mchunk.length) await new Promise((res) => setTimeout(res, 3000));
          }
          const bondAt: Record<string, number> = {};
          for (const f of found) if (f && !bondAt[f.mint]) bondAt[f.mint] = f.at;
          const mints = Object.keys(bondAt);
          if (mints.length) {
            const p = r.pipeline();
            for (const m of mints) p.sadd(SEEN, m);
            const added = (await p.exec()) as number[];
            const q = r.pipeline();
            let n = 0;
            mints.forEach((m, i) => {
              if (!Number(added[i])) return;
              n++;
              q.rpush(HK.queue, { mint: m, curve: bondingCurvePda(m), creator: "", createdAt: 0, name: "", symbol: "", uri: "", devBuySol: 0, w: 1, bondedNow: true, fromMig: true, bondAt: bondAt[m] || undefined } satisfies Job);
            });
            if (n) await q.exec();
            st.mFound = (st.mFound || 0) + n;
          }
        }
      }

      // --- 1. scan backwards: newest page first, parse create txs, keep dev records, queue deep reads
      if (qlen < Math.max(cfg.deepPerRun, 16) * 4) {
        if (st.pos >= st.sigs.length) {
          const raw = await conn().getSignaturesForAddress(new PublicKey(PUMP_MINT_AUTHORITY), { before: st.cursor ?? undefined, limit: 1000 });
          if (!raw.length) {
            st.phase = "done";
            break;
          }
          st.cursor = raw[raw.length - 1].signature;
          const newest = (raw[0].blockTime || 0) * 1000;
          const oldestT = (raw[raw.length - 1].blockTime || 0) * 1000;
          // launch rate for the season features
          if (newest > oldestT) await r.hset(RG.lrate, { [hourKey((newest + oldestT) / 2)]: Math.round(raw.length / ((newest - oldestT) / 3600_000)) });
          st.sigs = raw.filter((x) => !x.err && (x.blockTime || 0) * 1000 < st.until && (x.blockTime || 0) * 1000 >= st.from).map((x) => x.signature);
          st.pos = 0;
          if (oldestT < st.from) {
            // last page: finish it, then stop
            if (!st.sigs.length) {
              st.phase = "done";
              log.push(`replay reached ${new Date(st.from).toISOString().slice(0, 10)}: ${st.scanned} launches, ${st.bonded} bonded, ${st.lessons} lessons`);
              break;
            }
          }
          if (!st.sigs.length) continue; // still in the live era: keep paging back
        }
        const chunk = st.sigs.slice(st.pos, st.pos + Math.max(cfg.scanPerRun, 400));
        st.pos += chunk.length;
        const parsed = await pmap(chunk, 16, async (sig) => {
          try {
            return parseCreateTx(sig, await conn().getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
          } catch {
            return null;
          }
        });
        const launches = parsed.filter((x): x is NonNullable<typeof x> => !!x);
        if (launches.length) {
          const curves = await getCurves(launches.map((l) => l.mint));
          // a full curve only counts if the coin really migrated into its canonical pool (see lib/pool.ts)
          const full = launches.filter((l) => curves[l.mint]?.complete).map((l) => l.mint);
          const pools = full.length ? await readPools(full) : {};
          // bonds the migration scan already queued are not queued twice
          const bondedMints = launches.filter((l) => curves[l.mint]?.complete && migrated(pools[l.mint])).map((l) => l.mint);
          const sp = r.pipeline();
          for (const m of bondedMints) sp.sadd(SEEN, m);
          const newly = bondedMints.length ? ((await sp.exec()) as number[]) : [];
          const already = new Set(bondedMints.filter((_, i) => !Number(newly[i])));
          const p = r.pipeline();
          for (const l of launches) {
            const bondedNow = !!curves[l.mint]?.complete && migrated(pools[l.mint]);
            st.scanned++;
            st.clock = Math.min(st.clock, l.createdAt);
            const day = new Date(l.createdAt).toISOString().slice(0, 10);
            const d = (st.days[day] ||= { scanned: 0, bonded: 0 });
            d.scanned++;
            // live dev memory gets the past: everything here is before the live era
            p.hincrby(K.devN, l.creator, 1);
            if (bondedNow) {
              st.bonded++;
              d.bonded++;
              p.hincrby(K.devB, l.creator, 1);
            }
            if ((bondedNow && !already.has(l.mint)) || (!bondedNow && st.scanned % cfg.sample === 0))
              p.rpush(HK.queue, { mint: l.mint, curve: bondingCurvePda(l.mint), creator: l.creator, createdAt: l.createdAt, name: l.name, symbol: l.symbol, uri: l.uri, devBuySol: l.devBuySol, w: bondedNow ? 1 : cfg.sample, bondedNow } satisfies Job);
          }
          await p.exec();
        }
      }

      // --- 2. deep reads: rebuild minute 1 and 5, score first (prequential), then learn with season weight
      const got2 = await r.lpop<Job[]>(HK.queue, Math.max(cfg.deepPerRun, 16));
      const list: Job[] = Array.isArray(got2) ? got2 : got2 ? [got2 as unknown as Job] : [];
      if (!list.length) {
        if (st.pos >= st.sigs.length && qlen === 0 && Date.now() - t0 > budgetMs / 2) break;
        continue;
      }
      const results = await pmap(list, 6, async (job) => {
        try {
          const [bt, rep, funder] = await Promise.all([job.bondedNow ? bondTime(job) : Promise.resolve(null), replay(job, { t1: Number((s.desk as any).earlyMinCurve ?? 3), t5: Number((s.desk as any).tapeMinCurve ?? 5) }), funderOf(job.creator).catch(() => null)]);
          return { job, bt, rep, funder };
        } catch (e) {
          st.errors++;
          st.lastError = safeErr(e);
          return { job, bt: null, rep: null, funder: null };
        }
      });
      const p = r.pipeline();
      const catchItems: { f: Record<string, number>; y: boolean; y2?: boolean; w: number }[] = [];
      const target = Number((s.desk as any).catchTargetUsd ?? 300_000);
      const solNow = (await solUsd().catch(() => null)) || 150;
      for (const { job, bt, rep, funder } of results) {
        if (!rep?.x5) continue;
        const bonded = !!bt && bt - job.createdAt <= LABEL_MS;
        const ageDays = Math.max(0, (Date.now() - job.createdAt) / 86400_000);
        const season = Math.pow(0.5, ageDays / half);
        const w = job.w * season;
        st.bt.base += job.w;
        if (bonded) st.bt.baseHit += job.w;
        if (rep.v0?.verdict === "BOND") {
          st.bt.v0n += job.w;
          if (bonded) st.bt.v0hit += job.w;
        }
        if (model.n >= NANO_MIN && verdictOf(nanoScore(model, rep.x5)) === "BOND") {
          st.bt.nn += job.w;
          if (bonded) st.bt.nhit += job.w;
        }
        nanoOps.push({ k: 0, x: rep.x5, y: bonded, sw: w });
        if (rep.x1) nanoOps.push({ k: 1, x: rep.x1, y: bonded, sw: w });
        dirty = true;
        st.deep++;
        st.lessons++;
        // records for the live rats: the dev's funder cluster and the early wallets
        const early = rep.tape5?.early || [];
        creditResolve(p, funder, early, bonded, GK);
        // CATCH: the minute-5 look and (if it bonded) the migration look, labelled by the candles after the bond
        const solAt = Number((await r.hget(RG.solh, hourKey(job.createdAt)).catch(() => null)) || 0) || solNow;
        const f5: Record<string, number> = {
          pool: 0, mc: curveMcSol(rep.p5 ?? 0) * solAt, ageMin: 5, prog: rep.p5 ?? 0, vel: ((rep.p5 ?? 0) - 0) / 5, sol: 0, migMin: 0,
          uniq: rep.tape5?.uniq ?? 0, organic: rep.tape5?.organic ?? 0, buyShare: rep.tape5?.buyShare ?? 0.5, bundle: rep.tape5?.bundleShare ?? 0, farm: rep.tape5?.farm?.farm ? 1 : 0,
          smart: 0, tracked: 0, king: rep.v0?.score ?? 0, kingBond: rep.v0?.verdict === "BOND" ? 1 : 0, post: 0, wave: 0, narrative: 0, v5: 0, buyers5: 0, buyRatio: 1, ch5: 0, ch1h: 0,
          confPos: 0, confNeg: 0, devRate: 0, socials: 0, copy: 0, mind: 0, lens: 0,
        };
        let catchPath: { t: number; mc: number }[] | null = null;
        if (bt && bt - job.createdAt <= 6 * 3600_000 && cfg.runner) catchPath = await postRun(job.mint);
        if (!bt) catchItems.push({ f: f5, y: false, y2: false, w: job.w * season }); // never bonded: it never got near $300K
        else if (catchPath?.length) {
          const pk5 = peakIn(catchPath, job.createdAt, job.createdAt + 6 * 3600_000);
          const pk52 = peakIn(catchPath, job.createdAt, job.createdAt + 2 * 3600_000);
          catchItems.push({ f: f5, y: pk5 >= Math.max(target, f5.mc * 2), y2: pk52 >= Math.max(target, f5.mc * 2), w: job.w * season });
          const mcMig = curveMcSol(100) * solAt;
          const migMin = (bt - job.createdAt) / 60_000;
          const fm = { ...f5, pool: 1, mc: mcMig, ageMin: migMin, prog: 100, vel: 0, sol: 85, migMin };
          const pkM = peakIn(catchPath, bt, bt + 6 * 3600_000);
          const pkM2 = peakIn(catchPath, bt, bt + 2 * 3600_000);
          catchItems.push({ f: fm, y: pkM >= Math.max(target, mcMig * 2), y2: pkM2 >= Math.max(target, mcMig * 2), w: job.w * season });
        }
        if (bt && cfg.runner) {
          const path = catchPath ?? (await postRun(job.mint));
          if (path?.length) {
            const run: Run = {
              mint: job.mint, symbol: job.symbol, createdAt: job.createdAt, bondedAt: bt, hi: -1, pk: 0, xs: {},
              s: { king: rep.v0?.score ?? 0, nano: null, smartN: 0, clRatio: 1, bundleShare: rep.tape5?.bundleShare ?? 0, uniq: rep.tape5?.uniq ?? 0, solPerBuy: rep.tape5?.solPerBuy ?? 0, buyShare: rep.tape5?.buyShare ?? 0, copy: false, lift: 1, funder, early },
            };
            const first: Record<number, number> = {};
            for (const c of path) for (let i = 0; i < MILESTONES.length; i++) if (c.mc >= MILESTONES[i] && first[i] == null && c.t >= bt - 3600_000) first[i] = c.t;
            for (let i = MILESTONES.indexOf(1e5); i < MILESTONES.length - 1; i++) {
              if (first[i] == null) break;
              // two milestones in one hourly candle: we can't tell when inside the hour each was crossed, so that step
              // teaches nothing (before v0.1.28 it was an instant "yes", and the ladder looked steeper than it is)
              if (first[i + 1] != null && first[i + 1] === first[i]) continue;
              const up = first[i + 1] != null && first[i + 1] - first[i] <= 6 * 3600_000;
              runnerOps.push({ x: runFeatures(run, i, first[i]), y: up, sw: season });
              p.hincrby(RK.emp, `n${i}`, 1);
              if (up) p.hincrby(RK.emp, `u${i}`, 1);
              st.runnerLessons++;
              runDirty = true;
            }
            if (first[MILLION] != null) {
              creditMillion(p, funder, early, GK);
              log.push(`$${job.symbol} (${new Date(job.createdAt).toISOString().slice(0, 10)}) ran past $1M. its early wallets and dev cluster go on record`);
            }
          }
        }
        if (rep.tape5?.farm?.farm && bonded) log.push(`$${job.symbol} (${new Date(job.createdAt).toISOString().slice(0, 10)}): farm that bonded (${rep.tape5.farm.why}). lesson learned`);
      }
      await p.exec();
      if (catchItems.length) st.catchLessons = (st.catchLessons || 0) + (await learnHistory(catchItems).catch(() => 0));
    }
    // the historian's lessons go into the live models under the shared lock, on their latest copy (it used to save
    // its own 45-second-old copy over everything the rats had learned meanwhile)
    if (dirty && nanoOps.length) await applyNano(nanoOps.splice(0));
    if (runDirty && runnerOps.length) await applyRunnerOps(runnerOps.splice(0));
    for (const l of log.slice(0, 10)) await r.lpush(HK.log, { at: Date.now(), text: l });
    await r.ltrim(HK.log, 0, 49);
    if (log.length) await r.lpush(K.deskEv, ...log.slice(0, 5).map((text) => ({ agent: "HISTORIAN", at: Date.now(), text, tone: "info" })));
    if (st.scanned) {
      const hp = r.pipeline();
      agentLog(hp, [{ agent: "HISTORIAN", at: Date.now(), text: `replayed back to ${new Date(st.clock).toISOString().slice(0, 16).replace("T", " ")}: ${st.deep} lessons, ${st.bonded} bonds found`, tone: "info" }]);
      await hp.exec();
    }
    return { history: st.phase, scanned: st.scanned, deep: st.deep };
  } catch (e) {
    st.errors++;
    st.lastError = safeErr(e);
    return { history: "error", error: st.lastError };
  } finally {
    clearInterval(lkRenew);
    // only the holder saves its state: a second historian (the lock was lost) must not overwrite the first one's progress
    if (await holds(lk)) await r.set(HK.state, st);
    await release(lk);
  }
}

export async function getHistory() {
  const r = redis();
  const [st, log, q, season, nano] = await Promise.all([r.get<HState>(HK.state), r.lrange(HK.log, 0, 9), r.llen(HK.queue), seasonNow().catch(() => null), loadModel()]);
  const drift = { shifts: nano.shifts || 0, boost: nano.boost || 0, shiftAt: nano.shiftAt || null, lossFast: nano.lossFast ?? null, loss: nano.loss };
  if (!st) return { phase: "starting", log: [], season, drift };
  const rate = (h: number, n: number) => (n ? Math.round((h / n) * 1000) / 10 : null);
  const span = st.until - st.from;
  const days = Object.entries(st.days || {})
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 14)
    .map(([day, d]) => ({ day, ...d, rate: d.scanned ? Math.round((d.bonded / d.scanned) * 10000) / 100 : null }));
  return {
    phase: st.phase,
    from: st.from,
    until: st.until,
    clock: st.clock,
    done: span > 0 ? Math.min(100, Math.round(((st.until - st.clock) / span) * 1000) / 10) : 0,
    queue: q,
    scanned: st.scanned,
    bonded: st.bonded,
    deep: st.deep,
    lessons: st.lessons,
    runnerLessons: st.runnerLessons,
    catchLessons: st.catchLessons || 0,
    days,
    backtest: { base: rate(st.bt.baseHit, st.bt.base), v0: rate(st.bt.v0hit, st.bt.v0n), v0n: st.bt.v0n, nano: rate(st.bt.nhit, st.bt.nn), nanoN: st.bt.nn },
    errors: st.errors,
    lastError: st.lastError ? String(st.lastError).slice(0, 120) : null,
    bondsFound: st.mFound || 0,
    bondsBackTo: st.mClock || null,
    bondsDone: !!st.mDone,
    log: log || [],
    season,
    drift,
  };
}
