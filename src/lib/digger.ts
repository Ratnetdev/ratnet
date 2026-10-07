import { PublicKey } from "@solana/web3.js";
import { CALL_MAX_AGE_MS, CHECKPOINTS, PUMP_MINT_AUTHORITY } from "@/config/site";
import { K, dayKey, hourKey, redis } from "./redis";
import { conn, fetchOffchain, getCurves, parseCreateTx, pmap, safeErr, solUsd, lane, RPS } from "./solana";
import { score, Verdict, KING_VERSION, verdictOf } from "./king";
import { assignWork, recordWork } from "./rats";
import { getSettings } from "./settings";
import { contributions, emptyModel, features, FeatureInput, learn, NanoModel, nanoScore, NANO_MIN } from "./nano";
import { readTape, Tape } from "./tape";
import { whyOf, type Why } from "./why";
import { noteCall } from "./receipts";
import { queueBonded, queueCall } from "./tg";
import { reviewCall } from "./film";
import { pulseMatch, pulseView } from "./pulse";
import { candidatesOf, closeTweet, dueTweets, matchOne, noteBondLink, noteMatch, noteOutcome, noteTweetLink, recentTweets, tweetIdOf, tweetLinks, accountOf, type WireMatch, type XTweet } from "./wire";
import { creditResolve, Graph, readGraph } from "./graph";
import { Meta, metaBond, metaLaunch, readMeta } from "./meta";
import { enroll, Run, runnerPass } from "./runner";
import { migrated, poolUsd, readPools } from "./pool";
import { ensureEpoch } from "./epoch";
import { trackFees, trackWeights } from "./fees";
import { agentLog } from "./agents";
import { enqueueLens } from "./lens";
import { enqueueMind } from "./mind";
import { addVamp, featOf, loadW, notePickSet, pickedOn, pickLessons, scoreOf, vampWatch, VAMP_MAX, type Cand } from "./picker";
import { computeCal, loadCal, noteCal, posWeight, v1Verdict, type Cal } from "./kingcal";
import { ensureSolHistory, recordSol, Regime, regimeAt } from "./regime";

// Extra reads for the coins worth it (curve high enough at the read): trades, wallets, narrative.
type Extra = { tape: Tape | null; g: Graph | null; meta: Meta | null; px: number; rg?: Regime | null };
const REPLAY_KEY = "rn:replay"; // recent lessons, replayed in small batches so the models learn faster
const REPLAY_MAX = 4000;
const REPLAY_PER_RUN = 64;
// Tapes are the expensive read (~30 RPC calls each). Scaled to the RPC plan: 2 per run on Helius free (10/s), 12 at 50/s.
const MAX_TAPES_PER_RUN = Math.max(2, Math.min(12, Math.floor(RPS / 4)));
// Every lesson waits for the same label window: "bonded within 2h". Without it, winners (which bond in minutes) would be
// learned long before losers (which take up to 24h to resolve), and the models would learn that everything bonds.
// Research: 85% of graduates bond within an hour (pumpfundata, Apr 2026), so 2h keeps label noise and lag small.
export const LABEL_MS = 2 * 3600_000;

export type Outcome = "BONDED" | "ALIVE" | "DIED";
type Stage = keyof typeof CHECKPOINTS;
type Cp = { p: number; mcap: number; at: number };

export type Launch = {
  mint: string;
  sig: string;
  createdAt: number;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  image: string;
  description: string;
  twitter: string;
  telegram: string;
  website: string;
  devBuySol: number;
  devN: number; // creator's launches before this one (since the rats started digging)
  devB: number; // of which bonded
  dugAt: number;
  dugBy: string;
  p0: number;
  mcap0: number;
  pNow?: number;
  mcapNow?: number;
  peak?: number;
  near?: boolean;
  cp: Partial<Record<Stage, Cp>>;
  call?: Call;
  early?: { at: number; score: number; verdict: Verdict; curve: number; x: number[] } | null; // minute-1 read
  xpre?: number[]; // features of a coin that bonded before its call (still a lesson)
  learned?: boolean;
  tape?: Tape | null;
  g?: Graph | null;
  meta?: Meta | null;
  outcome?: Outcome;
  resolvedAt?: number;
  bondSecs?: number;
  wire?: WireMatch | null; // born from a tracked X post (see lib/wire.ts)
  pulse?: { term: string; x: number; mood: string } | null; // named after a narrative rising on X right now (see lib/pulse.ts)
  completeAt?: number; // curve hit 100%: waiting for proof it migrated into its canonical pool
  stuck?: boolean; // curve completed but never migrated: not a graduation
  supply?: number; // token supply from the curve (1B on standard pump.fun)
};

export type Call = {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  createdAt: number;
  at: number;
  score: number;
  verdict: Verdict;
  counted: boolean;
  progress: number;
  version: string;
  nano: { score: number; verdict: Verdict } | null;
  x: number[];
  outcome: Outcome | null;
  devN?: number;
  devB?: number;
  soc?: number;
  px?: number; // curve price (SOL) at the call, so the desk knows when it would be chasing
  farm?: string; // why the tape flagged it as a farm (never sent to the desk)
  why?: Why; // the reasons behind the score, in plain words
  v0?: { score: number; verdict: Verdict }; // v0 rules, kept on the card once v1 (nano-led) makes the call
  parts?: Record<string, number>; // v0 points per rule (admin scorecard)
  nc?: [string, number][]; // nano: strongest feature pulls on the logit (admin scorecard)
  tp?: { n: number; uniq: number; spb: number; bs: number; sn: number; sm: number; cl: number; ds: number } | null; // tape + graph summary
};

/** Compact row for the explorer index (short keys keep the payload small). */
export type IdxRow = {
  m: string; // mint
  s: string; // symbol
  n: string; // name
  t: number; // created
  v: number; // v0 score
  V: string; // v0 verdict B/W/D
  ns: number | null; // nano score
  NV: string; // nano verdict or ""
  o: string; // outcome B/A/D or "" pending
  p: number; // curve at call
  c: 0 | 1; // counted
  dn: number;
  db: number;
  so: number; // socials count
  bs: number | null; // seconds to bond
};

const IDX_WINDOW_MS = 24 * 3600_000;

function idxRow(call: Call, bondSecs?: number): IdxRow {
  return {
    m: call.mint,
    s: (call.symbol || "").slice(0, 12),
    n: (call.name || "").slice(0, 24),
    t: call.createdAt,
    v: call.score,
    V: call.verdict[0],
    ns: call.nano?.score ?? null,
    NV: call.nano ? call.nano.verdict[0] : "",
    o: call.outcome ? call.outcome[0] : "",
    p: call.progress,
    c: call.counted ? 1 : 0,
    dn: call.devN ?? 0,
    db: call.devB ?? 0,
    so: call.soc ?? 0,
    bs: bondSecs ?? null,
  };
}

/** The explorer keeps every call the King or nano liked, plus every coin that bonded, for 24h. */
function indexCall(c: Ctx, call: Call, bondSecs?: number) {
  const liked = call.verdict !== "DUST" || (call.nano && call.nano.verdict !== "DUST");
  if (!liked && call.outcome !== "BONDED") return;
  c.p.hset(K.idx, { [call.mint]: idxRow(call, bondSecs) });
  c.p.zadd(K.idxT, { score: call.createdAt, member: call.mint });
}

export type Grad = {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  createdAt: number;
  bondedAt: number;
  secs: number;
  devN: number;
  v0: { score: number; verdict: Verdict; counted: boolean } | null;
  nano: { score: number; verdict: Verdict } | null;
  lead?: number | null; // seconds between the King's call and the bond
};

const HR_TTL = 60 * 60 * 24 * 3;
const bucket = (score: number) => Math.min(9, Math.max(0, Math.floor(score / 10)));
function hrInc(c: Ctx, at: number, field: string, n = 1) {
  const k = K.hr(hourKey(at));
  c.p.hincrby(k, field, n);
  c.p.expire(k, HR_TTL);
}

export type FeedItem = {
  kind: "dig" | Stage | "call" | "resolve" | "near" | "grad";
  rat: string;
  mint: string;
  symbol: string;
  name: string;
  at: number;
  text: string;
};

const LAUNCH_TTL = 60 * 60 * 30;
const DEAD_TTL = 60 * 60 * 6;
const BONDED_TTL = 60 * 60 * 24 * 7;
const CALL_TTL = 60 * 60 * 24 * 2;
const MAX_TX_PER_RUN = 60;
export const BOND_CALLS = "rn:bondcalls"; // newest counted BOND calls (mints)
const MAX_DUE_PER_RUN = 300;
const FRESH_MS = 10 * 60_000;
const EARLY_MAX_AGE_MS = 3 * 60_000; // a minute-1 read later than 3 minutes is skipped, not made late
const MAX_HOT_PER_RUN = 300;
const HOT_MIN = 2; // curve % that puts a launch on the hot watch
const HOT_TOP = 200; // highest curves checked every run
const HOT_ROT = 200; // plus a rotating slice of the rest of the hot set
export const EARLY_DEATH = { curve: 1, peak: 3 }; // at the 1h check: under 1% now and never above 3% = DIED

type Pipe = ReturnType<ReturnType<typeof redis>["pipeline"]>;
type Ctx = {
  p: Pipe;
  now: number;
  feed: FeedItem[];
  stat: Record<string, number>;
  model: NanoModel;
  modelDirty: boolean;
  model1: NanoModel;
  model1Dirty: boolean;
  nanoLog: { n: number; loss: number; acc: number; pos: number; at: number }[];
};

// Models are loaded once per dig() and shared by every step of the run.
let M1: NanoModel = emptyModel();
// Coins that bonded or stopped during this run, for the runner model; USD market caps the rats read off the curves.
let RUN_EV: { bonded: string[]; died: string[]; stuck: string[] } = { bonded: [], died: [], stuck: [] };
let CURVE_USD: Record<string, number> = {};
let SOL_USD = 0;
let CAL: Cal | null = null; // King v1 lines (lib/kingcal.ts), reloaded every dig
let CAL_AT = 0;

function newCtx(model: NanoModel): Ctx {
  return { p: redis().pipeline(), now: Date.now(), feed: [], stat: {}, model, modelDirty: false, model1: M1, model1Dirty: false, nanoLog: [] };
}
const inc = (c: Ctx, k: string, n = 1) => (c.stat[k] = (c.stat[k] || 0) + n);

async function flush(c: Ctx) {
  const p = c.p;
  for (const [k, v] of Object.entries(c.stat)) p.hincrby(K.stat, k, v);
  if (c.stat.bonded) {
    p.hincrby(K.day(dayKey()), "bonded", c.stat.bonded);
  }
  if (c.feed.length) {
    p.lpush(K.feed, ...c.feed);
    p.ltrim(K.feed, 0, 299);
  }
  if (c.modelDirty) p.set(K.nano, c.model);
  if (c.model1Dirty) p.set(K.nano1, c.model1);
  for (const l of c.nanoLog) p.rpush(K.nanoLog, l);
  if (c.nanoLog.length) p.ltrim(K.nanoLog, -500, -1);
  await p.exec();
}

export async function loadModel(key: string = K.nano): Promise<NanoModel> {
  const m = await redis().get<NanoModel>(key);
  return m && Array.isArray(m.w) ? m : emptyModel();
}

/** One dig, on the RPC's middle lane: the desk's own calls always go first (see lib/solana.ts). */
export async function dig(): Promise<Record<string, unknown>> {
  return lane.run(1, digInner);
}

async function digInner(): Promise<Record<string, unknown>> {
  const r = redis();
  const got = await r.set(K.digLock, Date.now(), { nx: true, ex: 40 });
  if (!got) return { skipped: "busy" };
  const started = Date.now();
  try {
    const ep = await ensureEpoch().catch((e) => ({ epochError: safeErr(e) }));
    const model = await loadModel();
    M1 = await loadModel(K.nano1);
    RUN_EV = { bonded: [], died: [], stuck: [] };
    CURVE_USD = {};
    SOL_USD = (await solUsd().catch(() => null)) || SOL_USD;
    await recordSol(SOL_USD).catch(() => {});
    ensureSolHistory().catch(() => {});
    CAL = await loadCal().catch(() => CAL);
    if (Date.now() - CAL_AT > 600_000) {
      CAL_AT = Date.now();
      CAL = await computeCal().catch(() => CAL);
    }
    const dug = await digNew(model);
    const tl = await tweetLinks().catch((e) => ({ tlinkError: safeErr(e) }));
    const wire = await wirePicks().catch((e) => ({ wireError: safeErr(e) }));
    const due = await processDue(model);
    const hot = await hotWatch(model);
    const mig = await migrations(model).catch((e) => ({ migError: safeErr(e) }));
    const les = await lessons(model);
    const run = await runnerPass(CURVE_USD, RUN_EV, SOL_USD).catch((e) => ({ runnerError: safeErr(e) }));
    // live $RAT fee pool and payout weights for the money pages (each throttled, cheap when fresh)
    await Promise.all([trackFees().catch(() => null), trackWeights().catch(() => null)]);
    return { ok: true, ...(ep || {}), ...dug, ...tl, ...wire, ...due, ...hot, ...mig, ...les, ...run, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: safeErr(e) };
  } finally {
    // Hold the lock a few seconds after each run so many open pages can't hammer the RPC.
    await r.set(K.digLock, Date.now(), { ex: process.env.RATNET_WORKER ? 1 : 5 });
  }
}

// ---------------------------------------------------------------- new launches

async function digNew(model: NanoModel) {
  const r = redis();
  const s = await getSettings();
  const cursor = (await r.get<string>(K.cursor)) || undefined;
  const raw = await conn().getSignaturesForAddress(new PublicKey(PUMP_MINT_AUTHORITY), {
    until: cursor,
    limit: cursor ? 1000 : 40,
  });
  if (!raw.length) return { dug: 0 };
  if (cursor && raw.length >= 1000) await r.hincrby(K.stat, "gaps", 1);

  const oldestFirst = [...raw].reverse();
  const batch = oldestFirst.slice(0, MAX_TX_PER_RUN);
  const newCursor = batch[batch.length - 1].signature;
  const ok = batch.filter((x) => !x.err);

  const txs = await pmap(ok, 6, async (x) => {
    try {
      return parseCreateTx(
        x.signature,
        await conn().getParsedTransaction(x.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
      );
    } catch {
      return null;
    }
  });
  const launches = txs.filter((x): x is NonNullable<typeof x> => !!x);
  if (!launches.length) {
    await r.set(K.cursor, newCursor);
    return { dug: 0, scanned: batch.length };
  }

  const creators = Array.from(new Set(launches.map((l) => l.creator).filter(Boolean)));
  const [off, curves, devN, devB] = await Promise.all([
    pmap(launches, 8, (l) => fetchOffchain(l.uri, 2000)),
    getCurves(launches.map((l) => l.mint)),
    creators.length ? r.hmget<Record<string, number>>(K.devN, ...creators) : Promise.resolve(null),
    creators.length ? r.hmget<Record<string, number>>(K.devB, ...creators) : Promise.resolve(null),
  ]);
  const work = await assignWork(launches.length, s);
  const c = newCtx(model);
  const p = c.p;
  const last: Record<string, unknown> = {};
  const seenDev: Record<string, number> = {};
  const posts: XTweet[] = await recentTweets().catch(() => []);
  const rising = (await pulseView().catch(() => null))?.rising || [];
  const dueAdds: { score: number; member: string }[] = [];
  const hotAdds: { score: number; member: string }[] = [];
  const radarAdds: { score: number; member: string }[] = [];

  launches.forEach((l, i) => {
    const o = off[i];
    const cv = curves[l.mint];
    const prior = Number(devN?.[l.creator] || 0) + (seenDev[l.creator] || 0);
    seenDev[l.creator] = (seenDev[l.creator] || 0) + 1;
    const rec: Launch = {
      ...l,
      image: o?.image || "",
      description: o?.description || "",
      twitter: o?.twitter || "",
      telegram: o?.telegram || "",
      website: o?.website || "",
      devN: prior,
      devB: Number(devB?.[l.creator] || 0),
      dugAt: c.now,
      dugBy: work.names[i],
      p0: cv?.progress ?? 0,
      mcap0: cv?.mcapSol ?? 0,
      pNow: cv?.progress ?? 0,
      peak: cv?.progress ?? 0,
      cp: {},
    };
    if (l.creator) p.hincrby(K.devN, l.creator, 1);
    metaLaunch(p, l.name, l.symbol);
    // WIRE: was this coin born from a tracked post?
    const wm = posts.length ? matchOne({ ...l, description: rec.description, twitter: rec.twitter }, posts) : null;
    const pm = !wm && rising.length ? pulseMatch(l, rising) : null;
    if (pm) rec.pulse = pm;
    // a post WIRE was not watching: fetch it (lib/wire.ts tweetLinks) and treat it as a match
    const tid = !wm ? tweetIdOf(rec.twitter, rec.description, rec.website) : null;
    if (tid) noteTweetLink(p, tid, l.mint, l.createdAt);
    if (wm) {
      rec.wire = wm;
      noteMatch(p, l.mint, l.createdAt, wm);
      agentLog(p, [{ agent: "WIRE", at: c.now, mint: l.mint, symbol: l.symbol, text: `$${l.symbol} launched ${wm.lagSec}s after @${wm.h} posted (${wm.how})`, tone: "info" }]);
    }
    const socials = [rec.twitter && "x", rec.telegram && "tg", rec.website && "web"].filter(Boolean).join(" ");
    const devTxt = prior > 0 ? ` · dev ${prior} prior${rec.devB ? `, ${rec.devB} bonded` : ""}` : "";
    c.feed.push({
      kind: "dig",
      rat: work.names[i],
      mint: l.mint,
      symbol: l.symbol,
      name: l.name,
      at: c.now,
      text: `dev buy ${l.devBuySol}◎ · curve ${rec.p0}%${socials ? " · " + socials : ""}${devTxt}`,
    });
    last[work.names[i]] = { mint: l.mint, symbol: l.symbol, at: c.now, kind: "dig" };

    if (cv?.complete) {
      completed(c, rec, LAUNCH_TTL);
      return;
    }
    p.set(K.launch(l.mint), rec, { ex: LAUNCH_TTL });
    (Object.keys(CHECKPOINTS) as Stage[]).forEach((st) => {
      const at = Math.max(l.createdAt + CHECKPOINTS[st], c.now + 1000);
      dueAdds.push({ score: at, member: `${l.mint}|${st}` });
    });
    if (rec.p0 >= HOT_MIN) {
      hotAdds.push({ score: l.createdAt, member: l.mint });
      radarAdds.push({ score: rec.p0, member: l.mint });
    }
  });
  if (dueAdds.length) p.zadd(K.due, dueAdds[0], ...dueAdds.slice(1));
  if (hotAdds.length) {
    p.zadd(K.hot, hotAdds[0], ...hotAdds.slice(1));
    p.zadd(K.radar, radarAdds[0], ...radarAdds.slice(1));
    p.zadd(K.peak, { gt: true }, radarAdds[0], ...radarAdds.slice(1));
  }

  inc(c, "dug", launches.length);
  const perHour: Record<number, number> = {};
  for (const l of launches) {
    const h = Math.floor(l.createdAt / 3600_000) * 3600_000;
    perHour[h] = (perHour[h] || 0) + 1;
  }
  for (const [h, n] of Object.entries(perHour)) hrInc(c, Number(h), "d", n);
  p.hincrby(K.day(dayKey()), "dug", launches.length);
  p.expire(K.day(dayKey()), 60 * 60 * 24 * 40);
  const lastL = launches[launches.length - 1];
  agentLog(p, [{ agent: "SCOUT", at: c.now, mint: lastL.mint, symbol: lastL.symbol, text: `dug ${launches.length} new launch${launches.length > 1 ? "es" : ""}, latest $${lastL.symbol}`, tone: "info" }]);
  p.set(K.cursor, newCursor);
  await flush(c);
  await recordWork(work.counts, last, work.real);
  return { dug: launches.length, scanned: batch.length, behind: raw.length - batch.length };
}

// ---------------------------------------------------------------- resolution

function compactRow(l: Launch) {
  return {
    mint: l.mint,
    created_at: new Date(l.createdAt).toISOString(),
    name: l.name,
    symbol: l.symbol,
    description: l.description,
    twitter: l.twitter,
    telegram: l.telegram,
    website: l.website,
    creator: l.creator,
    dev_prior_launches: l.devN ?? 0,
    dev_prior_bonded: l.devB ?? 0,
    dev_buy_sol: l.devBuySol,
    curve_at_dig: l.p0,
    curve_5m: l.cp.t5?.p ?? null,
    curve_1h: l.cp.h1?.p ?? null,
    curve_24h: l.cp.d1?.p ?? null,
    curve_peak: l.peak ?? null,
    mcap_sol_5m: l.cp.t5?.mcap ?? null,
    mcap_sol_1h: l.cp.h1?.mcap ?? null,
    king_v0_score: l.call?.score ?? null,
    king_v0_verdict: l.call?.verdict ?? null,
    king_nano_score: l.call?.nano?.score ?? null,
    king_counted: l.call?.counted ?? null,
    features: l.call?.x ?? null,
    bond_secs: l.bondSecs ?? null,
    outcome: l.outcome,
  };
}

function resolve(c: Ctx, rec: Launch, outcome: Outcome, at = c.now) {
  const p = c.p;
  rec.outcome = outcome;
  rec.resolvedAt = c.now;
  inc(c, "resolved");
  inc(c, outcome.toLowerCase());

  const bonded = outcome === "BONDED";
  if (bonded) {
    RUN_EV.bonded.push(rec.mint);
    metaBond(p, rec.name, rec.symbol);
    // just migrated: LENS looks, then MIND judges whether it keeps going (most bonded coins dump within 20 minutes)
    enqueueLens(p, rec.mint, "bond");
    enqueueMind(p, rec.mint, "bonded");
    // every bonded coin is followed for a week so the runner model sees how far it really went
    if (!rec.tape) enroll(p, runOf(rec, c.now));
  } else RUN_EV.died.push(rec.mint);
  // wallet, cluster and early-read records are credited at the label window (see lessons()), never here

  if (outcome === "BONDED") {
    rec.bondSecs = Math.max(0, Math.round((at - rec.createdAt) / 1000));
    rec.peak = 100;
    rec.pNow = 100;
    if (rec.creator) p.hincrby(K.devB, rec.creator, 1);
    hrInc(c, rec.createdAt, "b");
    const call0 = rec.call;
    const lead = call0 ? Math.max(0, Math.round((c.now - call0.at) / 1000)) : null;
    if (call0?.counted) {
      p.hincrby(K.calib, `v${bucket(call0.score)}b`, 1);
      if (call0.nano) p.hincrby(K.calib, `n${bucket(call0.nano.score)}b`, 1);
      if (call0.verdict === "BOND") {
        queueBonded(p, { mint: rec.mint, symbol: rec.symbol, score: call0.score, bondSecs: rec.bondSecs ?? 0, leadSecs: lead });
        hrInc(c, rec.createdAt, "bh");
        inc(c, "lead_sum", lead || 0);
        inc(c, "lead_n");
      }
      if (call0.nano?.verdict === "BOND") hrInc(c, rec.createdAt, "nbh");
    }
    const g: Grad = {
      mint: rec.mint,
      symbol: rec.symbol,
      name: rec.name,
      image: rec.image,
      createdAt: rec.createdAt,
      bondedAt: c.now,
      secs: rec.bondSecs,
      devN: rec.devN ?? 0,
      v0: rec.call ? { score: rec.call.score, verdict: rec.call.verdict, counted: rec.call.counted } : null,
      nano: rec.call?.nano || null,
      lead,
    };
    p.lpush(K.grads, g);
    p.ltrim(K.grads, 0, 299);
    const said = rec.call
      ? ` · king said ${rec.call.verdict} ${rec.call.score}${rec.call.verdict === "BOND" && lead ? ` ${fmtSecs(lead)} early` : ""}${rec.call.nano ? ` · nano ${rec.call.nano.score}` : ""}`
      : " · bonded before the call";
    c.feed.push({ kind: "grad", rat: "LEDGER", mint: rec.mint, symbol: rec.symbol, name: rec.name, at: c.now, text: `GRADUATED in ${fmtSecs(rec.bondSecs)}${said}` });
  } else {
    c.feed.push({
      kind: "resolve",
      rat: "LEDGER",
      mint: rec.mint,
      symbol: rec.symbol,
      name: rec.name,
      at: c.now,
      text: `${outcome}${rec.call ? ` · king said ${rec.call.verdict} ${rec.call.score}` : ""}`,
    });
  }

  if (rec.call) {
    const call = rec.call;
    call.outcome = outcome;
    p.set(K.call(rec.mint), call, { ex: CALL_TTL });
    if (call.counted) {
      tally(c, "", call.verdict, outcome);
      if (call.nano) tally(c, "n", call.nano.verdict, outcome);
    }
    indexCall(c, call, rec.bondSecs);
    p.lpush(K.callRes, call);
    p.ltrim(K.callRes, 0, 199);
    // the models learn this launch at createdAt + 2h (see LABEL_MS), not now
  }

  // Graduated before the 5-minute call: nano still learns from it, using what the rats saw at dig time.
  // No call is logged, so the scoreboard is untouched; only the model gets the lesson.
  if (!rec.call && outcome === "BONDED") {
    const x = features({
      curve5: rec.p0,
      curve0: rec.p0,
      devBuySol: rec.devBuySol,
      twitter: !!rec.twitter,
      telegram: !!rec.telegram,
      website: !!rec.website,
      description: rec.description,
      symbol: rec.symbol,
      name: rec.name,
      devN: rec.devN ?? 0,
      devB: rec.devB ?? 0,
      createdAt: rec.createdAt,
    });
    rec.xpre = x;
    p.zadd(K.lessons, { score: rec.createdAt + LABEL_MS, member: rec.mint });
    inc(c, "learn_precall");
  }

  // WIRE learns which accounts' posts make coins that bond; bonded coins that link a post point at new accounts
  if (rec.wire) noteOutcome(p, rec.wire.h, outcome === "BONDED");
  if (outcome === "BONDED") noteBondLink(p, rec.twitter);
  // FILM: the call meets its outcome. Misses and false BONDs go to the film room with the reasons behind them.
  if (rec.call) {
    const why = rec.call.why || whyOf({ ...rec, progress: rec.call.progress, progress0: rec.p0, twitter: !!rec.twitter, telegram: !!rec.telegram, website: !!rec.website, tape: rec.tape ?? null, g: rec.g ?? null, meta: rec.meta ?? null });
    const fr = reviewCall(p, { ...rec.call, why }, outcome === "BONDED", rec.bondSecs ?? null);
    if (fr) agentLog(p, [{ agent: "FILM", at: c.now, mint: rec.mint, symbol: rec.symbol, text: fr.text, tone: fr.tone }]);
  }
  p.rpush(K.resolvedHour(hourKey(rec.createdAt)), compactRow(rec));
  p.expire(K.resolvedHour(hourKey(rec.createdAt)), 60 * 60 * 24 * 4);
  p.set(K.launch(rec.mint), rec, { ex: outcome === "BONDED" ? BONDED_TTL : DEAD_TTL });
  p.zrem(K.hot, rec.mint);
  p.zrem(K.radar, rec.mint);
  p.zrem(K.peak, rec.mint);
  p.zrem(K.due, ...(Object.keys(CHECKPOINTS) as Stage[]).map((st) => `${rec.mint}|${st}`));
}

function tally(c: Ctx, prefix: string, verdict: Verdict, outcome: Outcome) {
  const v = prefix + verdict.toLowerCase();
  inc(c, `${v}_res`);
  if (verdict === "BOND" && outcome === "BONDED") inc(c, `${v}_hit`);
  if (verdict === "DUST" && outcome !== "BONDED") inc(c, `${v}_hit`);
  if (verdict === "WATCH" && outcome === "BONDED") inc(c, `${v}_bonded`);
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
export function fmtSecs(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ---------------------------------------------------------------- checkpoints + calls

async function pruneIndex() {
  const r = redis();
  const old = (await r.zrange<string[]>(K.idxT, 0, Date.now() - IDX_WINDOW_MS, { byScore: true, offset: 0, count: 1000 })) || [];
  if (!old.length) return;
  const p = r.pipeline();
  p.hdel(K.idx, ...old);
  p.zrem(K.idxT, ...old);
  await p.exec();
}

export async function processDue(model: NanoModel) {
  const r = redis();
  const now = Date.now();
  await pruneIndex();
  // Fresh checkpoints first (the minute-1 reads and minute-5 calls are only worth anything on time), then the backlog.
  // Oldest-first alone let a backlog push every call past its 15-minute window.
  const fresh = ((await r.zrange<string[]>(K.due, now - FRESH_MS, now, { byScore: true, offset: 0, count: MAX_DUE_PER_RUN })) || []) as string[];
  const old = fresh.length < MAX_DUE_PER_RUN ? (((await r.zrange<string[]>(K.due, 0, now - FRESH_MS - 1, { byScore: true, offset: 0, count: MAX_DUE_PER_RUN - fresh.length })) || []) as string[]) : [];
  const members = [...fresh, ...old];
  if (!members.length) return { checked: 0 };

  const items = members.map((m) => {
    const [mint, stage] = m.split("|");
    return { m, mint, stage: stage as Stage };
  });
  const mints = Array.from(new Set(items.map((i) => i.mint)));
  const recsArr = await r.mget<(Launch | null)[]>(...mints.map((m) => K.launch(m)));
  const recs: Record<string, Launch> = {};
  mints.forEach((m, i) => {
    if (recsArr[i]) recs[m] = recsArr[i] as Launch;
  });
  const live = Object.keys(recs);
  const [curves, peaks] = await Promise.all([getCurves(live), live.length ? r.zmscore(K.peak, live) : Promise.resolve(null)]);
  const peakOf: Record<string, number> = {};
  live.forEach((m, i) => (peakOf[m] = Number(peaks?.[i] ?? 0)));
  if (SOL_USD) for (const m of live) if (curves[m] && !curves[m]!.complete) CURVE_USD[m] = curves[m]!.mcapSol * SOL_USD;
  const s = await getSettings();

  // Coins about to get a read (minute 1) or a call (minute 5): narrative for all, trades and wallets for the ones moving.
  const reading = items.filter((it) => {
    const rec = recs[it.mint];
    const cv = curves[it.mint];
    if (!rec || rec.outcome || !cv || cv.complete) return false;
    const age = now - rec.createdAt;
    return (it.stage === "t5" && !rec.call && age <= CALL_MAX_AGE_MS) || (it.stage === "t1" && !rec.early && age <= EARLY_MAX_AGE_MS);
  });
  const tapeable = reading
    .filter((it) => (curves[it.mint]?.progress ?? 0) >= (it.stage === "t5" ? s.desk.tapeMinCurve : s.desk.earlyMinCurve))
    // minute-5 calls first (they go to the desk), then the fullest curves
    .sort((a, b) => (a.stage === b.stage ? 0 : a.stage === "t5" ? -1 : 1) || (curves[b.mint]?.progress ?? 0) - (curves[a.mint]?.progress ?? 0))
    .slice(0, MAX_TAPES_PER_RUN);
  const [metaMap, st] = await Promise.all([
    readMeta(reading.map((it) => ({ mint: it.mint, name: recs[it.mint].name, symbol: recs[it.mint].symbol }))).catch(() => ({} as Record<string, Meta>)),
    r.hmget<Record<string, number>>(K.stat, "tape_n", "tape_b"),
  ]);
  const base = tapeBase(st);
  const rg = await regimeAt(now).catch(() => null);
  const extras: Record<string, Extra> = {};
  for (const it of reading) extras[it.m] = { tape: null, g: null, meta: metaMap[it.mint] || null, px: curves[it.mint]?.priceSol || 0, rg };
  await pmap(tapeable, 4, async (it) => {
    const rec = recs[it.mint];
    const tape = await readTape(rec.mint, rec.creator, rec.createdAt);
    const g = await readGraph(rec.creator, tape?.early || [], base).catch(() => null);
    extras[it.m] = { ...extras[it.m], tape, g };
  });

  const work = await assignWork(items.length, s);
  const c = newCtx(model);
  const p = c.p;
  const last: Record<string, unknown> = {};
  const touched = new Set<string>();
  const hotAdds: { score: number; member: string }[] = [];
  const radarAdds: { score: number; member: string }[] = [];

  const order: Record<Stage, number> = { t1: -1, t5: 0, h1: 1, d1: 2 };
  items.sort((a, b) => order[a.stage] - order[b.stage]);
  p.zrem(K.due, ...members);

  items.forEach((it, i) => {
    const rec = recs[it.mint];
    const rat = work.names[i];
    if (!rec || rec.outcome) return;
    const cv = curves[it.mint];
    const prog = cv?.progress ?? rec.pNow ?? rec.p0;
    const cp: Cp = { p: prog, mcap: cv?.mcapSol ?? 0, at: c.now };
    rec.cp[it.stage] = cp;
    rec.pNow = prog;
    rec.peak = Math.max(rec.peak ?? 0, peakOf[it.mint] || 0, prog);
    if (cv) rec.mcapNow = cv.mcapSol;
    touched.add(it.mint);
    last[rat] = { mint: rec.mint, symbol: rec.symbol, at: c.now, kind: it.stage };

    if (cv?.supply) rec.supply = cv.supply;
    if (cv?.complete || rec.completeAt) {
      completed(c, rec);
      touched.delete(it.mint);
      return;
    }

    const age = c.now - rec.createdAt;
    if (it.stage === "t1") {
      // a late minute-1 read would be scored on data from much later: skip it rather than teach the model wrong
      if (!rec.early && !rec.call && age <= EARLY_MAX_AGE_MS) makeEarly(c, rec, cp.p, extras[it.m] || { tape: null, g: null, meta: null, px: cv?.priceSol || 0 });
      else if (!rec.early) inc(c, "early_missed");
    } else if (it.stage === "t5" && !rec.call && age > CALL_MAX_AGE_MS) {
      // too late to count, and its features would describe the coin long after minute 5: no call, no lesson
      inc(c, "calls_missed");
    } else if (it.stage === "t5" && !rec.call) {
      makeCall(c, rec, cp.p, extras[it.m] || { tape: null, g: null, meta: null, px: cv?.priceSol || 0 });
    } else if (it.stage === "h1") {
      // Dead on arrival: nothing on the curve after an hour and it never got going. Resolve now so
      // the scoreboard and the learner see losers as fast as winners.
      if (prog < EARLY_DEATH.curve && (rec.peak ?? 0) < EARLY_DEATH.peak) {
        resolve(c, rec, "DIED");
        touched.delete(it.mint);
        return;
      }
      c.feed.push({ kind: "h1", rat, mint: rec.mint, symbol: rec.symbol, name: rec.name, at: c.now, text: `1h sniff · curve ${cp.p}% · peak ${rec.peak}%` });
    } else if (it.stage === "d1") {
      resolve(c, rec, cp.p < 5 ? "DIED" : "ALIVE");
      touched.delete(it.mint);
      return;
    }
    if (prog >= HOT_MIN) {
      hotAdds.push({ score: rec.createdAt, member: rec.mint });
      radarAdds.push({ score: prog, member: rec.mint });
    }
  });
  if (hotAdds.length) {
    p.zadd(K.hot, hotAdds[0], ...hotAdds.slice(1));
    p.zadd(K.radar, radarAdds[0], ...radarAdds.slice(1));
    p.zadd(K.peak, { gt: true }, radarAdds[0], ...radarAdds.slice(1));
  }

  for (const m of touched) p.set(K.launch(m), recs[m], { ex: LAUNCH_TTL });
  p.zremrangebyrank(K.calls, 0, -5001);
  await flush(c);
  await recordWork(work.counts, last, work.real);
  return { checked: items.length };
}

function tapeBase(st: Record<string, number> | null) {
  const n = Number(st?.tape_n || 0);
  const b = Number(st?.tape_b || 0);
  return n >= 200 ? Math.max(0.005, b / n) : 0.08; // bond rate of coins moving enough to be taped
}

function featIn(rec: Launch, curveNow: number, ex: Extra): FeatureInput {
  return {
    curve5: curveNow,
    curve0: rec.p0,
    devBuySol: rec.devBuySol,
    twitter: !!rec.twitter,
    telegram: !!rec.telegram,
    website: !!rec.website,
    description: rec.description,
    symbol: rec.symbol,
    name: rec.name,
    devN: rec.devN ?? 0,
    devB: rec.devB ?? 0,
    createdAt: rec.createdAt,
    tape: ex.tape,
    smartN: ex.g?.smartN,
    clRatio: ex.g?.clRatio,
    copy: ex.meta?.copy,
    dup: ex.meta?.dup,
    lift: ex.meta?.lift,
    rg: ex.rg ?? null,
    post: rec.wire ? { score: rec.wire.score, f: rec.wire.f ?? 0, link: rec.wire.how === "links the post" || rec.wire.how === "posted the CA" } : null,
    pulseX: rec.pulse?.x ?? 0,
  };
}

export function runOf(rec: Launch, bondedAt: number | null): Run {
  return {
    mint: rec.mint,
    supply: rec.supply,
    symbol: rec.symbol,
    createdAt: rec.createdAt,
    bondedAt,
    hi: -1,
    pk: 0,
    xs: {},
    s: {
      king: rec.call?.score ?? 0,
      nano: rec.call?.nano?.score ?? null,
      smartN: rec.g?.smartN ?? 0,
      clRatio: rec.g?.clRatio ?? 1,
      bundleShare: rec.tape?.bundleShare ?? 0,
      uniq: rec.tape?.uniq ?? 0,
      solPerBuy: rec.tape?.solPerBuy ?? 0,
      buyShare: rec.tape?.buyShare ?? 0,
      copy: !!rec.meta?.copy,
      lift: rec.meta?.lift ?? 1,
      funder: rec.g?.funder ?? null,
      early: rec.tape?.early ?? [],
    },
    cUsd: rec.cp.t5?.mcap && SOL_USD ? Math.round(rec.cp.t5.mcap * SOL_USD) : null,
    verdict: rec.call?.verdict ?? null,
  };
}

function tapeLine(t: Tape) {
  return `${t.n} trades, ${t.uniq} traders, ${t.solPerBuy}◎/buy, buys ${Math.round(t.buyShare * 100)}%, bundle ${Math.round(t.bundleShare * 100)}%${t.sniperN ? `, ${t.sniperN} snipers` : ""}${t.devSold > 0 ? `, dev sold ${t.devSold}◎` : ", dev holding"}`;
}
function graphLine(g: Graph, meta: Meta | null) {
  const cl = g.funder ? `dev funded by ${g.funder.slice(0, 4)}…: ${g.clN} launches, ${g.clB} bonded (${g.clRatio}x)` : "fresh dev, no funder history";
  return `${cl}${g.smartN ? ` · ${g.smartN} smart wallet${g.smartN > 1 ? "s" : ""} early` : ""}${meta?.hot ? ` · meta "${meta.hot}" ${meta.lift}x` : ""}${meta?.copy ? " · copies a recent winner" : ""}`;
}

/** Minute-1 read: its own model, its own scoreboard. The desk may act on it only after the early record earns it. */
function makeEarly(c: Ctx, rec: Launch, curveNow: number, ex: Extra) {
  const x = features(featIn(rec, curveNow, ex));
  const v0 = score({ progress: curveNow, progress0: rec.p0, twitter: !!rec.twitter, telegram: !!rec.telegram, website: !!rec.website, description: rec.description, symbol: rec.symbol, name: rec.name, devBuySol: rec.devBuySol, farm: !!ex.tape?.farm?.farm, wire: !!rec.wire, pulse: !rec.wire && !!rec.pulse });
  const sc = c.model1.n >= NANO_MIN ? nanoScore(c.model1, x) : v0.score;
  const verdict = verdictOf(sc);
  rec.early = { at: c.now, score: sc, verdict, curve: curveNow, x };
  c.p.zadd(K.lessons, { score: rec.createdAt + LABEL_MS, member: rec.mint });
  if (ex.tape) {
    rec.tape = ex.tape;
    rec.g = ex.g;
  }
  rec.meta = ex.meta;
  inc(c, `e${verdict.toLowerCase()}_n`);
  if (verdict === "BOND" && ex.tape && !ex.tape.farm?.farm) {
    c.p.zadd(K.deskQ, { score: c.now, member: rec.mint });
    const ev = { agent: "SCOUT", at: c.now, mint: rec.mint, symbol: rec.symbol, text: `$${rec.symbol} early read BOND ${sc} at minute 1, curve ${curveNow}%`, tone: "ok" };
    c.p.lpush(K.deskEv, ev);
    agentLog(c.p, [ev]);
  }
  c.feed.push({ kind: "t1", rat: "RAT KING", mint: rec.mint, symbol: rec.symbol, name: rec.name, at: c.now, text: `early read ${verdict} ${sc} · curve ${curveNow}%${ex.tape ? ` · ${ex.tape.n} trades` : ""}` });
}

function makeCall(c: Ctx, rec: Launch, curveNow: number, ex: Extra) {
  if (ex.tape) {
    rec.tape = ex.tape;
    rec.g = ex.g;
  }
  if (ex.meta) rec.meta = ex.meta;
  const farm = rec.tape?.farm?.farm ? rec.tape.farm : null;
  const sc = score({
    progress: curveNow,
    progress0: rec.p0,
    twitter: !!rec.twitter,
    telegram: !!rec.telegram,
    website: !!rec.website,
    description: rec.description,
    symbol: rec.symbol,
    name: rec.name,
    devBuySol: rec.devBuySol,
    farm: !!farm,
    wire: !!rec.wire,
    pulse: !rec.wire && !!rec.pulse,
  });
  const x = features(featIn(rec, curveNow, { ...ex, tape: rec.tape ?? null, g: rec.g ?? null, meta: rec.meta ?? null }));
  const nano =
    c.model.n >= NANO_MIN
      ? (() => {
          const ns = nanoScore(c.model, x);
          return { score: ns, verdict: verdictOf(ns) };
        })()
      : null;
  // Rat King v1: once nano is trained and its lines are calibrated on the last 7 days (lib/kingcal.ts), nano leads.
  // v0's rules stay on the card. A coin born from a big post keeps a v0 BOND: nano is only starting to see posts.
  const v1 = nano && CAL?.ready ? v1Verdict(nano.score, CAL) : null;
  if (nano && v1) nano.verdict = v1;
  const bigPost = !!rec.wire && ((rec.wire.f ?? 0) >= 100_000 || rec.wire.how === "posted the CA");
  const kv = v1
    ? farm || !(bigPost && sc.verdict === "BOND" && v1 !== "BOND")
      ? { score: nano!.score, verdict: (farm ? "DUST" : v1) as Verdict, version: "v1.0" }
      : { score: sc.score, verdict: "BOND" as Verdict, version: "v1.0" }
    : { score: sc.score, verdict: sc.verdict, version: KING_VERSION };
  const counted = c.now - rec.createdAt <= CALL_MAX_AGE_MS;
  rec.call = {
    mint: rec.mint,
    symbol: rec.symbol,
    name: rec.name,
    image: rec.image,
    createdAt: rec.createdAt,
    at: c.now,
    score: kv.score,
    verdict: kv.verdict,
    v0: { score: sc.score, verdict: sc.verdict },
    counted,
    progress: curveNow,
    version: kv.version,
    nano,
    x,
    parts: sc.parts,
    nc: c.model.n >= 50 ? contributions(c.model, x) : undefined,
    outcome: null,
    devN: rec.devN ?? 0,
    devB: rec.devB ?? 0,
    soc: [rec.twitter, rec.telegram, rec.website].filter(Boolean).length,
    px: ex.px || undefined,
    farm: farm?.why || undefined,
    why: whyOf({ ...rec, progress: curveNow, progress0: rec.p0, twitter: !!rec.twitter, telegram: !!rec.telegram, website: !!rec.website, tape: rec.tape ?? null, g: rec.g ?? null, meta: rec.meta ?? null }),
    tp: rec.tape
      ? { n: rec.tape.n, uniq: rec.tape.uniq, spb: rec.tape.solPerBuy, bs: rec.tape.bundleShare, sn: rec.tape.sniperN, sm: rec.g?.smartN ?? 0, cl: rec.g?.clRatio ?? 1, ds: rec.tape.devSold }
      : null,
  };
  c.p.set(K.call(rec.mint), rec.call, { ex: CALL_TTL });
  c.p.zadd(K.lessons, { score: rec.createdAt + LABEL_MS, member: rec.mint });
  if (rec.tape) enroll(c.p, runOf(rec, null));
  indexCall(c, rec.call);
  c.p.zadd(K.calls, { score: rec.createdAt, member: rec.mint });
  inc(c, "calls");
  // LENS takes a hands-on look at BOND calls and at launches named after a rising narrative
  if (counted && !farm && (kv.verdict === "BOND" || nano?.verdict === "BOND")) {
    enqueueLens(c.p, rec.mint, "bond");
    enqueueMind(c.p, rec.mint, "bond");
  } else if (counted && !farm && rec.pulse && curveNow >= 10) {
    enqueueLens(c.p, rec.mint, "pulse");
    enqueueMind(c.p, rec.mint, "pulse");
  }
  if (counted && kv.verdict === "BOND" && !farm) queueCall(c.p, { mint: rec.mint, symbol: rec.symbol, name: rec.name, score: kv.score, nano, progress: curveNow, mc: CURVE_USD[rec.mint] ? Math.round(CURVE_USD[rec.mint]) : null, plus: rec.call.why?.plus || [], minus: rec.call.why?.minus || [] });
  if (counted && (kv.verdict === "BOND" || nano?.verdict === "BOND")) {
    // every counted BOND call (King or nano) is listed on the homepage, farms included so nothing is hidden
    c.p.lpush(BOND_CALLS, rec.mint);
    c.p.ltrim(BOND_CALLS, 0, 99);
  }
  if (counted && !farm && !rec.tape && (kv.verdict === "BOND" || nano?.verdict === "BOND")) {
    // the rats had no time to read its trades: the desk reads them itself (on its own fast lane) before VET
    c.p.zadd(K.deskQ, { score: c.now, member: rec.mint });
    const ev = { agent: "KING", at: c.now, mint: rec.mint, symbol: rec.symbol, text: `$${rec.symbol} ${kv.verdict} ${kv.score}, sent to the desk (TAPE reads it there)`, tone: "ok" };
    c.p.lpush(K.deskEv, ev);
    agentLog(c.p, [ev]);
  }
  if (counted && !farm && rec.tape && (kv.verdict === "BOND" || nano?.verdict === "BOND")) {
    // hand the coin to the desk; the desk loop picks it up within 2 seconds
    c.p.zadd(K.deskQ, { score: c.now, member: rec.mint });
    const ev = { agent: "KING", at: c.now, mint: rec.mint, symbol: rec.symbol, text: `$${rec.symbol} ${kv.verdict} ${kv.score}${nano ? ` · nano ${nano.verdict} ${nano.score}` : ""}, sent to the desk`, tone: "ok" };
    const evs: any[] = [ev];
    if (rec.tape) evs.push({ agent: "TAPE", at: c.now, mint: rec.mint, symbol: rec.symbol, text: `$${rec.symbol}: ${tapeLine(rec.tape)}`, tone: rec.tape.devSold > 0 || rec.tape.bundleShare > 0.5 ? "bad" : "info" });
    if (rec.g) evs.push({ agent: "GRAPH", at: c.now, mint: rec.mint, symbol: rec.symbol, text: `$${rec.symbol}: ${graphLine(rec.g, rec.meta ?? null)}`, tone: rec.g.clRatio < 0.5 ? "bad" : rec.g.smartN || rec.g.clRatio > 2 ? "ok" : "info" });
    c.p.lpush(K.deskEv, ...evs);
    agentLog(c.p, evs);
  }
  if (counted) {
    noteCall(c.p, rec.call); // hashed into the hourly on-chain receipt (see lib/receipts.ts)
    c.p.hincrby(K.calib, `v${bucket(kv.score)}n`, 1);
    if (nano) c.p.hincrby(K.calib, `n${bucket(nano.score)}n`, 1);
    if (kv.verdict === "BOND") hrInc(c, rec.createdAt, "bn");
    if (nano?.verdict === "BOND") hrInc(c, rec.createdAt, "nbn");
    inc(c, `${kv.verdict.toLowerCase()}_n`);
    if (nano) inc(c, `n${nano.verdict.toLowerCase()}_n`);
    c.p.hincrby(K.day(dayKey()), "calls", 1);
  } else inc(c, "calls_late");
  c.feed.push({
    kind: "call",
    rat: "RAT KING",
    mint: rec.mint,
    symbol: rec.symbol,
    name: rec.name,
    at: c.now,
    text: `${kv.verdict} ${kv.score}/100${nano ? ` · nano ${nano.verdict} ${nano.score}` : ""} · curve ${curveNow}%${farm ? ` · FARM (${farm.why})` : ""}${counted ? "" : " · late, not counted"}`,
  });
}

// ---------------------------------------------------------------- WIRE picks

const WIRE_MIN_CURVE = 2; // % before a tweet coin counts as a real candidate
const WIRE_WAIT_MS = 10 * 60_000; // give up on a post after this long without a real candidate

/** 30s after the first launch on a post: score every copy with the learned picker (volume, holders, who was first),
 *  read the tapes of the strongest, hand the leader to the desk. Then watch the post 30 minutes for a vamp. */
async function wirePicks() {
  const r = redis();
  const due = await dueTweets();
  let picked = 0;
  const s = await getSettings();
  const W = await loadW();
  for (const d of due) {
    const mints = d.mints.map((x) => x.mint);
    const recs = mints.length ? (((await r.mget<(Launch | null)[]>(...mints.map((m) => K.launch(m)))) || []) as (Launch | null)[]) : [];
    const curves = mints.length ? await getCurves(mints) : {};
    const all = d.mints.map((x, i) => ({ ...x, rec: recs[i], cv: curves[x.mint] })).filter((x) => x.rec);
    const live = all.filter((x) => !x.rec!.outcome && x.cv && !x.cv.complete && x.cv.progress >= WIRE_MIN_CURVE);
    const wm = recs.find((x) => x?.wire)?.wire;
    if (!live.length) {
      if (d.age > WIRE_WAIT_MS) await closeTweet(d.tid, null, wm?.h || "?");
      continue;
    }
    const firstAt = Math.min(...all.map((x) => x.rec!.createdAt));
    // traction: how many coins the post spawned and how much SOL went into all of them together
    const trac = { copies: all.length, sol: Math.round(all.reduce((a, x) => a + (x.cv?.realSol ?? 0), 0) * 10) / 10 };
    // tapes for the 3 copies with the most SOL in: holders, bundles, farms
    const bySol = [...live].sort((a, b) => (b.cv!.realSol ?? 0) - (a.cv!.realSol ?? 0)).slice(0, 3);
    const tapes: Record<string, Tape | null> = {};
    for (const x of bySol) tapes[x.mint] = await readTape(x.mint, x.rec!.creator, x.rec!.createdAt).catch(() => null);
    const now = Date.now();
    const cands = live.map((x) => {
      const t = tapes[x.mint];
      const c: Cand = { mint: x.mint, symbol: x.rec!.symbol, createdAt: x.rec!.createdAt, score: x.score, how: x.rec!.wire?.how || "", progress: x.cv!.progress, realSol: x.cv!.realSol, uniq: t ? t.organic ?? t.uniq : null, top5: t ? t.top5 : null, bundle: t ? t.bundleShare : null };
      const f = featOf(c, firstAt, now);
      return { ...x, c, f, s: scoreOf(W.w, f), tape: t };
    });
    // the leader: best learned score among the copies whose trades were read and that are not farms
    const eligible = cands.filter((x) => x.tape && !x.tape.farm?.farm).sort((a, b) => b.s - a.s);
    const lead = eligible[0];
    const rec = lead?.rec;
    if (!rec || !rec.wire) {
      if (d.age > WIRE_WAIT_MS) await closeTweet(d.tid, null, wm?.h || "?");
      continue;
    }
    rec.tape = lead.tape!;
    rec.wire = { ...rec.wire, pick: true, trac };
    await r.set(K.launch(rec.mint), rec, { keepTtl: true });
    await closeTweet(d.tid, rec.mint, rec.wire.h);
    await notePickSet(d.tid, rec.wire.h, rec.mint, cands.map((x) => ({ mint: x.mint, symbol: x.c.symbol, x: x.f })));
    picked++;
    const { w } = await accountOf(rec.wire.h);
    const p = r.pipeline();
    const send = w >= (s.desk.wireMinW ?? 0.2);
    if (send) p.zadd(K.deskQ, { score: Date.now(), member: `w:${rec.mint}` });
    enqueueLens(p, rec.mint, "wire");
    enqueueMind(p, rec.mint, "wire");
    const why = [lead.f[0] ? "first out" : null, `${lead.c.realSol.toFixed(1)} SOL in`, lead.c.uniq != null ? `${lead.c.uniq} traders` : null, lead.c.top5 != null ? `top 5 hold ${Math.round(lead.c.top5 * 100)}%` : null].filter(Boolean).join(", ");
    agentLog(p, [{ agent: "WIRE", at: Date.now(), mint: rec.mint, symbol: rec.symbol, text: `picked $${rec.symbol} of ${trac.copies} coin${trac.copies > 1 ? "s" : ""} on @${rec.wire.h}'s post (${why}; all copies ${trac.sol} SOL). trust in @${rec.wire.h} ${w}${send ? ", sent to the desk" : ", below the trust line: learning only"}. watching 30 minutes for a vamp`, tone: send ? "ok" : "info" }]);
    if (send) p.lpush(K.deskEv, { agent: "WIRE", at: Date.now(), mint: rec.mint, symbol: rec.symbol, text: `$${rec.symbol} from @${rec.wire.h}'s post, sent to the desk`, tone: "ok" });
    await p.exec();
  }
  const vamps = await vampPicks(s).catch(() => 0);
  return { wirePicked: picked, vamps, ...(await pickLessons().catch(() => ({}))) };
}

/** A copy that clearly out-pulls the pick (more SOL in, faster) on a post with proven traction: pick it too. */
async function vampPicks(s: Awaited<ReturnType<typeof getSettings>>) {
  const r = redis();
  let n = 0;
  for (const tid of await vampWatch()) {
    const already = await pickedOn(tid);
    if (already.length >= 1 + VAMP_MAX) continue;
    const cs = await candidatesOf(tid);
    if (cs.length < 2) continue;
    const recs = ((await r.mget<(Launch | null)[]>(...cs.map((x) => K.launch(x.mint)))) || []) as (Launch | null)[];
    const curves = await getCurves(cs.map((x) => x.mint));
    const rows = cs.map((x, i) => ({ ...x, rec: recs[i], cv: curves[x.mint] })).filter((x) => x.rec && x.cv);
    const trac = { copies: rows.length, sol: Math.round(rows.reduce((a, x) => a + (x.cv?.realSol ?? 0), 0) * 10) / 10 };
    // proven hype: many copies and real money across them (a hint COACH can overrule through the traction prior)
    if (trac.copies < 4 || trac.sol < 40) continue;
    const pace = (x: (typeof rows)[number]) => (x.cv!.realSol ?? 0) / Math.max(0.5, (Date.now() - x.rec!.createdAt) / 60_000);
    const mine = rows.filter((x) => already.includes(x.mint));
    const base = Math.max(0, ...mine.map((x) => x.cv!.realSol ?? 0));
    const basePace = Math.max(0, ...mine.map(pace));
    const v = rows
      .filter((x) => !already.includes(x.mint) && !x.rec!.outcome && !x.cv!.complete && x.cv!.progress <= 85 && (x.cv!.realSol ?? 0) >= Math.max(base * 1.25, 15) && pace(x) > basePace)
      .sort((a, b) => pace(b) - pace(a))[0];
    if (!v) continue;
    const tape = await readTape(v.mint, v.rec!.creator, v.rec!.createdAt).catch(() => null);
    if (!tape || tape.farm?.farm) continue;
    const rec = v.rec!;
    rec.tape = tape;
    rec.wire = { ...(rec.wire || { tid, h: "?", score: v.score, how: "named after the post", lagSec: 0, text: "" }), pick: true, vamp: true, trac };
    await r.set(K.launch(rec.mint), rec, { keepTtl: true });
    await addVamp(tid, rec.mint);
    n++;
    const { w } = await accountOf(rec.wire.h);
    const send = w >= (s.desk.wireMinW ?? 0.2);
    const p = r.pipeline();
    if (send) p.zadd(K.deskQ, { score: Date.now(), member: `w:${rec.mint}` });
    enqueueMind(p, rec.mint, "wire");
    agentLog(p, [{ agent: "WIRE", at: Date.now(), mint: rec.mint, symbol: rec.symbol, text: `vamp on @${rec.wire.h}'s post: $${rec.symbol} pulls ${(v.cv!.realSol ?? 0).toFixed(1)} SOL vs ${base.toFixed(1)} on our pick, faster (${trac.copies} copies, ${trac.sol} SOL across them)${send ? ", sent to the desk as a vamp" : ": learning only"}`, tone: send ? "ok" : "info" }]);
    await p.exec();
  }
  return n;
}

// ---------------------------------------------------------------- graduation proof

// A complete curve is not a graduation until the coin sits in its canonical PumpSwap pool (see lib/pool.ts).
// pump.fun migrates within seconds; after MIGRATE_GRACE with no pool the coin is resolved as not bonded.
export const MIGRATE_GRACE = 30 * 60_000;

function completed(c: Ctx, rec: Launch, ttl?: number) {
  if (!rec.completeAt) {
    rec.completeAt = c.now;
    rec.pNow = 100;
    rec.peak = 100;
    c.p.zadd(K.migr, { score: c.now, member: rec.mint });
    c.feed.push({ kind: "resolve", rat: "LEDGER", mint: rec.mint, symbol: rec.symbol, name: rec.name, at: c.now, text: "curve full · checking the migration pool" });
  }
  c.p.set(K.launch(rec.mint), rec, ttl ? { ex: ttl } : { keepTtl: true });
}

async function migrations(model: NanoModel) {
  const r = redis();
  const mints = ((await r.zrange<string[]>(K.migr, 0, 199)) || []) as string[];
  if (!mints.length) return { migrating: 0 };
  const [recs, pools] = await Promise.all([r.mget<(Launch | null)[]>(...mints.map((m) => K.launch(m))), readPools(mints)]);
  const c = newCtx(model);
  let ok = 0;
  let stuck = 0;
  mints.forEach((m, i) => {
    const rec = recs[i];
    if (!rec || rec.outcome) {
      c.p.zrem(K.migr, m);
      return;
    }
    const at = rec.completeAt || c.now;
    if (migrated(pools[m])) {
      resolve(c, rec, "BONDED", at);
      if (SOL_USD) CURVE_USD[m] = poolUsd(pools[m], SOL_USD, rec.supply);
      c.p.zrem(K.migr, m);
      ok++;
    } else if (c.now - at > MIGRATE_GRACE) {
      rec.stuck = true;
      RUN_EV.stuck.push(m);
      inc(c, "stuck");
      c.feed.push({ kind: "resolve", rat: "LEDGER", mint: rec.mint, symbol: rec.symbol, name: rec.name, at: c.now, text: "curve full but never migrated · not counted as a graduation" });
      resolve(c, rec, "DIED");
      c.p.zrem(K.migr, m);
      stuck++;
    }
  });
  await flush(c);
  return { migrating: mints.length - ok - stuck, migrated: ok, stuck };
}

// ---------------------------------------------------------------- lessons (label window reached)

async function lessons(model: NanoModel) {
  const r = redis();
  const now = Date.now();
  const due = (await r.zrange<string[]>(K.lessons, 0, now, { byScore: true, offset: 0, count: 300 })) || [];
  if (!due.length) return { lessons: 0 };
  const recs = await r.mget<(Launch | null)[]>(...due.map((m) => K.launch(m)));
  const c = newCtx(model);
  let n = 0;
  const fresh: Lesson[] = [];
  const wait: string[] = [];
  due.forEach((m, i) => {
    const rec = recs[i];
    if (!rec || rec.learned) return;
    if (rec.completeAt && !rec.outcome) {
      // curve full, migration not proven yet: learn it once we know
      wait.push(m);
      return;
    }
    // label: bonded within the window (a bond after 2h is rare; it still counts on the scoreboard, not in training)
    const bonded = rec.outcome === "BONDED" && (rec.bondSecs ?? Infinity) * 1000 <= LABEL_MS;
    const x = rec.call?.x?.length ? rec.call.x : rec.xpre;
    if (x?.length) {
      // King v1 calibration: nano's score on this lesson BEFORE it learns from it
      noteCal(c.p, nanoScore(c.model, x), bonded);
      learn(c.model, x, bonded, posWeight(c.model.n, c.model.pos));
      c.modelDirty = true;
      n++;
      if (c.model.n % 25 === 0) c.nanoLog.push({ n: c.model.n, loss: round4(c.model.loss), acc: round4(c.model.acc), pos: c.model.pos, at: c.now });
    }
    const x1 = rec.early?.x?.length ? rec.early.x : rec.xpre;
    if (x1?.length) {
      learn(c.model1, x1, bonded, posWeight(c.model1.n, c.model1.pos));
      c.model1Dirty = true;
    }
    // same moment for winners and losers: wallet and cluster records, and the early-vs-King record that gates early entries
    if (rec.tape) {
      inc(c, "tape_n");
      if (bonded) inc(c, "tape_b");
      creditResolve(c.p, rec.g?.funder, rec.tape.early, bonded);
    }
    if (rec.early?.verdict === "BOND") {
      inc(c, "lebond_n");
      if (bonded) inc(c, "lebond_hit");
    }
    if (rec.call?.counted && rec.call.verdict === "BOND") {
      inc(c, "lbond_n");
      if (bonded) inc(c, "lbond_hit");
      // honest scoreboard per King version, resolved at the 2-hour label only
      inc(c, `lb:${rec.call.version}:n`);
      if (bonded) inc(c, `lb:${rec.call.version}:hit`);
    }
    // recall: every bond in the window, called or not
    if (bonded) inc(c, "lbonded");
    rec.learned = true;
    c.p.set(K.launch(m), rec, { keepTtl: true });
    if (x?.length || x1?.length) fresh.push({ x: x?.length ? x : null, x1: x1?.length ? x1 : null, y: bonded ? 1 : 0 });
  });
  c.p.zrem(K.lessons, ...due);
  for (const m of wait) c.p.zadd(K.lessons, { score: now + 60_000, member: m });
  if (fresh.length) {
    c.p.lpush(REPLAY_KEY, ...fresh);
    c.p.ltrim(REPLAY_KEY, 0, REPLAY_MAX - 1);
  }
  const shifted = c.model.shiftAt && c.model.shiftAt >= c.now - 15_000;
  if (shifted) {
    const ev = { agent: "COACH", at: c.now, text: `market shift: nano's recent loss ${(c.model.lossFast ?? 0).toFixed(3)} vs ${c.model.loss.toFixed(3)} long-run. learning ${2.5}x faster for the next 400 lessons`, tone: "info" };
    c.p.lpush(K.deskEv, ev);
    c.feed.push({ kind: "resolve", rat: "COACH", mint: "", symbol: "", name: "", at: c.now, text: ev.text });
  }
  await flush(c);
  return { lessons: n, ...(await replay(model).catch(() => ({}))) };
}

type Lesson = { x: number[] | null; x1: number[] | null; y: number };

/** Experience replay: a random slice of recent lessons, learned again at half weight. Sharpens the weights without counting as new lessons. */
async function replay(model: NanoModel) {
  const r = redis();
  const len = (await r.llen(REPLAY_KEY)) || 0;
  if (len < 200) return { replayed: 0 };
  const off = Math.floor(Math.random() * Math.max(1, len - REPLAY_PER_RUN));
  const batch = ((await r.lrange<Lesson>(REPLAY_KEY, off, off + REPLAY_PER_RUN - 1)) || []) as Lesson[];
  const m1 = M1;
  for (const l of batch) {
    if (l.x) learn(model, l.x, l.y === 1, undefined, 0.5, true);
    if (l.x1) learn(m1, l.x1, l.y === 1, undefined, 0.5, true);
  }
  const p = r.pipeline();
  p.set(K.nano, model);
  p.set(K.nano1, m1);
  p.hincrby(K.stat, "replayed", batch.length);
  await p.exec();
  return { replayed: batch.length };
}

// ---------------------------------------------------------------- hot watch (bonds in near real time)
// Reads only curve accounts plus two sorted sets, so it stays cheap even with thousands of live coins.

export async function hotWatch(model: NanoModel) {
  const r = redis();
  const total = await r.zcard(K.hot);
  if (!total) return { hot: 0 };
  const off = (await r.incrby(K.hotCur, HOT_ROT)) % total;
  const [top, rot] = await Promise.all([
    r.zrange<string[]>(K.radar, 0, HOT_TOP - 1, { rev: true }),
    r.zrange<(string | number)[]>(K.hot, off, off + HOT_ROT - 1, { withScores: true }),
  ]);
  const born: Record<string, number> = {};
  for (let i = 0; i < (rot || []).length; i += 2) born[String(rot[i])] = Number(rot[i + 1]);
  const mints = Array.from(new Set([...(top || []), ...Object.keys(born)]));
  const curves = await getCurves(mints);
  const now = Date.now();
  if (SOL_USD) for (const m of mints) if (curves[m] && !curves[m]!.complete) CURVE_USD[m] = curves[m]!.mcapSol * SOL_USD;

  const radarAdds: { score: number; member: string }[] = [];
  const gone: string[] = [];
  const bondedMints: string[] = [];
  const nearMints: string[] = [];
  for (const m of mints) {
    const cv = curves[m];
    if (!cv) continue;
    if (cv.complete) {
      bondedMints.push(m);
      continue;
    }
    const age = born[m] ? now - born[m] : null;
    if (age != null && (age > 24 * 3600_000 || (age > 30 * 60_000 && cv.progress < HOT_MIN))) {
      gone.push(m);
      continue;
    }
    radarAdds.push({ score: cv.progress, member: m });
    if (cv.progress >= 85) nearMints.push(m);
  }

  const c = newCtx(model);
  const p = c.p;
  if (radarAdds.length) {
    p.zadd(K.radar, radarAdds[0], ...radarAdds.slice(1));
    p.zadd(K.peak, { gt: true }, radarAdds[0], ...radarAdds.slice(1));
  }
  if (gone.length) {
    p.zrem(K.hot, ...gone);
    p.zrem(K.radar, ...gone);
    p.zrem(K.peak, ...gone);
  }

  // Only coins that just bonded or are about to need their full record.
  const newNear: string[] = [];
  for (const m of nearMints) if (await r.sadd(K.near, m)) newNear.push(m);
  if (newNear.length) await r.expire(K.near, 60 * 60 * 48);
  const need = [...bondedMints, ...newNear];
  if (need.length) {
    const recs = await r.mget<(Launch | null)[]>(...need.map((m) => K.launch(m)));
    need.forEach((m, i) => {
      const rec = recs[i];
      if (!rec) {
        p.zrem(K.hot, m);
        p.zrem(K.radar, m);
        return;
      }
      if (rec.outcome) return;
      if (bondedMints.includes(m)) {
        completed(c, rec);
      } else {
        const prog = curves[m]?.progress ?? 0;
        c.feed.push({
          kind: "near",
          rat: "RAT KING",
          mint: rec.mint,
          symbol: rec.symbol,
          name: rec.name,
          at: c.now,
          text: `about to graduate · curve ${prog}%${rec.call ? ` · called ${rec.call.verdict} ${rec.call.score}` : ""}`,
        });
      }
    });
  }
  await flush(c);
  return { hot: mints.length, bondedNow: bondedMints.length };
}
