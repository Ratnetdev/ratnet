import { PublicKey } from "@solana/web3.js";
import { CALL_MAX_AGE_MS, CHECKPOINTS, PUMP_MINT_AUTHORITY } from "@/config/site";
import { K, dayKey, hourKey, redis } from "./redis";
import { conn, fetchOffchain, getCurves, parseCreateTx, pmap, safeErr } from "./solana";
import { score, Verdict, KING_VERSION, verdictOf } from "./king";
import { assignWork, recordWork } from "./rats";
import { getSettings } from "./settings";
import { emptyModel, features, learn, NanoModel, nanoScore, NANO_MIN } from "./nano";

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
  outcome?: Outcome;
  resolvedAt?: number;
  bondSecs?: number;
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
};

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
};

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
const MAX_DUE_PER_RUN = 300;
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
  nanoLog: { n: number; loss: number; acc: number; pos: number; at: number }[];
};

function newCtx(model: NanoModel): Ctx {
  return { p: redis().pipeline(), now: Date.now(), feed: [], stat: {}, model, modelDirty: false, nanoLog: [] };
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
  for (const l of c.nanoLog) p.rpush(K.nanoLog, l);
  if (c.nanoLog.length) p.ltrim(K.nanoLog, -500, -1);
  await p.exec();
}

export async function loadModel(): Promise<NanoModel> {
  const m = await redis().get<NanoModel>(K.nano);
  return m && Array.isArray(m.w) ? m : emptyModel();
}

export async function dig(): Promise<Record<string, unknown>> {
  const r = redis();
  const got = await r.set(K.digLock, Date.now(), { nx: true, ex: 40 });
  if (!got) return { skipped: "busy" };
  const started = Date.now();
  try {
    const model = await loadModel();
    const dug = await digNew(model);
    const due = await processDue(model);
    const hot = await hotWatch(model);
    return { ok: true, ...dug, ...due, ...hot, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: safeErr(e) };
  } finally {
    // Hold the lock a few seconds after each run so many open pages can't hammer the RPC.
    await r.set(K.digLock, Date.now(), { ex: 5 });
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
      resolve(c, rec, "BONDED");
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
  p.hincrby(K.day(dayKey()), "dug", launches.length);
  p.expire(K.day(dayKey()), 60 * 60 * 24 * 40);
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

function resolve(c: Ctx, rec: Launch, outcome: Outcome) {
  const p = c.p;
  rec.outcome = outcome;
  rec.resolvedAt = c.now;
  inc(c, "resolved");
  inc(c, outcome.toLowerCase());

  if (outcome === "BONDED") {
    rec.bondSecs = Math.max(0, Math.round((c.now - rec.createdAt) / 1000));
    rec.peak = 100;
    rec.pNow = 100;
    if (rec.creator) p.hincrby(K.devB, rec.creator, 1);
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
    };
    p.lpush(K.grads, g);
    p.ltrim(K.grads, 0, 299);
    const said = rec.call ? ` · king said ${rec.call.verdict} ${rec.call.score}${rec.call.nano ? ` · nano ${rec.call.nano.score}` : ""}` : " · bonded before the call";
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
    p.lpush(K.callRes, call);
    p.ltrim(K.callRes, 0, 199);
    if (call.x?.length) {
      learn(c.model, call.x, outcome === "BONDED");
      c.modelDirty = true;
      if (c.model.n % 25 === 0)
        c.nanoLog.push({ n: c.model.n, loss: round4(c.model.loss), acc: round4(c.model.acc), pos: c.model.pos, at: c.now });
    }
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

export async function processDue(model: NanoModel) {
  const r = redis();
  const now = Date.now();
  const members = (await r.zrange<string[]>(K.due, 0, now, { byScore: true, offset: 0, count: MAX_DUE_PER_RUN })) || [];
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
  const s = await getSettings();
  const work = await assignWork(items.length, s);
  const c = newCtx(model);
  const p = c.p;
  const last: Record<string, unknown> = {};
  const touched = new Set<string>();
  const hotAdds: { score: number; member: string }[] = [];
  const radarAdds: { score: number; member: string }[] = [];

  const order: Record<Stage, number> = { t5: 0, h1: 1, d1: 2 };
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

    if (cv?.complete) {
      resolve(c, rec, "BONDED");
      touched.delete(it.mint);
      return;
    }

    if (it.stage === "t5" && !rec.call) {
      makeCall(c, rec, cp.p);
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

function makeCall(c: Ctx, rec: Launch, curveNow: number) {
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
  });
  const x = features({
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
  });
  const nano =
    c.model.n >= NANO_MIN
      ? (() => {
          const ns = nanoScore(c.model, x);
          return { score: ns, verdict: verdictOf(ns) };
        })()
      : null;
  const counted = c.now - rec.createdAt <= CALL_MAX_AGE_MS;
  rec.call = {
    mint: rec.mint,
    symbol: rec.symbol,
    name: rec.name,
    image: rec.image,
    createdAt: rec.createdAt,
    at: c.now,
    score: sc.score,
    verdict: sc.verdict,
    counted,
    progress: curveNow,
    version: KING_VERSION,
    nano,
    x,
    outcome: null,
  };
  c.p.set(K.call(rec.mint), rec.call, { ex: CALL_TTL });
  c.p.zadd(K.calls, { score: rec.createdAt, member: rec.mint });
  inc(c, "calls");
  if (counted) {
    inc(c, `${sc.verdict.toLowerCase()}_n`);
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
    text: `${sc.verdict} ${sc.score}/100${nano ? ` · nano ${nano.verdict} ${nano.score}` : ""} · curve ${curveNow}%${counted ? "" : " · late, not counted"}`,
  });
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
        resolve(c, rec, "BONDED");
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
