// HISTORIAN: digs the old tunnels. Replays past pump.fun launches so the models start trained instead of waiting weeks.
//
// Rules that keep it honest (research pitfall: leakage makes backtests look brilliant and live trading fail):
// 1. Walk history FORWARD in time. Dev, cluster and smart-wallet records used for a historic launch only contain
//    launches before it, and outcomes are credited only once the replay clock passes their label time.
// 2. Features are rebuilt exactly as the live rats see them at minute 1 and minute 5: the curve state from the last
//    transaction before the cut, and the tape from the trades before the cut. Nothing after the cut is read.
// 3. Label: bonded within 2h, the same window the live models learn on.
// 4. Prequential: every historic launch is scored by the current model BEFORE it learns from it. That score is the
//    honest backtest number shown in the Lab.
// 5. Sampling: every bonded launch, plus 1 in `sample` of the rest, learned with weight `sample`, so the base rate stays right.
// Post-bond runs come from GeckoTerminal hourly candles and teach the runner model the milestone ladder.

import { PublicKey } from "@solana/web3.js";
import { CHECKPOINTS, PUMP_MINT_AUTHORITY } from "@/config/site";
import { K, redis } from "./redis";
import { bondingCurvePda, conn, fetchOffchain, getCurves, parseCreateTx, pmap, safeErr } from "./solana";
import { buildTape, parsedTxs, parseTrade, Tape, Trade } from "./tape";
import { creditMillion, creditResolve, funderOf, GK, HGK, readGraph } from "./graph";
import { features, learn, NanoModel, nanoScore, NANO_MIN } from "./nano";
import { score, verdictOf } from "./king";
import { loadModel, LABEL_MS } from "./digger";
import { features as runFeatures, MILESTONES, MILLION, RK, Run, loadRunner } from "./runner";
import { getSettings } from "./settings";

export const HK = {
  state: "rn:h:state",
  pages: "rn:h:pages", // list of page anchors (oldest signature of each 1000-signature page), newest page first
  devN: "rn:h:dev:n",
  devB: "rn:h:dev:b",
  pend: "rn:h:pend", // zset: credits waiting for the replay clock (score = when they become knowable)
  queue: "rn:h:q", // list: launches waiting for a deep read
  log: "rn:h:log",
  lock: "rn:lock:hist",
};

export type HState = {
  phase: "anchor" | "scan" | "done";
  startedAt: number;
  until: number; // replay stops here (where the live rats took over)
  from: number; // oldest time covered
  clock: number; // replay clock: createdAt of the last scanned launch
  page: number; // index into pages, counting down to 0
  top?: string | null; // the `before` cursor of page 0 (newest stored page)
  sigs: string[]; // current page, oldest first
  pos: number;
  scanned: number;
  bonded: number; // bonded launches found
  deep: number; // launches fully replayed
  lessons: number;
  runnerLessons: number;
  bt: { v0n: number; v0hit: number; nn: number; nhit: number; base: number; baseHit: number }; // prequential backtest
  errors: number;
  lastError?: string;
};

type Job = { mint: string; curve: string; creator: string; createdAt: number; slot: number; name: string; symbol: string; uri: string; devBuySol: number; devN: number; devB: number; w: number; bondedNow: boolean };
type Pend = { at: number; kind: "dev" | "label" | "million"; creator?: string; funder?: string | null; early?: string[]; bonded?: boolean; id: string };

const RENT = 0.0016;
const CUT1 = CHECKPOINTS.t1;
const CUT5 = CHECKPOINTS.t5;

function progressFromSol(realSol: number) {
  // pump.fun curve: vSol = 30 + real SOL, vTok = 30 * 1073M / vSol, sold = 1073M - vTok, progress = sold / 793.1M
  const vSol = 30 + Math.max(0, realSol);
  const vTok = (30 * 1073e6) / vSol;
  return Math.max(0, Math.min(100, Math.round(((1073e6 - vTok) / 793.1e6) * 10000) / 100));
}

async function loadState(days: number): Promise<HState> {
  const r = redis();
  const s = await r.get<HState>(HK.state);
  if (s) return s;
  // replay ends where the live rats started: the first day with digs, else now
  let until = Date.now() - 3600_000;
  for (let back = 40; back >= 0; back--) {
    const d = new Date(Date.now() - back * 86400_000).toISOString().slice(0, 10);
    const dug = await r.hget<number>(K.day(d), "dug");
    if (Number(dug || 0) > 0) {
      until = Date.parse(`${d}T00:00:00Z`);
      break;
    }
  }
  return {
    phase: "anchor",
    startedAt: Date.now(),
    until,
    from: until - days * 86400_000,
    clock: 0,
    page: -1,
    sigs: [],
    pos: 0,
    scanned: 0,
    bonded: 0,
    deep: 0,
    lessons: 0,
    runnerLessons: 0,
    bt: { v0n: 0, v0hit: 0, nn: 0, nhit: 0, base: 0, baseHit: 0 },
    errors: 0,
  };
}

/** Oldest-first signatures of an address up to `untilMs` (Helius getTransactionsForAddress, else paging back). */
async function oldestSigs(address: string, untilMs: number, max = 3000): Promise<{ signature: string; slot: number; blockTime: number | null; err: unknown }[]> {
  const url = process.env.HELIUS_RPC_URL;
  if (url) {
    try {
      const out: any[] = [];
      let token: string | undefined;
      for (let i = 0; i < 4 && out.length < max; i++) {
        const res = await fetch(url, {
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
async function replay(job: Job, base: number) {
  const sigs = (await oldestSigs(job.curve, job.createdAt + CUT5 + 5000)).filter((x) => !x.err);
  if (!sigs.length) return null;
  const createSlot = sigs[0].slot;
  const in1 = sigs.filter((x) => (x.blockTime || 0) * 1000 <= job.createdAt + CUT1);
  const in5 = sigs.filter((x) => (x.blockTime || 0) * 1000 <= job.createdAt + CUT5);
  const in0 = sigs.filter((x) => (x.blockTime || 0) * 1000 <= job.createdAt + 15_000);
  // earliest 28 + the last few before each cut
  const pick = Array.from(new Set([...in5.slice(0, 28), ...in1.slice(-4), ...in5.slice(-10), ...in0.slice(-1)].map((x) => x.signature)));
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
  const trades: Trade[] = pick
    .map((s) => ({ s, t: parseTrade(bySig[s], job.curve, job.mint) }))
    .filter((x): x is { s: string; t: Trade } => !!x.t && Math.abs(x.t.sol) > 1e-6)
    .map((x) => x.t);
  const t1 = trades.filter((t) => t.t <= job.createdAt + CUT1);
  const tape1: Tape | null = in1.length ? buildTape(t1, in1.length, createSlot, job.creator, job.createdAt, job.createdAt + CUT1) : null;
  const tape5: Tape | null = in5.length ? buildTape(trades, in5.length, createSlot, job.creator, job.createdAt, job.createdAt + CUT5) : null;
  const off = await fetchOffchain(job.uri, 2000);
  const g5 = await readGraph(job.creator, tape5?.early || [], base, HGK).catch(() => null);
  const g1 = await readGraph(job.creator, tape1?.early || [], base, HGK).catch(() => null);
  const common = {
    curve0: p0,
    devBuySol: job.devBuySol,
    twitter: !!off?.twitter,
    telegram: !!off?.telegram,
    website: !!off?.website,
    description: off?.description || "",
    symbol: job.symbol,
    name: job.name,
    devN: job.devN,
    devB: job.devB,
    createdAt: job.createdAt,
  };
  const x5 = p5 != null ? features({ ...common, curve5: p5, tape: tape5, smartN: g5?.smartN, clRatio: g5?.clRatio }) : null;
  const x1 = p1 != null ? features({ ...common, curve5: p1, tape: tape1, smartN: g1?.smartN, clRatio: g1?.clRatio }) : null;
  const v0 = p5 != null ? score({ progress: p5, progress0: p0, twitter: common.twitter, telegram: common.telegram, website: common.website, description: common.description, symbol: job.symbol, name: job.name, devBuySol: job.devBuySol }) : null;
  return { x5, x1, p5, v0, tape5, g5, funder: g5?.funder ?? null };
}

/** When did the curve complete? The newest transaction touching the curve is the migration. */
async function bondTime(curve: string) {
  const s = await conn().getSignaturesForAddress(new PublicKey(curve), { limit: 1 });
  return s[0]?.blockTime ? s[0].blockTime * 1000 : null;
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
    const pools: any = await get(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`);
    const pool = pools?.data?.[0]?.attributes?.address;
    if (!pool) return null;
    const o: any = await get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/hour?limit=1000&currency=usd&token=${mint}`);
    const list: number[][] = o?.data?.attributes?.ohlcv_list || [];
    return list.map((c) => ({ t: c[0] * 1000, mc: Number(c[2]) * 1e9 })).sort((a, b) => a.t - b.t);
  } catch {
    return null;
  }
}

/** One historian session (run next to the desk inside the minute cron). */
export async function historianSession(budgetMs = 45_000) {
  const r = redis();
  const s = await getSettings();
  const cfg = s.history;
  if (!cfg.on) return { history: "off" };
  const got = await r.set(HK.lock, Date.now(), { nx: true, ex: Math.ceil(budgetMs / 1000) + 10 });
  if (!got) return { history: "busy" };
  const t0 = Date.now();
  const st = await loadState(cfg.days);
  const log: string[] = [];
  try {
    // --- 1. anchors: walk back from where live digging began, one 1000-signature page at a time
    if (st.phase === "anchor") {
      const pages = (await r.lrange<string>(HK.pages, 0, -1)) || [];
      let before: string | undefined = pages.length ? pages[pages.length - 1] : st.top ?? undefined;
      for (let i = 0; i < 12 && Date.now() - t0 < budgetMs / 2; i++) {
        const page = await conn().getSignaturesForAddress(new PublicKey(PUMP_MINT_AUTHORITY), { before, limit: 1000 });
        if (!page.length) {
          st.phase = "scan";
          break;
        }
        const oldest = page[page.length - 1];
        const oldestT = (oldest.blockTime || 0) * 1000;
        if (oldestT > st.until) {
          before = oldest.signature; // still inside the live era: keep walking back
          st.top = before;
          continue;
        }
        if (!pages.length && !(await r.llen(HK.pages))) st.top = before ?? null; // page 0 is fetched with this cursor
        before = oldest.signature;
        await r.rpush(HK.pages, oldest.signature);
        if ((oldest.blockTime || 0) * 1000 <= st.from) {
          st.phase = "scan";
          break;
        }
      }
      if (st.phase === "scan") {
        st.page = ((await r.llen(HK.pages)) || 0) - 1;
        log.push(`mapped ${st.page + 1} pages of history back to ${new Date(st.from).toISOString().slice(0, 10)}. replay starts`);
      }
    }

    const model = await loadModel();
    const model1 = await loadModel(K.nano1);
    const runner = await loadRunner();
    let dirty = false;
    let runDirty = false;
    const statsB = (await r.hmget<Record<string, number>>(K.stat, "tape_n", "tape_b")) || {};
    const base = Number(statsB.tape_n || 0) >= 200 ? Math.max(0.005, Number(statsB.tape_b) / Number(statsB.tape_n)) : 0.08;

    while (st.phase === "scan" && Date.now() - t0 < budgetMs) {
      const qlen = (await r.llen(HK.queue)) || 0;
      // --- 2. scan: parse create txs in time order, keep the dev record, queue deep reads
      if (qlen < cfg.deepPerRun * 4) {
        if (!st.sigs.length || st.pos >= st.sigs.length) {
          if (st.page < 0) {
            st.phase = "done";
            log.push(`history replay finished: ${st.scanned} launches, ${st.bonded} bonded, ${st.lessons} lessons`);
            break;
          }
          const pages = (await r.lrange<string>(HK.pages, 0, -1)) || [];
          const newer = st.page > 0 ? pages[st.page - 1] : st.top ?? undefined;
          const raw = await conn().getSignaturesForAddress(new PublicKey(PUMP_MINT_AUTHORITY), { before: newer, limit: 1000 });
          st.sigs = raw.filter((x) => !x.err && (x.blockTime || 0) * 1000 >= st.from && (x.blockTime || 0) * 1000 < st.until).map((x) => x.signature).reverse();
          st.pos = 0;
          st.page--;
        }
        const chunk = st.sigs.slice(st.pos, st.pos + cfg.scanPerRun);
        st.pos += chunk.length;
        const parsed = await pmap(chunk, 8, async (sig) => {
          try {
            const tx = await conn().getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
            const l = parseCreateTx(sig, tx);
            return l ? { ...l, slot: tx?.slot || 0 } : null;
          } catch {
            return null;
          }
        });
        const launches = parsed.filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => a.createdAt - b.createdAt);
        if (launches.length) {
          const curves = await getCurves(launches.map((l) => l.mint));
          const p = r.pipeline();
          for (const l of launches) {
            await applyPending(l.createdAt);
            const [dn, db] = await Promise.all([r.hget<number>(HK.devN, l.creator), r.hget<number>(HK.devB, l.creator)]);
            p.hincrby(HK.devN, l.creator, 1);
            p.hincrby(K.devN, l.creator, 1); // the live dev memory gets the past too
            st.scanned++;
            st.clock = l.createdAt;
            const bondedNow = !!curves[l.mint]?.complete;
            if (bondedNow) st.bonded++;
            const sampled = bondedNow || st.scanned % cfg.sample === 0;
            if (sampled)
              p.rpush(HK.queue, {
                mint: l.mint, curve: bondingCurvePda(l.mint), creator: l.creator, createdAt: l.createdAt, slot: l.slot, name: l.name, symbol: l.symbol, uri: l.uri,
                devBuySol: l.devBuySol, devN: Number(dn || 0), devB: Number(db || 0), w: bondedNow ? 1 : cfg.sample, bondedNow,
              } satisfies Job);
          }
          await p.exec();
        }
      }

      // --- 3. deep reads: rebuild minute 1 and minute 5, score first (prequential), then learn
      const jobs = ((await r.lpop<Job[]>(HK.queue, cfg.deepPerRun)) || []) as unknown as Job[];
      const list = Array.isArray(jobs) ? jobs : jobs ? [jobs as unknown as Job] : [];
      if (!list.length && qlen === 0 && st.pos >= st.sigs.length && st.page < 0) continue;
      const results = await pmap(list, 3, async (job) => {
        try {
          const bt = job.bondedNow ? await bondTime(job.curve) : null;
          const rep = await replay(job, base);
          return { job, bt, rep };
        } catch (e) {
          st.errors++;
          st.lastError = safeErr(e);
          return { job, bt: null, rep: null };
        }
      });
      const p = r.pipeline();
      for (const { job, bt, rep } of results) {
        if (!rep?.x5) continue;
        const bonded = !!bt && bt - job.createdAt <= LABEL_MS;
        // prequential backtest: score with the model as it is now, then learn
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
        learn(model, rep.x5, bonded, undefined, job.w);
        if (rep.x1) learn(model1, rep.x1, bonded, undefined, job.w);
        dirty = true;
        st.deep++;
        st.lessons++;
        // credits become knowable at the label time (or the bond), not before
        const at = job.createdAt + LABEL_MS;
        const early = rep.tape5?.early || [];
        addPend(p, { at, kind: "label", funder: rep.funder, early, bonded, id: job.mint });
        if (bt) addPend(p, { at: bt, kind: "dev", creator: job.creator, id: `d${job.mint}` });
        // post-bond run: teach the runner ladder, credit $1M runs
        if (bt && cfg.runner) {
          const path = await postRun(job.mint);
          if (path?.length) {
            const run: Run = {
              mint: job.mint, symbol: job.symbol, createdAt: job.createdAt, bondedAt: bt, hi: -1, pk: 0, xs: {},
              s: { king: rep.v0?.score ?? 0, nano: null, smartN: rep.g5?.smartN ?? 0, clRatio: rep.g5?.clRatio ?? 1, bundleShare: rep.tape5?.bundleShare ?? 0, uniq: rep.tape5?.uniq ?? 0, solPerBuy: rep.tape5?.solPerBuy ?? 0, buyShare: rep.tape5?.buyShare ?? 0, copy: false, lift: 1, funder: rep.funder, early },
            };
            const first: Record<number, number> = {};
            for (const c of path) for (let i = 0; i < MILESTONES.length; i++) if (c.mc >= MILESTONES[i] && first[i] == null && c.t >= bt - 3600_000) first[i] = c.t;
            for (let i = MILESTONES.indexOf(1e5); i < MILESTONES.length - 1; i++) {
              if (first[i] == null) break;
              const x = runFeatures(run, i, first[i]);
              const up = first[i + 1] != null && first[i + 1] - first[i] <= 6 * 3600_000;
              learn(runner, x, up, 1.5);
              p.hincrby(RK.emp, `n${i}`, 1);
              if (up) p.hincrby(RK.emp, `u${i}`, 1);
              st.runnerLessons++;
              runDirty = true;
            }
            if (first[MILLION] != null) {
              addPend(p, { at: first[MILLION], kind: "million", funder: rep.funder, early, id: `m${job.mint}` });
              log.push(`$${job.symbol} (${new Date(job.createdAt).toISOString().slice(0, 10)}) ran past $1M. its early wallets go on record`);
            }
          }
        }
      }
      await p.exec();
      if (!list.length && qlen === 0) break;
    }
    if (dirty) {
      await r.set(K.nano, model);
      await r.set(K.nano1, model1);
    }
    if (runDirty) await r.set(RK.model, runner);
    for (const l of log) await r.lpush(HK.log, { at: Date.now(), text: l });
    await r.ltrim(HK.log, 0, 49);
    if (log.length) await r.lpush(K.deskEv, ...log.map((text) => ({ agent: "HISTORIAN", at: Date.now(), text, tone: "info" })));
    if (st.lessons) await r.hset(K.deskAgent, { HISTORIAN: { agent: "HISTORIAN", at: Date.now(), text: `replayed ${st.deep} past launches (${st.bonded} bonded found), clock at ${st.clock ? new Date(st.clock).toISOString().slice(0, 16).replace("T", " ") : "…"}`, tone: "info" } });
    return { history: st.phase, scanned: st.scanned, deep: st.deep };
  } catch (e) {
    st.errors++;
    st.lastError = safeErr(e);
    return { history: "error", error: st.lastError };
  } finally {
    await r.set(HK.state, st);
    await r.del(HK.lock);
  }
}

function addPend(p: any, e: Pend) {
  p.zadd(HK.pend, { score: e.at, member: JSON.stringify(e) });
}

/** Credit everything that became knowable before `t` (replay clock), into the historian's tables and the live ones. */
async function applyPending(t: number) {
  const r = redis();
  const due = ((await r.zrange<string[]>(HK.pend, 0, t, { byScore: true, offset: 0, count: 500 })) || []) as (string | Pend)[];
  if (!due.length) return;
  const p = r.pipeline();
  for (const raw of due) {
    const e: Pend = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (e.kind === "dev" && e.creator) {
      p.hincrby(HK.devB, e.creator, 1);
      p.hincrby(K.devB, e.creator, 1);
    } else if (e.kind === "label") {
      creditResolve(p, e.funder, e.early, !!e.bonded, HGK);
      creditResolve(p, e.funder, e.early, !!e.bonded, GK);
    } else if (e.kind === "million") {
      creditMillion(p, e.funder, e.early, HGK);
      creditMillion(p, e.funder, e.early, GK);
    }
  }
  p.zrem(HK.pend, ...due.map((x) => (typeof x === "string" ? x : JSON.stringify(x))));
  await p.exec();
}

export async function getHistory() {
  const r = redis();
  const [st, log, q, pages] = await Promise.all([r.get<HState>(HK.state), r.lrange(HK.log, 0, 9), r.llen(HK.queue), r.llen(HK.pages)]);
  if (!st) return { phase: "not started", log: [] };
  const rate = (h: number, n: number) => (n ? Math.round((h / n) * 1000) / 10 : null);
  const span = st.until - st.from;
  return {
    phase: st.phase,
    from: st.from,
    until: st.until,
    clock: st.clock,
    done: span > 0 && st.clock ? Math.min(100, Math.round(((st.clock - st.from) / span) * 1000) / 10) : 0,
    pages,
    queue: q,
    scanned: st.scanned,
    bonded: st.bonded,
    deep: st.deep,
    lessons: st.lessons,
    runnerLessons: st.runnerLessons,
    backtest: { base: rate(st.bt.baseHit, st.bt.base), v0: rate(st.bt.v0hit, st.bt.v0n), v0n: st.bt.v0n, nano: rate(st.bt.nhit, st.bt.nn), nanoN: st.bt.nn },
    errors: st.errors,
    log: log || [],
  };
}
