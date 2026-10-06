import { PublicKey } from "@solana/web3.js";
import { CALL_MAX_AGE_MS, CHECKPOINTS, PUMP_MINT_AUTHORITY } from "@/config/site";
import { K, dayKey, hourKey, redis } from "./redis";
import { conn, fetchOffchain, getCurves, parseCreateTx, pmap, safeErr } from "./solana";
import { score, Verdict, KING_VERSION } from "./king";
import { assignWork, recordWork } from "./rats";
import { getSettings } from "./settings";

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
  dugAt: number;
  dugBy: string;
  p0: number;
  mcap0: number;
  cp: Partial<Record<Stage, Cp>>;
  call?: Call;
  outcome?: Outcome;
  resolvedAt?: number;
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
  parts: Record<string, number>;
  outcome: Outcome | null;
};

export type FeedItem = {
  kind: "dig" | Stage | "call" | "resolve";
  rat: string;
  mint: string;
  symbol: string;
  name: string;
  at: number;
  text: string;
};

const LAUNCH_TTL = 60 * 60 * 30;
const MAX_TX_PER_RUN = 60;
const MAX_DUE_PER_RUN = 300;

export async function dig(): Promise<Record<string, unknown>> {
  const r = redis();
  const got = await r.set(K.digLock, Date.now(), { nx: true, ex: 25 });
  if (!got) return { skipped: "busy" };
  const started = Date.now();
  try {
    const dug = await digNew();
    const due = await processDue();
    return { ok: true, ...dug, ...due, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: safeErr(e) };
  } finally {
    // Hold the lock a few seconds after each run so many open pages can't hammer the RPC.
    await r.set(K.digLock, Date.now(), { ex: 6 });
  }
}

async function digNew() {
  const r = redis();
  const s = await getSettings();
  const cursor = (await r.get<string>(K.cursor)) || undefined;
  const raw = await conn().getSignaturesForAddress(new PublicKey(PUMP_MINT_AUTHORITY), {
    until: cursor,
    limit: cursor ? 1000 : 25,
  });
  if (!raw.length) return { dug: 0 };
  if (cursor && raw.length >= 1000) await r.hincrby(K.stat, "gaps", 1);

  const oldestFirst = [...raw].reverse();
  const batch = oldestFirst.slice(0, MAX_TX_PER_RUN);
  const newCursor = batch[batch.length - 1].signature;
  const ok = batch.filter((x) => !x.err);

  const txs = await pmap(ok, 8, async (x) => {
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

  const [off, curves] = await Promise.all([
    pmap(launches, 8, (l) => fetchOffchain(l.uri, 2000)),
    getCurves(launches.map((l) => l.mint)),
  ]);
  const work = await assignWork(launches.length, s);
  const now = Date.now();
  const p = r.pipeline();
  const feed: FeedItem[] = [];
  const last: Record<string, unknown> = {};
  let bondedAtDig = 0;

  launches.forEach((l, i) => {
    const o = off[i];
    const c = curves[l.mint];
    const rec: Launch = {
      ...l,
      image: o?.image || "",
      description: o?.description || "",
      twitter: o?.twitter || "",
      telegram: o?.telegram || "",
      website: o?.website || "",
      dugAt: now,
      dugBy: work.names[i],
      p0: c?.progress ?? 0,
      mcap0: c?.mcapSol ?? 0,
      cp: {},
    };
    const socials = [rec.twitter && "x", rec.telegram && "tg", rec.website && "web"].filter(Boolean).join(" ");
    feed.push({
      kind: "dig",
      rat: work.names[i],
      mint: l.mint,
      symbol: l.symbol,
      name: l.name,
      at: now,
      text: `dev ${l.devBuySol}◎ · curve ${rec.p0}%${socials ? " · " + socials : ""}`,
    });
    last[work.names[i]] = { mint: l.mint, symbol: l.symbol, at: now, kind: "dig" };

    if (c?.complete) {
      rec.outcome = "BONDED";
      rec.resolvedAt = now;
      bondedAtDig++;
      p.rpush(K.resolvedHour(hourKey(l.createdAt)), compactRow(rec));
      p.expire(K.resolvedHour(hourKey(l.createdAt)), 60 * 60 * 24 * 4);
      p.set(K.launch(l.mint), rec, { ex: 60 * 60 * 2 });
    } else {
      p.set(K.launch(l.mint), rec, { ex: LAUNCH_TTL });
      (Object.keys(CHECKPOINTS) as Stage[]).forEach((st) => {
        const at = Math.max(l.createdAt + CHECKPOINTS[st], now + 1000);
        p.zadd(K.due, { score: at, member: `${l.mint}|${st}` });
      });
    }
  });

  for (const f of feed) p.lpush(K.feed, f);
  p.ltrim(K.feed, 0, 299);
  p.hincrby(K.stat, "dug", launches.length);
  if (bondedAtDig) {
    p.hincrby(K.stat, "resolved", bondedAtDig);
    p.hincrby(K.stat, "bonded", bondedAtDig);
  }
  p.hincrby(K.day(dayKey()), "dug", launches.length);
  p.expire(K.day(dayKey()), 60 * 60 * 24 * 40);
  p.set(K.cursor, newCursor);
  await p.exec();
  await recordWork(work.counts, last, work.real);
  return { dug: launches.length, scanned: batch.length, behind: raw.length - batch.length };
}

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
    dev_buy_sol: l.devBuySol,
    curve_at_dig: l.p0,
    curve_5m: l.cp.t5?.p ?? null,
    curve_1h: l.cp.h1?.p ?? null,
    curve_24h: l.cp.d1?.p ?? null,
    mcap_sol_5m: l.cp.t5?.mcap ?? null,
    mcap_sol_1h: l.cp.h1?.mcap ?? null,
    king_score: l.call?.score ?? null,
    king_verdict: l.call?.verdict ?? null,
    king_counted: l.call?.counted ?? null,
    outcome: l.outcome,
  };
}

export async function processDue() {
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
  const curves = await getCurves(Object.keys(recs));
  const s = await getSettings();
  const work = await assignWork(items.length, s);

  const p = r.pipeline();
  const feed: FeedItem[] = [];
  const last: Record<string, unknown> = {};
  const touched = new Set<string>();
  const stat: Record<string, number> = {};
  const inc = (k: string, n = 1) => (stat[k] = (stat[k] || 0) + n);
  const removeAll = new Set<string>();

  // Process stages in time order per mint.
  const order: Record<Stage, number> = { t5: 0, h1: 1, d1: 2 };
  items.sort((a, b) => order[a.stage] - order[b.stage]);

  items.forEach((it, i) => {
    const rec = recs[it.mint];
    const rat = work.names[i];
    if (!rec || rec.outcome) {
      removeAll.add(it.mint);
      return;
    }
    const c = curves[it.mint];
    const cp: Cp = { p: c?.progress ?? rec.cp.h1?.p ?? rec.cp.t5?.p ?? rec.p0, mcap: c?.mcapSol ?? 0, at: now };
    rec.cp[it.stage] = cp;
    touched.add(it.mint);
    last[rat] = { mint: rec.mint, symbol: rec.symbol, at: now, kind: it.stage };

    if (c?.complete) {
      resolve(rec, "BONDED");
      return;
    }

    if (it.stage === "t5" && !rec.call) {
      const sc = score({
        progress: cp.p,
        progress0: rec.p0,
        twitter: !!rec.twitter,
        telegram: !!rec.telegram,
        website: !!rec.website,
        description: rec.description,
        symbol: rec.symbol,
        name: rec.name,
        devBuySol: rec.devBuySol,
      });
      const counted = now - rec.createdAt <= CALL_MAX_AGE_MS;
      rec.call = {
        mint: rec.mint,
        symbol: rec.symbol,
        name: rec.name,
        image: rec.image,
        createdAt: rec.createdAt,
        at: now,
        score: sc.score,
        verdict: sc.verdict,
        counted,
        progress: cp.p,
        version: KING_VERSION,
        parts: sc.parts,
        outcome: null,
      };
      p.set(K.call(rec.mint), rec.call, { ex: 60 * 60 * 24 * 8 });
      p.zadd(K.calls, { score: rec.createdAt, member: rec.mint });
      inc("calls");
      if (counted) {
        inc(`${sc.verdict.toLowerCase()}_n`);
        p.hincrby(K.day(dayKey()), "calls", 1);
      } else inc("calls_late");
      feed.push({
        kind: "call",
        rat: "RAT KING",
        mint: rec.mint,
        symbol: rec.symbol,
        name: rec.name,
        at: now,
        text: `${sc.verdict} ${sc.score}/100 · curve ${cp.p}%${counted ? "" : " · late, not counted"}`,
      });
    } else if (it.stage === "h1") {
      feed.push({ kind: "h1", rat, mint: rec.mint, symbol: rec.symbol, name: rec.name, at: now, text: `1h sniff · curve ${cp.p}%` });
    } else if (it.stage === "d1") {
      resolve(rec, cp.p < 5 ? "DIED" : "ALIVE");
    }
  });

  function resolve(rec: Launch, outcome: Outcome) {
    rec.outcome = outcome;
    rec.resolvedAt = now;
    removeAll.add(rec.mint);
    inc("resolved");
    inc(outcome.toLowerCase());
    if (outcome === "BONDED") {
      p.hincrby(K.day(dayKey()), "bonded", 1);
    }
    if (rec.call) {
      rec.call.outcome = outcome;
      p.set(K.call(rec.mint), rec.call, { ex: 60 * 60 * 24 * 8 });
      if (rec.call.counted) {
        const v = rec.call.verdict.toLowerCase();
        inc(`${v}_res`);
        if (rec.call.verdict === "BOND" && outcome === "BONDED") inc("bond_hit");
        if (rec.call.verdict === "DUST" && outcome !== "BONDED") inc("dust_hit");
        if (rec.call.verdict === "WATCH" && outcome === "BONDED") inc("watch_bonded");
      }
      p.lpush(K.callRes, rec.call);
    }
    p.rpush(K.resolvedHour(hourKey(rec.createdAt)), compactRow(rec));
    p.expire(K.resolvedHour(hourKey(rec.createdAt)), 60 * 60 * 24 * 4);
    feed.push({
      kind: "resolve",
      rat: "LEDGER",
      mint: rec.mint,
      symbol: rec.symbol,
      name: rec.name,
      at: now,
      text: `${outcome}${rec.call ? ` · king said ${rec.call.verdict} ${rec.call.score}` : ""}`,
    });
  }

  for (const m of touched) {
    const rec = recs[m];
    p.set(K.launch(m), rec, { ex: rec.outcome ? 60 * 60 * 2 : LAUNCH_TTL });
  }
  const rem = new Set(members);
  for (const m of removeAll) (Object.keys(CHECKPOINTS) as Stage[]).forEach((st) => rem.add(`${m}|${st}`));
  p.zrem(K.due, ...Array.from(rem));
  for (const [k, v] of Object.entries(stat)) p.hincrby(K.stat, k, v);
  for (const f of feed) p.lpush(K.feed, f);
  p.ltrim(K.feed, 0, 299);
  p.ltrim(K.callRes, 0, 199);
  p.zremrangebyrank(K.calls, 0, -5001);
  await p.exec();
  await recordWork(work.counts, last, work.real);
  return { checked: items.length };
}
