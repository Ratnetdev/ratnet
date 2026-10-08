// HOUND: the wallet book. One agent maps every wallet worth watching, in three books, and tells the others the
// moment one of them buys.
//
//  1. FOMO traders (fomoapi.io): every trader on the leaderboard is profiled from their own closed trades: win rate,
//     average win, average loss, expected value per trade, best trade. Only two kinds get tracked:
//       home-run hitters: low win rate, but a history of huge single wins and a positive EV
//       steady hands:     high win rate, smaller wins, positive EV
//     Everyone else is left out, so the book only holds traders worth copying.
//  2. KOL wallets: from public KOL rosters and from the admin. A wallet only counts as CONFIRMED when the proof is
//     objective: the person's own X account posted the address, or the wallet carries their X handle in the on-chain
//     SNS registry, or two independent rosters agree. Otherwise it is shown as unconfirmed. The name is always shown.
//  3. Smart wallets, found on chain: every coin that breaks out past $500K is dug up. Wallets that bought big before
//     the run get credit (size, how early, the multiple since). Wallets that do it again and again, and are not
//     spray-everything bots, join the book.
//
// Live: every tracked wallet is on one Helius webhook. A buy lands here within seconds: the feed shows who bought
// what and how much, MIND gets the coin when several tracked wallets pile in (or one strong one), and every buy is
// followed 1h, 6h and 24h later, so each wallet and each class gets a copy-trade record of its own. MIND and RISK
// see those records; nothing is followed blindly.
import { createHash } from "crypto";
import { getLaunch, getLaunches, putLaunch } from "./launches";
import { postTo } from "./board";
import { memo } from "./memo";
import { safeEq, secretFor } from "./admin";
import { K, redis } from "./redis";
import { SITE } from "@/config/site";
import { agentLog } from "./agents";
import { bondingCurvePda, getCurves, pmap, solUsd } from "./solana";
import { readPools } from "./pool";
import { oldestSigs } from "./historian";
import { parseTrade } from "./tape";
import { conn, parsedTxsAny } from "./solana";
import { enqueueMind } from "./mind";
import { enqueueLens } from "./lens";
import { GK } from "./graph";
import { xOn } from "./wire";
import { xCost, xSpend } from "./xcredits";

const W = "rn:hd:w"; // wallet -> Wallet
const FEED = "rn:hd:feed"; // latest buys
const M = (m: string) => `rn:hd:m:${m}`; // mint -> wallet -> buy
const EV = "rn:hd:ev"; // {w}:n|s|x2 and c:{cls}:n|s|x2 (copy-trade record at 6h)
// v0.1.40: this hash holds a row for every wallet that ever bought and was read whole (100-300KB) for every coin CATCH
// looked at, thousands of times an hour: the main cause of the 8 Oct Upstash bandwidth outage. It is a slow-moving
// stats table, so each process reads it at most once a minute.
// v0.1.40: 5 minutes (was 1): copy results move slowly and the hash is large
const evAll = () => memo("hound:ev", 300_000, async () => ((await redis().hgetall<Record<string, number>>(EV)) || {}) as Record<string, number>);
const DUE = "rn:hd:due";
const BUY = "rn:hd:b"; // id -> pending follow
const BQ = "rn:hd:bq"; // breakouts to dig
const SB = "rn:hd:sb"; // wallet -> breakout record
export const HOOK = "rn:hd:hook"; // { id, n, at }
const DIRTY = "rn:hd:dirty";
const FOMO_AT = "rn:hd:fomoAt";
const KOL_AT = "rn:hd:kolAt";
const FOMO_P = "rn:hd:fp"; // handle -> profile (7 days)
const LIVE = "rn:hd:live"; // what HOUND is doing right now
export const STATUS = "rn:hd:status"; // the last run of each source: what came back, what got added, the error if any
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type Cls = "fomo-homerun" | "fomo-steady" | "fomo-top" | "kol" | "smart" | "admin";
export type Wallet = {
  w: string;
  cls: Cls;
  name: string;
  handle?: string | null;
  conf: "confirmed" | "likely" | "unconfirmed";
  proof: string[];
  src: string[];
  stats?: { n: number; wr: number; avgWin: number; avgLoss: number; ev: number; best: number; big: number } | null;
  sb?: { n: number; sol: number; best: number } | null;
  at: number;
  off?: boolean;
  checkedAt?: number;
};
export type Buy = { id: string; w: string; name: string; cls: Cls; conf: string; mint: string; symbol: string; sol: number; at: number; sig: string; side: "buy" | "sell" };

export const CLASS_LABEL: Record<Cls, string> = { "fomo-homerun": "FOMO home-run", "fomo-steady": "FOMO steady", "fomo-top": "FOMO top trader", kol: "KOL", smart: "smart wallet", admin: "added by admin" };

const isAddr = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || "");
const r2 = (n: number) => Math.round(n * 100) / 100;

async function live(text: string) {
  await redis().set(LIVE, { at: Date.now(), text }, { ex: 600 }).catch(() => {});
}

export async function book(): Promise<Record<string, Wallet>> {
  return ((await redis().hgetall<Record<string, Wallet>>(W)) || {}) as Record<string, Wallet>;
}

async function status(src: string, v: Record<string, unknown>) {
  await redis().hset(STATUS, { [src]: { at: Date.now(), ...v } }).catch(() => {});
}

async function upsert(list: Wallet[]) {
  if (!list.length) return;
  const r = redis();
  const have = await book();
  const obj: Record<string, Wallet> = {};
  for (const x of list) {
    const old = have[x.w];
    // the admin's word wins; otherwise merge proof and sources
    if (old?.cls === "admin" && x.cls !== "admin") continue;
    obj[x.w] = old ? { ...old, ...x, proof: Array.from(new Set([...(old.proof || []), ...x.proof])), src: Array.from(new Set([...(old.src || []), ...x.src])), off: old.off } : x;
  }
  if (!Object.keys(obj).length) return;
  await r.hset(W, obj);
  await r.set(DIRTY, 1);
}

// ---------------------------------------------------------------- 1. FOMO traders

const FOMO = "https://api.fomoapi.io";
const fomoOn = () => !!process.env.FOMO_API_KEY;
let fomoErr: string | null = null;
async function fomo<T = any>(path: string): Promise<T | null> {
  const r = await fetch(`${FOMO}${path}`, { headers: { authorization: `Bearer ${process.env.FOMO_API_KEY}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) }).catch((e) => ({ ok: false, status: 0, e }) as any);
  if (!r?.ok) {
    fomoErr = r?.status === 402 ? "out of FOMO API credits (402)" : r?.status === 401 ? "FOMO API key rejected (401)" : `FOMO API answered ${r?.status || "nothing"} on ${path.split("?")[0]}`;
    return null;
  }
  return (await r.json().catch(() => null)) as T | null;
}

/** Profile one trader from their closed trades. Exported for the sim. */
export function profileOf(trades: { realizedPnlUsd: number; costBasisUsd: number; status: string }[]) {
  const closed = trades.filter((t) => t.status === "closed" && t.costBasisUsd > 1);
  const rets = closed.map((t) => t.realizedPnlUsd / t.costBasisUsd);
  const wins = rets.filter((x) => x > 0);
  const losses = rets.filter((x) => x <= 0);
  const n = rets.length;
  const wr = n ? wins.length / n : 0;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  const ev = wr * avgWin + (1 - wr) * avgLoss;
  return { n, wr: r2(wr), avgWin: r2(avgWin), avgLoss: r2(avgLoss), ev: r2(ev), best: r2(Math.max(0, ...rets)), big: rets.filter((x) => x >= 9).length };
}

/** Home-run hitters and steady hands, both with a positive expected value. Everyone else is not worth tracking. */
export function classify(p: ReturnType<typeof profileOf>): Cls | null {
  if (p.n < 15 || p.ev <= 0) return null;
  if (p.wr <= 0.4 && p.big >= 2 && p.avgWin >= 2) return "fomo-homerun";
  if (p.wr >= 0.6 && p.avgWin >= 0.2 && p.avgLoss >= -0.5) return "fomo-steady";
  return null;
}

async function fomoSync() {
  if (!fomoOn()) return 0;
  const r = redis();
  if (Date.now() - Number((await r.get(FOMO_AT)) || 0) < 6 * 3600_000) return 0;
  await r.set(FOMO_AT, Date.now());
  fomoErr = null;
  await live("reading the FOMO leaderboards (30 days, all time, 7 days)");
  const seen = new Map<string, any>();
  const top = new Set<string>(); // top 25 by PnL on the 30-day or 7-day board
  for (const win of ["30d", "all", "7d"]) {
    const lb = await fomo<{ traders: any[] }>(`/v2/leaderboard/${win}`);
    for (const t of lb?.traders || []) {
      if (!t?.handle) continue;
      if (!seen.has(t.handle)) seen.set(t.handle, t);
      if (win !== "all" && Number(t.rank) <= 25 && Number(t.pnlUsd) > 0) top.add(t.handle);
    }
  }
  if (!seen.size) {
    // nothing came back: try again in 15 minutes instead of 6 hours
    await r.set(FOMO_AT, Date.now() - 6 * 3600_000 + 15 * 60_000);
    await status("fomo", { ok: false, error: fomoErr || "empty leaderboard" });
    return 0;
  }
  const profiles = ((await r.hgetall<Record<string, any>>(FOMO_P)) || {}) as Record<string, any>;
  const have = await book();
  // profile up to 20 traders per run that have no fresh profile (each costs one API call), top traders first
  const todo = [...seen.values()].filter((t) => !profiles[t.handle] || Date.now() - profiles[t.handle].at > 7 * 86400_000).sort((a, b) => Number(top.has(b.handle)) - Number(top.has(a.handle))).slice(0, 20);
  const add: Wallet[] = [];
  let n = 0;
  for (const t of todo) {
    await live(`profiling FOMO trader @${t.handle}: win rate, average win and loss, expected value`);
    const res = await fomo<any>(`/v2/users/${encodeURIComponent(t.userId || t.handle)}/positions?limit=200`);
    const trades = Array.isArray(res) ? res : res?.positions || res?.trades || res?.data || [];
    const p = profileOf(trades);
    const cls = classify(p);
    await r.hset(FOMO_P, { [t.handle]: { at: Date.now(), ...p, cls } });
    n++;
    const sol = t.wallets?.solana;
    if (cls && isAddr(sol)) add.push({ w: sol, cls, name: t.displayName || t.handle, handle: t.handle, conf: "confirmed", proof: ["FOMO profile wallet (fomoapi.io)"], src: ["fomo"], stats: p, at: Date.now() });
  }
  // leaderboard top 25 with a Solana wallet: tracked as "top trader" even without a full profile. HOUND keeps a copy
  // record per class, so the desk learns on its own whether following them pays
  const inAdd = new Set(add.map((x) => x.w));
  for (const h of top) {
    const t = seen.get(h);
    const sol = t?.wallets?.solana;
    if (!isAddr(sol) || inAdd.has(sol) || (have[sol] && have[sol].cls !== "fomo-top")) continue;
    const pr = profiles[h];
    add.push({ w: sol, cls: "fomo-top", name: t.displayName || h, handle: h, conf: "confirmed", proof: [`FOMO leaderboard top 25 (rank ${t.rank}, $${Math.round(Number(t.pnlUsd) || 0).toLocaleString("en-US")} PnL)`], src: ["fomo"], stats: pr && pr.n ? { n: pr.n, wr: pr.wr, avgWin: pr.avgWin, avgLoss: pr.avgLoss, ev: pr.ev, best: pr.best, big: pr.big } : null, at: Date.now() });
  }
  await upsert(add);
  await status("fomo", { ok: true, traders: seen.size, profiled: n, added: add.length, error: fomoErr });
  if (add.length) {
    const p = r.pipeline();
    agentLog(p, add.slice(0, 12).map((x) => ({ agent: "HOUND", at: Date.now(), text: x.stats ? `tracking FOMO trader ${x.name} (${CLASS_LABEL[x.cls]}): ${Math.round(x.stats.wr * 100)}% win rate, avg win +${Math.round(x.stats.avgWin * 100)}%, avg loss ${Math.round(x.stats.avgLoss * 100)}%, EV ${x.stats.ev > 0 ? "+" : ""}${Math.round(x.stats.ev * 100)}% per trade` : `tracking FOMO trader ${x.name} (${CLASS_LABEL[x.cls]})`, tone: "ok" })));
    if (add.length > 12) agentLog(p, [{ agent: "HOUND", at: Date.now(), text: `and ${add.length - 12} more FOMO traders`, tone: "ok" }]);
    await p.exec();
  }
  return n;
}

// ---------------------------------------------------------------- 2. KOL wallets

/** On-chain proof: the SNS registry links this wallet to an X handle (Bonfida's Twitter verification). */
async function snsHandle(w: string): Promise<string | null> {
  const r = await fetch(`https://sns-sdk-proxy.bonfida.workers.dev/twitter/get-handle-by-key/${w}`, { cache: "no-store" }).catch(() => null);
  const j: any = r?.ok ? await r.json().catch(() => null) : null;
  const h = typeof j?.result === "string" ? j.result : null;
  return h && /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : null;
}

/** Proof from the person: their own X account posted the address. */
async function selfPosted(handle: string, w: string): Promise<string | null> {
  if (!xOn()) return null;
  const q = encodeURIComponent(`from:${handle} ${w}`);
  const r = await fetch(`https://api.twitterapi.io/twitter/tweet/advanced_search?query=${q}&queryType=Latest`, { headers: { "X-API-Key": process.env.X_API_KEY! }, cache: "no-store" }).catch(() => null);
  const j: any = r?.ok ? await r.json().catch(() => null) : null;
  await xSpend("HOUND", xCost((j?.tweets || []).length));
  const t = (j?.tweets || []).find((x: any) => String(x.text || "").includes(w));
  return t ? t.url || `https://x.com/${handle}/status/${t.id}` : null;
}

/** Check a KOL wallet and grade the proof. */
export async function verifyKol(w: string, handle: string | null, rosters: string[]) {
  const proof: string[] = [];
  let conf: Wallet["conf"] = "unconfirmed";
  const sns = await snsHandle(w).catch(() => null);
  if (sns && handle && sns.toLowerCase() === handle.toLowerCase()) {
    proof.push(`SNS registry links the wallet to @${sns} (on-chain)`);
    conf = "confirmed";
  } else if (sns) proof.push(`SNS registry links the wallet to @${sns}`);
  if (conf !== "confirmed" && handle) {
    const url = await selfPosted(handle, w).catch(() => null);
    if (url) {
      proof.push(`@${handle} posted this address: ${url}`);
      conf = "confirmed";
    }
  }
  if (rosters.length) proof.push(`listed by ${rosters.join(" and ")}`);
  if (conf === "unconfirmed" && rosters.length >= 2) conf = "likely";
  return { conf, proof, sns };
}

async function kolSync() {
  const r = redis();
  if (Date.now() - Number((await r.get(KOL_AT)) || 0) < 3600_000) return 0;
  await r.set(KOL_AT, Date.now());
  const found = new Map<string, { name: string; handle: string | null; src: string[] }>();
  const note = (w: string, name: string, handle: string | null, src: string) => {
    if (!isAddr(w)) return;
    const cur = found.get(w) || { name, handle, src: [] };
    cur.src = Array.from(new Set([...cur.src, src]));
    cur.handle ||= handle;
    found.set(w, cur);
  };
  const handleOf = (x: any) => String(x || "").replace(/^@|https?:\/\/(www\.)?(x|twitter)\.com\//g, "").split(/[/?]/)[0] || null;
  const errs: string[] = [];
  if (process.env.MADEONSOL_API_KEY) {
    await live("reading the MadeOnSol KOL roster");
    // the roster pages at 500: read up to 2,000
    for (let off = 0; off < 2000; off += 500) {
      const res = await fetch(`https://madeonsol.com/api/v1/kol/wallets?limit=500&offset=${off}&active=true`, { headers: { authorization: `Bearer ${process.env.MADEONSOL_API_KEY}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!res?.ok) {
        if (!off) errs.push(`MadeOnSol answered ${res?.status || "nothing"}`);
        break;
      }
      const j: any = await res.json().catch(() => null);
      const list: any[] = j?.wallets || j?.data || (Array.isArray(j) ? j : []);
      for (const k of list) note(k.wallet_address || k.wallet || k.address, k.name || k.handle || "KOL", handleOf(k.twitter_url || k.twitter || k.handle), "MadeOnSol");
      if (list.length < 500) break;
    }
  }
  if (process.env.SOLANATRACKER_API_KEY) {
    await live("reading the Solana Tracker KOL roster");
    const res = await fetch("https://data.solanatracker.io/v2/pnl/leaderboard/kols", { headers: { "x-api-key": process.env.SOLANATRACKER_API_KEY }, cache: "no-store", signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res?.ok) errs.push(`Solana Tracker answered ${res?.status || "nothing"}`);
    const j: any = res?.ok ? await res.json().catch(() => null) : null;
    const list: any[] = j?.wallets || j?.data || (Array.isArray(j) ? j : []);
    for (const k of list) note(k.wallet || k.address, k.name || k.identity?.name || "KOL", handleOf(k.twitter || k.identity?.twitter), "Solana Tracker");
  }
  if (!found.size) {
    await status("kol", { ok: false, error: errs.join(", ") || "no roster returned wallets" });
    await r.set(KOL_AT, Date.now() - 3600_000 + 15 * 60_000);
    return 0;
  }
  const have = await book();
  // every roster wallet joins the book right away (two rosters agreeing = likely, one = unconfirmed); the proof
  // check (SNS registry, their own X post) upgrades up to 10 wallets an hour, so the book fills in one run
  const add: Wallet[] = [];
  for (const [w, k] of found) {
    if (have[w]) continue;
    add.push({ w, cls: "kol", name: k.name, handle: k.handle, conf: k.src.length >= 2 ? "likely" : "unconfirmed", proof: k.src.map((x) => `listed on the ${x} KOL roster`), src: k.src, at: Date.now() });
  }
  await upsert(add);
  const fresh = await book();
  const todo = [...found.entries()].filter(([w]) => fresh[w] && fresh[w].conf !== "confirmed" && !(fresh[w] as any).checkedAt).slice(0, 10);
  const checked: Wallet[] = [];
  for (const [w, k] of todo) {
    await live(`checking ${k.name}'s wallet ${w.slice(0, 4)}…${w.slice(-4)}: SNS registry, their own posts, rosters`);
    const v = await verifyKol(w, k.handle, k.src);
    checked.push({ ...fresh[w], conf: v.conf, proof: v.proof, checkedAt: Date.now() } as Wallet);
  }
  await upsert(checked);
  await status("kol", { ok: true, rosterWallets: found.size, added: add.length, verified: checked.filter((x) => x.conf === "confirmed").length, error: errs.join(", ") || null });
  if (add.length) {
    const p = r.pipeline();
    agentLog(p, [{ agent: "HOUND", at: Date.now(), text: `added ${add.length} KOL wallets from the rosters (${found.size} listed). checking their proof 10 an hour`, tone: "ok" }]);
    await p.exec();
  }
  return add.length;
}

/** Admin: add a wallet by hand (KOL or anyone worth watching), checked like any other. */
export async function addWallet(w: string, name: string, handle: string | null, proofUrl: string | null, cls: Cls = "kol") {
  if (!isAddr(w)) throw new Error("not a Solana address");
  const v = await verifyKol(w, handle, []);
  const proof = [...v.proof, ...(proofUrl ? [`admin proof: ${proofUrl}`] : []), "added by admin"];
  const conf = v.conf === "confirmed" ? "confirmed" : proofUrl ? "likely" : "unconfirmed";
  const x: Wallet = { w, cls: cls === "admin" ? "admin" : cls, name: name.slice(0, 40), handle, conf, proof, src: ["admin"], at: Date.now() };
  const r = redis();
  await r.hset(W, { [w]: x });
  await r.set(DIRTY, 1);
  return x;
}

export async function setWallet(w: string, patch: Partial<Pick<Wallet, "off" | "name" | "handle" | "cls">>) {
  const r = redis();
  const x = await r.hget<Wallet>(W, w);
  if (!x) return null;
  const y = { ...x, ...patch };
  await r.hset(W, { [w]: y });
  await r.set(DIRTY, 1);
  return y;
}

// ---------------------------------------------------------------- 3. smart wallets from breakouts

/** Dig one breakout: every buy on its curve before it bonded. Big early buyers get credit. */
async function digBreakout() {
  const r = redis();
  const top = (await r.zpopmin<string>(BQ, 1)) as any[];
  if (!top?.length) return 0;
  const [mint, createdAt, bondedAt, symbol] = String(top[0]).split("|");
  const until = Number(bondedAt) || Number(createdAt) + 6 * 3600_000;
  await live(`digging the breakout $${symbol}: every buy on its curve before it bonded`);
  const curve = bondingCurvePda(mint);
  const sigs = (await oldestSigs(curve, until, 1500).catch(() => [])).filter((s) => !s.err).slice(0, 600);
  if (!sigs.length) return 0;
  const txs: any[] = [];
  for (let i = 0; i < sigs.length; i += 100) {
    const chunk = sigs.slice(i, i + 100).map((s) => s.signature);
    const got = await parsedTxsAny(chunk);
    txs.push(...got);
  }
  const trades = txs.map((tx) => parseTrade(tx, curve, mint)).filter((t): t is NonNullable<typeof t> => !!t && t.sol > 0);
  // net SOL in per wallet and the curve fill when they first bought (earlier = lower market cap)
  let filled = 0;
  const by = new Map<string, { sol: number; fill: number; t: number }>();
  for (const t of trades.sort((a, b) => a.slot - b.slot)) {
    filled += t.sol;
    const cur = by.get(t.w) || { sol: 0, fill: filled, t: t.t };
    cur.sol += t.sol;
    by.set(t.w, cur);
  }
  const p = r.pipeline();
  const sn = ((await r.hmget<Record<string, number>>(GK.sN, ...[...by.keys()])) || {}) as Record<string, number | null>;
  const sbN = ((await r.hmget<Record<string, number>>(GK.sB, ...[...by.keys()])) || {}) as Record<string, number | null>;
  let credited = 0;
  for (const [w, x] of by) {
    if (x.sol < 1) continue; // "absurd amounts": 1+ SOL before the run
    // spray bots buy everything early; skip wallets with a long record and a base-rate hit rate
    const n = Number(sn[w] || 0);
    const b = Number(sbN[w] || 0);
    if (n >= 30 && b / n < 0.05) continue;
    const mult = Math.max(1, 85 / Math.max(1, x.fill)); // curve SOL at their entry vs ~85 SOL at bond
    const cur = ((await r.hget<{ n: number; sol: number; best: number; coins: string[] }>(SB, w)) || { n: 0, sol: 0, best: 0, coins: [] }) as any;
    if (cur.coins.includes(mint)) continue;
    cur.n++;
    cur.sol = r2(cur.sol + x.sol);
    cur.best = r2(Math.max(cur.best, mult));
    cur.coins = [...cur.coins, mint].slice(-12);
    p.hset(SB, { [w]: cur });
    credited++;
    // promote: 3+ breakouts bought big before the run, or 2 with 10x+ entries and 3+ SOL in total
    if (cur.n >= 3 || (cur.n >= 2 && cur.best >= 10 && cur.sol >= 3)) {
      const have = await r.hget<Wallet>(W, w);
      if (!have) {
        p.hset(W, { [w]: { w, cls: "smart", name: `smart ${w.slice(0, 4)}…${w.slice(-4)}`, handle: null, conf: "confirmed", proof: [`bought big before ${cur.n} breakouts (on-chain)`], src: ["breakouts"], sb: { n: cur.n, sol: cur.sol, best: cur.best }, at: Date.now() } satisfies Wallet });
        p.set(DIRTY, 1);
        agentLog(p, [{ agent: "HOUND", at: Date.now(), mint, symbol, text: `new smart wallet ${w.slice(0, 4)}…${w.slice(-4)}: bought ${cur.sol} SOL before ${cur.n} breakouts, best entry ${cur.best}x before bond`, tone: "ok" }]);
      } else if (have.cls === "smart") p.hset(W, { [w]: { ...have, sb: { n: cur.n, sol: cur.sol, best: cur.best } } });
    }
  }
  agentLog(p, [{ agent: "HOUND", at: Date.now(), mint, symbol, text: `dug the breakout $${symbol}: ${trades.length} buys before bond, ${credited} wallets put 1+ SOL in early`, tone: "info" }]);
  await p.exec();
  return 1;
}

// ---------------------------------------------------------------- live: the Helius webhook

const heliusKey = () => process.env.HELIUS_API_KEY || (process.env.HELIUS_RPC_URL || "").match(/api-key=([A-Za-z0-9-]+)/)?.[1] || "";
const hookAuth = () => secretFor("helius-hook");
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const checkHook = (req: Request) => !!hookAuth() && safeEq(req.headers.get("authorization"), hookAuth());

/** Keep one Helius webhook on every tracked wallet (only when the book changed, at most every 10 minutes). */
export async function syncHook(force = false) {
  const key = heliusKey();
  const r = redis();
  if (!key || !hookAuth()) return { hook: "off (no Helius key or HELIUS_HOOK_SECRET)" };
  const prev = await r.get<{ id: string; n: number; at: number; auth?: string }>(HOOK);
  // v0.1.46: a new HELIUS_HOOK_SECRET is pushed to Helius on its own (the webhook would otherwise keep sending the old
  // one and every swap would be refused)
  const authNow = createHash("sha256").update(hookAuth()).digest("hex").slice(0, 12);
  if (prev && prev.auth !== authNow) force = true;
  if (!force && !(await r.get(DIRTY))) return { hook: "unchanged" };
  if (!force && prev && Date.now() - prev.at < 10 * 60_000) return { hook: "waiting" };
  const addrs = Object.values(await book()).filter((x) => !x.off).map((x) => x.w).slice(0, 100_000);
  if (!addrs.length) return { hook: "no wallets yet" };
  const body = { webhookURL: `${SITE.url}/api/hound/hook`, transactionTypes: ["SWAP"], accountAddresses: addrs, webhookType: "enhanced", authHeader: hookAuth() };
  const base = "https://api.helius.xyz/v0/webhooks";
  const post = () => fetch(`${base}?api-key=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const put = (id: string) => fetch(`${base}/${id}?api-key=${key}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  // v0.1.42: no remembered id (a new database, or the key was cleared): reuse the webhook Helius already has for this
  // site's URL instead of creating a second one (two webhooks = every swap delivered and billed twice)
  let id = prev?.id || "";
  if (!id) {
    const list = await fetch(`${base}?api-key=${key}`, { cache: "no-store" }).catch(() => null);
    const hooks: any[] = list?.ok ? (((await list.json().catch(() => [])) as any[]) || []) : [];
    id = (Array.isArray(hooks) ? hooks : []).find((h) => String(h?.webhookURL || "").replace(/\/+$/, "") === body.webhookURL)?.webhookID || "";
  }
  let res = id ? await put(id) : await post();
  // v0.1.41: the remembered webhook was deleted on Helius (404/400): make a new one instead of reporting "done"
  if (id && res && (res.status === 404 || res.status === 400)) {
    id = "";
    res = await post();
  }
  const j: any = res?.ok ? await res.json().catch(() => null) : null;
  if (!res?.ok) return { hook: `failed ${res?.status ?? "no answer"}` };
  await r.set(HOOK, { id: j?.webhookID || id || "", n: addrs.length, at: Date.now(), auth: authNow });
  await r.del(DIRTY);
  return { hook: `${addrs.length} wallets live` };
}

/** Parse Helius enhanced SWAP transactions into buys and sells of tracked wallets. */
export async function onSwaps(txs: any[]) {
  const r = redis();
  const list = (Array.isArray(txs) ? txs : []).slice(0, 500); // v0.1.46: one webhook call carries at most 500 swaps
  if (!list.length) return { buys: 0 };
  const ws = Array.from(new Set(list.map((t) => t.feePayer).filter(Boolean)));
  const got = ((await r.hmget<Record<string, Wallet>>(W, ...ws)) || {}) as Record<string, Wallet | null>;
  const out: Buy[] = [];
  for (const t of list) {
    const wl = got[t.feePayer];
    if (!wl || wl.off) continue;
    const tt: any[] = t.tokenTransfers || [];
    const inTok = tt.find((x) => x.toUserAccount === t.feePayer && x.mint !== WSOL && x.mint !== USDC);
    const outTok = tt.find((x) => x.fromUserAccount === t.feePayer && x.mint !== WSOL && x.mint !== USDC);
    const nat: any[] = t.nativeTransfers || [];
    const solOut = nat.filter((x) => x.fromUserAccount === t.feePayer).reduce((a, x) => a + Number(x.amount || 0), 0) / 1e9;
    const wsolOut = tt.filter((x) => x.fromUserAccount === t.feePayer && x.mint === WSOL).reduce((a, x) => a + Number(x.tokenAmount || 0), 0);
    const side: Buy["side"] = inTok ? "buy" : "sell";
    const mint = (inTok || outTok)?.mint;
    // v0.1.46: only real Solana addresses get in (a crafted payload could otherwise put any string into keys and pages)
    if (!mint || !B58.test(String(mint)) || typeof t.signature !== "string" || t.signature.length > 100) continue;
    const sol = r2(side === "buy" ? Math.max(solOut, wsolOut) : 0);
    out.push({ id: t.signature, w: wl.w, name: wl.name, cls: wl.cls, conf: wl.conf, mint, symbol: "", sol, at: (t.timestamp || Date.now() / 1000) * 1000, sig: t.signature, side });
  }
  if (!out.length) return { buys: 0 };
  const recs = ((await getLaunches(out.map((b) => b.mint))) || []) as any[];
  out.forEach((b, i) => (b.symbol = recs[i]?.symbol || ""));
  const p = r.pipeline();
  const hot = new Set<string>();
  for (const b of out) {
    p.lpush(FEED, b);
    if (b.side !== "buy") continue;
    p.hset(M(b.mint), { [b.w]: { at: b.at, sol: b.sol, name: b.name, cls: b.cls, conf: b.conf } });
    p.expire(M(b.mint), 3 * 86400);
    // follow every buy: what would copying it have made?
    p.hset(BUY, { [b.id]: { ...b, px0: null } });
    p.zadd(DUE, { score: Date.now() + 60_000, member: b.id });
    hot.add(b.mint);
    // BOARD: a tracked wallet buying is HOUND's view on the coin (stronger for classes with a proven edge)
    // the BOARD is public: smart and admin-class wallets appear without their names
    postTo(p, b.mint, { a: "HOUND", at: b.at, s: b.cls === "smart" || b.cls === "fomo-homerun" ? 0.9 : b.conf === "confirmed" ? 0.7 : 0.5, t: `${b.cls === "smart" || b.cls === "admin" ? "a tracked wallet" : b.name} (${CLASS_LABEL[b.cls as keyof typeof CLASS_LABEL] || b.cls}) bought ${b.sol} SOL`, sym: b.symbol });
  }
  p.ltrim(FEED, 0, 199);
  await p.exec();
  // confluence: 2+ tracked wallets in 30 minutes, or one strong one (confirmed KOL with a positive copy record, a
  // FOMO home-run hitter, a smart wallet), sends the coin to LENS and MIND
  const kolS = Number((await r.hget<number>(EV, "c:kol:s").catch(() => 0)) || 0);
  for (const mint of hot) {
    const buyers = Object.values(((await r.hgetall<Record<string, any>>(M(mint))) || {}) as Record<string, any>).filter((x) => Date.now() - x.at < 30 * 60_000);
    const strong = buyers.some((x) => x.cls === "fomo-homerun" || x.cls === "smart" || (x.cls === "kol" && x.conf === "confirmed" && kolS >= 0));
    if (buyers.length >= 2 || strong) {
      const q = r.pipeline();
      enqueueLens(q, mint, "wire");
      enqueueMind(q, mint, "wallets");
      await q.exec();
    }
  }
  return { buys: out.filter((b) => b.side === "buy").length };
}

// ---------------------------------------------------------------- copy-trade records

/** Prices in SOL. `failed` holds the mints whose read failed (RPC or DexScreener down): unknown, not worthless. */
export async function copyPrices(mints: string[]) {
  const out: Record<string, number> = {};
  const failed = new Set<string>();
  if (!mints.length) return { px: out, failed };
  let curves: Record<string, any> = {};
  let curvesOk = true;
  try {
    curves = (await getCurves(mints)) as Record<string, any>;
  } catch {
    curvesOk = false;
  }
  const done = mints.filter((m) => !curves[m] || curves[m]!.complete);
  let pools: Record<string, any> = {};
  let poolsOk = true;
  if (done.length) {
    try {
      pools = (await readPools(done)) as Record<string, any>;
    } catch {
      poolsOk = false;
    }
  }
  const rest: string[] = [];
  for (const m of mints) {
    const c = curves[m];
    if (c && !c.complete && c.priceSol > 0) out[m] = c.priceSol;
    else if (pools[m]?.px) out[m] = pools[m].px;
    else if (!curvesOk || !poolsOk) failed.add(m);
    else rest.push(m);
  }
  // not a pump.fun coin: DexScreener's biggest pair
  for (let i = 0; i < rest.length; i += 30) {
    const part = rest.slice(i, i + 30);
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${part.join(",")}`, { cache: "no-store" }).catch(() => null);
    const pairs: any[] | null = res?.ok ? ((await res.json().catch(() => null)) as any[] | null) : null;
    if (!Array.isArray(pairs)) {
      for (const m of part) failed.add(m);
      continue;
    }
    const best: Record<string, any> = {};
    for (const pr of pairs) {
      const m = pr?.baseToken?.address;
      if (m && (!best[m] || (pr.liquidity?.usd || 0) > (best[m].liquidity?.usd || 0))) best[m] = pr;
    }
    for (const [m, pr] of Object.entries(best)) if (Number(pr.priceNative) > 0) out[m] = Number(pr.priceNative);
  }
  return { px: out, failed };
}

async function follow() {
  const r = redis();
  const ids = ((await r.zrange<string[]>(DUE, 0, Date.now(), { byScore: true, offset: 0, count: 80 })) || []).map(String);
  if (!ids.length) return 0;
  const got = ((await r.hmget<Record<string, any>>(BUY, ...ids)) || {}) as Record<string, any>;
  const items = ids.map((i) => got[i]).filter(Boolean);
  const { px, failed } = await copyPrices(Array.from(new Set(items.map((b) => b.mint))));
  const p = r.pipeline();
  for (const i of ids) p.zrem(DUE, i);
  for (const b of items) {
    const now = px[b.mint];
    // v0.1.42: a failed price read is tried again in 10 minutes (6 times at most), never scored as a -95% loss
    if (!now && failed.has(b.mint)) {
      b.tries = (b.tries || 0) + 1;
      if (b.tries > 6) p.hdel(BUY, b.id);
      else {
        p.hset(BUY, { [b.id]: b });
        p.zadd(DUE, { score: Date.now() + 10 * 60_000, member: b.id });
      }
      continue;
    }
    if (b.px0 == null) {
      // first look a minute after the buy sets the copy price (what we could have bought at)
      if (!now) {
        p.hdel(BUY, b.id);
        continue;
      }
      b.px0 = now;
      b.step = 0;
      p.hset(BUY, { [b.id]: b });
      p.zadd(DUE, { score: b.at + 3600_000, member: b.id });
      continue;
    }
    const ret = now ? Math.log(Math.max(1e-12, now) / b.px0) : Math.log(0.05);
    const hk = ["1h", "6h", "24h"][b.step];
    for (const key of [b.w, `c:${b.cls}`]) {
      p.hincrby(EV, `${key}:${hk}:n`, 1);
      p.hincrbyfloat(EV, `${key}:${hk}:s`, Math.max(-3, Math.min(5, ret)));
      if (ret >= Math.log(2)) p.hincrby(EV, `${key}:${hk}:x2`, 1);
    }
    b.step++;
    b.tries = 0;
    if (b.step < 3) {
      p.hset(BUY, { [b.id]: b });
      p.zadd(DUE, { score: b.at + [3600_000, 6 * 3600_000, 24 * 3600_000][b.step], member: b.id });
    } else p.hdel(BUY, b.id);
  }
  await p.exec();
  return items.length;
}

const avgOf = (ev: Record<string, number>, key: string, hk: string) => {
  const n = Number(ev[`${key}:${hk}:n`] || 0);
  return { n, avg: n ? Math.round((Math.exp(Number(ev[`${key}:${hk}:s`] || 0) / n) - 1) * 1000) / 10 : null, x2: Number(ev[`${key}:${hk}:x2`] || 0) };
};

/** Who among the tracked wallets bought this coin, with their copy records (for MIND, VET and the coin page). */
export async function buyersOf(mint: string) {
  const r = redis();
  const m = await r.hgetall<Record<string, any>>(M(mint));
  if (!m || !Object.keys(m).length) return []; // no tracked wallet bought it: nothing to look up
  const E = await evAll();
  return Object.entries((m || {}) as Record<string, any>)
    .map(([w, x]) => ({ w, ...x, copy6h: avgOf(E, w, "6h"), class6h: avgOf(E, `c:${x.cls}`, "6h") }))
    .sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------- session and views

/** Admin "fill now": run the FOMO and KOL syncs right away (ignoring their timers), then push the webhook. */
export async function houndRefill() {
  const r = redis();
  await r.del(FOMO_AT, KOL_AT);
  const fomo = await fomoSync().catch((e) => `error ${e?.message || e}`);
  const kol = await kolSync().catch((e) => `error ${e?.message || e}`);
  const hook = await syncHook(true).catch((e) => ({ hook: `error ${e?.message || e}` }));
  const st = ((await r.hgetall<Record<string, any>>(STATUS)) || {}) as Record<string, any>;
  return { fomo, kol, hook, status: st, wallets: Number((await redis().hlen(W)) || 0) };
}

export async function houndSession() {
  const out: Record<string, unknown> = {};
  out.fomo = await fomoSync().catch((e) => `error ${e?.message || e}`);
  out.kol = await kolSync().catch((e) => `error ${e?.message || e}`);
  out.breakouts = await digBreakout().catch((e) => `error ${e?.message || e}`);
  out.followed = await follow().catch(() => 0);
  Object.assign(out, await syncHook().catch((e) => ({ hook: `error ${e?.message || e}` })));
  return out;
}

export async function houndView(full: boolean) {
  const r = redis();
  const [feed, ws, ev, hook, lv, q, stt] = await Promise.all([r.lrange<Buy>(FEED, 0, 39), memo("hound:book", 300_000, book), evAll(), r.get<any>(HOOK), r.get<any>(LIVE), r.zcard(BQ), r.hgetall<Record<string, any>>(STATUS)]);
  const E = (ev || {}) as Record<string, number>;
  const all = Object.values(ws);
  const counts = { total: all.length, fomo: all.filter((x) => x.cls.startsWith("fomo")).length, kol: all.filter((x) => x.cls === "kol").length, kolConfirmed: all.filter((x) => x.cls === "kol" && x.conf === "confirmed").length, smart: all.filter((x) => x.cls === "smart").length, admin: all.filter((x) => x.cls === "admin").length };
  const classes = (["fomo-homerun", "fomo-steady", "fomo-top", "kol", "smart", "admin"] as Cls[]).map((c) => ({ cls: c, label: CLASS_LABEL[c], h1: avgOf(E, `c:${c}`, "1h"), h6: avgOf(E, `c:${c}`, "6h"), h24: avgOf(E, `c:${c}`, "24h") }));
  // public: names of KOLs and FOMO traders are public anyway; smart wallets stay anonymous and addresses are hidden.
  // v0.1.46: wallets you added yourself (admin class) are hidden the same way: they can trace back to you
  const anon = (c: string) => c === "smart" || c === "admin";
  const show = (b: Buy) => (full ? b : { ...b, w: anon(b.cls) ? "" : b.w, name: anon(b.cls) ? (b.cls === "smart" ? "smart wallet" : "tracked wallet") : b.name });
  return {
    live: lv || null,
    hook: hook ? { n: hook.n, at: hook.at } : null,
    breakoutsQueued: q || 0,
    // what each source returned on its last run (counts and errors only, no keys)
    status: stt || {},
    counts,
    classes,
    feed: ((feed || []) as Buy[]).map(show),
    wallets: full ? all.map((x) => ({ ...x, copy6h: avgOf(E, x.w, "6h") })).sort((a, b) => (b.copy6h.n || 0) - (a.copy6h.n || 0)) : undefined,
    sources: { fomo: fomoOn(), madeonsol: !!process.env.MADEONSOL_API_KEY, solanatracker: !!process.env.SOLANATRACKER_API_KEY, helius: !!heliusKey(), x: xOn() },
  };
}
