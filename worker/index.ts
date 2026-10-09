// The always-on worker: runs the whole protocol back to back, with no gaps between minute pings, and digs a new
// pump.fun launch the moment PumpPortal announces it. Deploy it on Railway (or any always-on host) from the same
// GitHub repo with the same environment variables; start command: npm run worker. While it runs, the Vercel minute
// ping steps aside on its own (it sees the worker's heartbeat) and comes back if the worker stops.
import { runSession } from "../src/lib/session";
import { historianSession } from "../src/lib/historian";
import { deskSession } from "../src/lib/desk";
import { digFast, digSlow, ingestStream, migrateNano, streamComplete } from "../src/lib/digger";
import { flashFollow, flashLook, streamStats, FL_STAGES, type FlashLook, type FlCoin } from "../src/lib/flash";
import { K, redis } from "../src/lib/redis";
import { budgetState, curveFeed, lane, laneOpen, liveCurveOf, noteCurve, parsedTx, pruneCurves, rpcView, setCurveLive } from "../src/lib/solana";
import { swapsInFlight } from "../src/lib/exec";
import { LOG_MS, logCreate, logTrade, markFeedLive, pruneStream, setFollowHook, setQuote, streamSize, tradesFlowing, youngMints } from "../src/lib/streamlog";
import { flushRpcDay, seedRpcDay } from "../src/lib/rpcday";
import { pruneRedis } from "../src/lib/prune";
import { heliusFeed } from "../src/lib/heliusfeed";
import { reviveAllowed } from "../src/lib/revive";
import { arenaPublish } from "../src/lib/arena";
import { archiveBoard, archiveFlush, archiveInit, archivePrune, archiveTick, archiveView } from "../src/lib/archive";
import { refreshPxCache } from "../src/lib/pxcache";
import { priceOf } from "../src/lib/desk";
import { stallAlerts } from "../src/lib/alive";
import { criticalChecks, redisDown } from "../src/lib/critical";
import { markAlive, markBusy } from "../src/lib/alive";
import { catchPass, noteMigration } from "../src/lib/catcher";
import { bwTick, installBwMeter } from "../src/lib/bwmeter";
import { radarTop } from "../src/lib/lcache";
import { bwFlush, bwLevel, bwMul, bwView } from "../src/lib/bwgov";
import { drainXQueue, publishWireView } from "../src/lib/wire";
import { publishSite } from "../src/lib/site";
installBwMeter(); // v0.1.40: counts every byte sent to and from Upstash (v0.1.40: through lib/rediswire.ts)

process.env.RATNET_WORKER = "1";
const SESSION_MS = Number(process.env.WORKER_SESSION_MS || 55_000);

// Two loops, side by side:
//  - the desk: positions, exits and entries, back to back in 5-minute sessions. It never waits for the agents.
//  - the agents: rats' helpers, WIRE, LENS, MIND, HOUND, CATCH, the historian... in 55s sessions.
// Before v0.1.19 both shared one session, so the desk sat idle while the slowest agent finished (gaps of 30-90s).
// An honest heartbeat: it only beats while both loops are actually completing. A loop stuck past its limit stops
// the heartbeat (the Vercel minute ping takes over at once); stuck longer, the process exits and Railway restarts it.
const DESK_MS = Number(process.env.WORKER_DESK_MS || 300_000);
let sessionAt = Date.now();
let deskAt = Date.now();
// A restart is the only way to free a hung promise, but never in the middle of a real-money swap: the watchdog waits up
// to 3 minutes for swaps in flight to settle. Every restart is recorded with its reason (shown on /status).
let restartWanted = 0;
async function restart(why: string) {
  if (redisDown()) return console.log(`watchdog: ${why}, but Redis is down: not restarting (it would not help)`);
  if (swapsInFlight() > 0 && (!restartWanted || Date.now() - restartWanted < 180_000)) {
    restartWanted ||= Date.now();
    return console.log(`watchdog: ${why}; waiting for ${swapsInFlight()} swap(s) in flight before restarting`);
  }
  console.log(`watchdog: ${why}, restarting`, JSON.stringify(rpcView()));
  const r = redis();
  await r.lpush("rn:worker:exits", { at: Date.now(), why }).catch(() => {});
  await r.ltrim("rn:worker:exits", 0, 49).catch(() => {});
  process.exit(1);
}

// PumpPortal lag: 1 launch in 50 has its block time read (one chain call each, ~600 a day) and the gap to the moment
// the stream delivered it goes on the speed panel. The rest of the speed numbers start from that delivery time.
const LAG_EVERY = 50;
let createN = 0;
function sampleLag(sig: string, gotAt: number) {
  setTimeout(() => {
    lane
      .run(1, () => parsedTx(sig))
      .then((tx) => {
        if (!tx?.blockTime) return;
        // block times are whole seconds: the lag is rounded to the second, never below 0
        const lag = Math.max(0, Math.round((gotAt - tx.blockTime * 1000) / 1000));
        const p = redis().pipeline();
        p.lpush("rn:lat:stream", lag);
        p.ltrim("rn:lat:stream", 0, 199);
        return p.exec();
      })
      .catch(() => {});
  }, 8000);
}
let pruneAskAt = Date.now() - 25 * 60_000; // first try ~5 minutes after boot

// v0.1.40: the bandwidth governor's level changes go to the private Telegram chat
let govLevel = 0;
async function govAlert() {
  const lv = bwLevel();
  if (lv === govLevel) return;
  const was = govLevel;
  govLevel = lv;
  const v = bwView();
  console.log(`[bw] saving mode ${was} -> ${lv}: ${v.dayMB}MB today, pace ${v.paceMB}MB, allowance ${v.allowMB}MB`);
  const { tgSend, ideasChat } = await import("../src/lib/tgbot");
  const chat = ideasChat();
  if (!chat || !process.env.TELEGRAM_BOT_TOKEN) return;
  const text = lv
    ? `⚠️ <b>Redis saving mode ${lv}</b>: ${(v.dayMB / 1000).toFixed(2)}GB used today, pace ${(v.paceMB / 1000).toFixed(2)}GB (allowance ${(v.allowMB / 1000).toFixed(1)}GB a day). This hour ${v.hourMB}MB, ${v.hourRate}x the hourly allowance. Pages cache ${[1, 3, 6, 10][lv]}x longer, the historian, agents and slow lane slow down${lv >= 3 ? ", CATCH waits" : ""}. The desk keeps trading.`
    : `✅ <b>Redis back on pace</b>: ${(v.dayMB / 1000).toFixed(2)}GB today of ${(v.allowMB / 1000).toFixed(1)}GB. Normal speed again.`;
  await tgSend(chat, text).catch(() => null);
}

// v0.1.41: everything the public pages read, built here once and stored as one compressed key each (lib/site.ts):
// the desk every ~6s, /api/live every ~10s, the explorer and the agent boards every minute, WIRE every 2 minutes.
// In saving mode every interval stretches 3x or 6x.
const SITE: { name: string; every: number; at: number; busy: boolean; build: () => Promise<unknown> }[] = [
  { name: "desk", every: 6_000, at: 0, busy: false, build: async () => (await import("../src/lib/desk")).getDesk() },
  { name: "live", every: 10_000, at: 0, busy: false, build: async () => (await import("../src/lib/pages")).buildLive() },
  { name: "coins", every: 60_000, at: 0, busy: false, build: async () => (await import("../src/lib/pages")).buildCoins() },
  { name: "boards", every: 60_000, at: 0, busy: false, build: async () => (await import("../src/lib/boards")).buildBoards() },
];
let wireViewAt = 0;
async function siteTick() {
  const now = Date.now();
  const m = bwMul();
  for (const j of SITE) {
    if (j.busy || now - j.at < j.every * m) continue;
    j.busy = true;
    j.at = now;
    publishSite(j.name, j.build, 900)
      .catch((e) => console.log(`site ${j.name}`, e?.message || e))
      .finally(() => (j.busy = false));
  }
  if (now - wireViewAt > 120_000 * m) {
    wireViewAt = now;
    await publishWireView().catch((e) => console.log("site wire", e?.message || e));
  }
}
// v0.1.42: the side checks of the heartbeat (alerts, critical checks) run one at a time; with Redis slow they used to
// start again every 20 seconds while the last ones still waited
// v0.1.57 (roadmap step 5): a hung background loop (agents, rats' slow lane, historian) no longer restarts the whole
// worker. A fresh copy of that loop starts and the hung pass is left behind (it is ignored if it ever finishes), so the
// desk, the stream, the live curves and every subscription keep running. A third hang of the same loop within 30
// minutes still restarts the process (something is wrong that a fresh loop does not fix). The desk and the rats' fast
// lane still restart the process: they hold money and the King calls.
const LOOP_GEN = { agents: 0, slow: 0, hist: 0 };
const REVIVED: Record<string, number[]> = {};
function revive(name: keyof typeof LOOP_GEN, why: string, now = Date.now()) {
  const ra = reviveAllowed(REVIVED[name] || [], now);
  REVIVED[name] = ra.recent;
  if (!ra.ok) return false;
  LOOP_GEN[name]++;
  console.log(`watchdog: ${why}; restarting only that loop (the desk and the stream keep running)`);
  redis().hincrby("rn:worker:revives", name, 1).catch(() => 0);
  if (name === "agents") (sessionAt = now), agentLoop(LOOP_GEN.agents).catch(() => null);
  else if (name === "slow") (slowAt = now), digSlowLoop(LOOP_GEN.slow).catch(() => null);
  else (histAt = now), historianLoop(LOOP_GEN.hist).catch(() => null);
  return true;
}
let beatSide = false;
async function beat() {
  if (!beatSide) {
    beatSide = true;
    Promise.allSettled([stallAlerts(), criticalChecks()]).finally(() => (beatSide = false));
  }
  const stuck = Date.now() - sessionAt;
  const deskStuck = Date.now() - deskAt;
  // the process is up: the minute ping stays out (it only takes over when the worker is gone, see /api/desk/run)
  await redis().set("rn:worker:at", Date.now(), { ex: 120 }).catch(() => {});
  redis().set("rn:rpc", { at: Date.now(), ...rpcView() }, { ex: 120 }).catch(() => {});
  flushRpcDay().catch(() => {});
  bwFlush()
    .then(() => govAlert())
    .then(() => bwTick())
    .catch(() => {});
  // Redis growth: trimmed once every 6 hours (the shared key decides; this only asks every 30 minutes)
  if (Date.now() - pruneAskAt > 30 * 60_000) {
    pruneAskAt = Date.now();
    pruneRedis()
      .then((x) => x.prune !== "not due" && console.log("prune", JSON.stringify(x)))
      .catch(() => {});
  }
  if (Date.now() - fastAt > 150_000) return restart("the rats' fast lane is stuck");
  if (Date.now() - slowAt > 300_000 && !revive("slow", "the rats' slow lane is stuck")) return restart("the rats' slow lane is stuck again");
  if (Date.now() - histAt > 900_000 && !revive("hist", "the historian is stuck")) return restart("the historian is stuck again");
  if (deskStuck > DESK_MS + 180_000) return restart(`the desk loop is stuck (${Math.round(deskStuck / 1000)}s)`);
  if (stuck > SESSION_MS * 5 && !revive("agents", `the agents loop is stuck (${Math.round(stuck / 1000)}s)`)) return restart(`the agents loop is stuck again (${Math.round(stuck / 1000)}s)`);
  restartWanted = 0;
}

// PumpPortal, one connection for everything the agents need the second it happens:
//  - new launches        -> dig right away instead of waiting for the next 5s beat
//  - migrations          -> CATCH looks at the coin at once (fast migrators are decided in the first minutes)
//  - trades on the coins that matter (open positions, the hottest curves, fresh migrations) -> a live tape in Redis
//    (rn:rt) and a CATCH look the moment a buying burst starts, instead of at its next 12-second pass
type Trade = { at: number; side: "buy" | "sell"; sol: number; w: string; mc: number; fresh: boolean };
const TAPE = new Map<string, Trade[]>(); // last 60 seconds of trades per coin
const SEEN = new Map<string, Set<string>>(); // every wallet seen trading the coin since we started watching it
const LAST = new Map<string, { mc: number; at: number }>();
let watched = new Set<string>();
let lastMsgAt = Date.now();
let lastStreamMark = 0;

function onTrade(m: any, kick: () => void) {
  const mint = String(m.mint);
  const now = Date.now();
  logTrade({ mint, w: String(m.traderPublicKey || ""), buy: m.txType !== "sell", sol: Number(m.solAmount) || 0, tok: Number(m.tokenAmount) || 0, vSol: Number(m.vSolInBondingCurve) || undefined, mcSol: Number(m.marketCapSol) || undefined, pool: m.pool ? String(m.pool) : undefined });
  const w = TAPE.get(mint) || [];
  const who = String(m.traderPublicKey || "");
  const seen = SEEN.get(mint) || new Set<string>();
  const fresh = !!who && !seen.has(who);
  if (who) seen.add(who);
  SEEN.set(mint, seen);
  w.push({ at: now, side: m.txType === "sell" ? "sell" : "buy", sol: Number(m.solAmount) || 0, w: who, mc: Number(m.marketCapSol) || 0, fresh });
  while (w.length && now - w[0].at > 60_000) w.shift();
  TAPE.set(mint, w);
  if (Number(m.marketCapSol) > 0) LAST.set(mint, { mc: Number(m.marketCapSol), at: now });
  // a burst: 10+ buys from 6+ wallets and 4+ SOL net in 20 seconds
  const w20 = w.filter((x) => now - x.at <= 20_000);
  const buys = w20.filter((x) => x.side === "buy");
  const net = buys.reduce((a, x) => a + x.sol, 0) - w20.filter((x) => x.side === "sell").reduce((a, x) => a + x.sol, 0);
  if (buys.length >= 10 && new Set(buys.map((x) => x.w)).size >= 6 && net >= 4) kick();
}

const r2 = (n: number) => Math.round(n * 100) / 100;
/** The live tape CATCH and SHIELD read: 20-second burst numbers plus a 60-second picture of the flow. */
function tapeOf(w: Trade[], now: number) {
  const w20 = w.filter((x) => now - x.at <= 20_000);
  const b20 = w20.filter((x) => x.side === "buy");
  const s20 = w20.filter((x) => x.side === "sell");
  const b60 = w.filter((x) => x.side === "buy");
  const s60 = w.filter((x) => x.side === "sell");
  const sum = (xs: Trade[]) => xs.reduce((a, x) => a + x.sol, 0);
  const firstMc = w.find((x) => x.mc > 0)?.mc || 0;
  const lastMc = [...w].reverse().find((x) => x.mc > 0)?.mc || 0;
  return {
    b20: b20.length, s20: s20.length, u20: new Set(w20.map((x) => x.w)).size, bsol: r2(sum(b20)), ssol: r2(sum(s20)),
    b60: b60.length, s60: s60.length, u60: new Set(w.map((x) => x.w)).size, bsol60: r2(sum(b60)), ssol60: r2(sum(s60)),
    new60: new Set(w.filter((x) => x.fresh && x.side === "buy").map((x) => x.w)).size,
    big60: r2(Math.max(0, ...b60.map((x) => x.sol))),
    mcCh60: firstMc > 0 && lastMc > 0 ? Math.round((lastMc / firstMc - 1) * 1000) / 10 : 0,
    span: w.length ? Math.round((now - w[0].at) / 1000) : 0,
  };
}

// CATCH and SHIELD run in this process and read the tape straight from memory (v0.1.40; v0.1.41 drops the Redis copy)
(globalThis as any).__rnRt = (ms: string[]) => {
  const now = Date.now();
  const out: Record<string, unknown> = {};
  for (const m of ms) {
    const w = TAPE.get(m);
    const l = LAST.get(m);
    if (!w || !l || now - l.at > 90_000) continue;
    out[m] = { mc: l.mc, at: l.at, ...tapeOf(w, now) };
  }
  return out;
};
async function flushTape() {
  const now = Date.now();
  if (now - lastStreamMark > 10_000) {
    lastStreamMark = now;
    const quiet = Math.round((now - lastMsgAt) / 1000);
    markAlive("stream", quiet > 20 ? { error: `no message for ${quiet}s` } : { feed: FEED ? `${FEED.view().up ? "up" : "down"} ${FEED.view().addrs} accts ${FEED.view().quotes} px ${Math.round(FEED.view().perDay / 1000)}K/day${FEED.view().error ? ` err ${FEED.view().error.slice(0, 30)}` : ""}` : PP_KEY ? "pumpportal key" : "off", curves: CURVES ? `${CURVES.view().up ? "up" : "down"} ${CURVES.view().addrs} coins ${Math.round(CURVES.view().perDay / 1000)}K/day hit ${curveFeed.hits + curveFeed.misses ? Math.round((curveFeed.hits / (curveFeed.hits + curveFeed.misses)) * 100) : 0}%${CURVES.view().error ? ` err ${CURVES.view().error.slice(0, 30)}` : ""}` : "off", ppKey: PP_KEY ? 1 : 0, ...(PP_KEY ? { pp: `${watched.size} coins · ${ppCount()} trades today ~${((ppCount() / 10_000) * 0.01).toFixed(4)} SOL of ${PP_DAILY_SOL} SOL cap${ppCapped() ? " REACHED" : ""}` } : {}), lastTradeSec: streamSize().lastTradeSec ?? "never", lastMsgSec: quiet, logs: streamSize().logs, coins: TAPE.size, quotes: streamSize().quotes }).catch(() => {});
  }
  // v0.1.41: no copy of the tape in Redis any more (rn:rt). CATCH and SHIELD read it from this process's memory
  // (__rnRt); the copy was only for readers outside the worker, which only run when the worker is down.
}

/** Which coins to stream trades for: open positions, the 100 hottest curves, every migration of the last 2 hours
 *  (their pool stage too: PumpPortal streams PumpSwap trades), and whatever CATCH is watching. */
async function wantList() {
  const now = Date.now();
  // v0.1.54: without a PumpPortal key nothing is subscribed, so nothing is read (this list used to read the positions,
  // the radar, migrations and CATCH's whole watch list from Redis every 15 seconds for nothing: ~10MB an hour)
  if (!PP_KEY) {
    pruneStream(new Set(), now);
    return new Set<string>();
  }
  const want = new Set<string>();
  if (!ppCapped(now)) {
    // the shortlist: coins whose minute-1 tape was read (they passed the curve minimum), until their minute-5 call is
    // made. v0.1.56: open positions are no longer on it. A migrated MOMO coin trades thousands of times an hour (4,894
    // trades in 15 minutes on 9 Oct, the day's cap in ~1.5 hours), and the Helius feed already prices every position
    for (const [m, at] of PP_FOLLOW) {
      if (now - at > LOG_MS) PP_FOLLOW.delete(m);
      else want.add(m);
    }
  } else PP_FOLLOW.clear();
  pruneStream(want, now);
  return want;
}

// v0.1.54: the PumpPortal trade stream is paid per trade (0.01 SOL per 10,000). It follows the shortlist only, and a
// daily cap (PP_DAILY_SOL, default 0.03 SOL, about 30,000 trades) stops it for the rest of the UTC day.
const PP_FOLLOW = new Map<string, number>();
let PP_NUDGE: () => void = () => {};
const PP_DAILY_SOL = Math.max(0, Number(process.env.PP_DAILY_SOL ?? 0.03));
const PP_CAP_TRADES = Math.floor((PP_DAILY_SOL / 0.01) * 10_000);
const ppDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const PP_COUNT = { day: ppDay(), n: 0, flushed: 0 };
function ppCount(now = Date.now()) {
  if (PP_COUNT.day !== ppDay(now)) Object.assign(PP_COUNT, { day: ppDay(now), n: 0, flushed: 0 });
  return PP_COUNT.n;
}
const ppCapped = (now = Date.now()) => ppCount(now) >= PP_CAP_TRADES;
async function ppFlush() {
  ppCount();
  const add = PP_COUNT.n - PP_COUNT.flushed;
  if (add <= 0) return;
  PP_COUNT.flushed = PP_COUNT.n;
  await redis().incrby(`rn:pp:trades:${PP_COUNT.day}`, add).catch(() => null);
  await redis().expire(`rn:pp:trades:${PP_COUNT.day}`, 3 * 86400).catch(() => null);
}
async function ppSeed() {
  const n = Number((await redis().get(`rn:pp:trades:${ppDay()}`).catch(() => 0)) || 0);
  if (n > PP_COUNT.n) Object.assign(PP_COUNT, { day: ppDay(), n, flushed: n });
}

/**
 * What the Helius feed follows (v0.1.34): open positions only, real and ghost. Following launches and their trades
 * (v0.1.32-33) cost 1.3M to 5.7M credits a day against a plan share of ~300K. A position is followed through its curve
 * account, or its pool's two vaults once migrated: a few hundred bytes per change.
 */
async function feedWant() {
  const r = redis();
  const [pos, ghosts] = await Promise.all([r.hkeys(K.deskPos).catch(() => [] as string[]), r.hkeys("rn:ghost:pos").catch(() => [] as string[])]);
  return new Set([...(pos || []), ...(ghosts || [])].map(String).filter(Boolean));
}

// FLASH: every new launch is streamed for its first ~100 seconds and read at 15s, 45s and 90s, from the trades
// alone (no chain reads). The create message also goes straight to the rats (dug ~1 second after birth).
const FLW = new Map<string, FlCoin>();
let INTAKE: any[] = [];

let flashPausedAt = 0;
const FLASH_ALL = false; // v0.1.54: on only if every launch's trades are streamed from birth
function flashTick() {
  const now = Date.now();
  // FLASH reads the first seconds from trade messages alone. Without a PumpPortal key there are none (v0.1.34: the
  // Helius feed follows positions only), and a launch with no trades would read as dead and be learned as dead.
  // v0.1.54: FLASH needs every launch's trades from birth. The trade stream follows a shortlist only (paid per trade),
  // so FLASH stays paused: a launch without its trades would read as dead and be learned as dead
  if (!tradesFlowing(now) || !FLASH_ALL) {
    FLW.clear();
    if (now - flashPausedAt > 30_000) {
      flashPausedAt = now;
      markAlive("flash", { paused: PP_KEY ? "trades are streamed for the shortlist only, not every launch from birth" : "no stream trades (PumpPortal trades need a key)" }).catch(() => {});
    }
    return;
  }
  const looks: FlashLook[] = [];
  for (const [mint, c] of FLW) {
    for (const st of FL_STAGES) {
      if (c.done.includes(st) || now - c.t0 < st * 1000) continue;
      c.done.push(st);
      looks.push({ mint, stage: st, at: now, createdAt: c.t0, sym: c.sym, st: streamStats(c, now) });
    }
    if (now - c.t0 > 100_000) FLW.delete(mint);
  }
  if (looks.length) flashLook(looks).then((r) => markAlive("flash", r)).catch((e) => (console.log("flash error", e?.message || e), markAlive("flash", { error: String(e?.message || e) })));
}

// v0.1.42: one intake batch at a time. Every 300ms a new batch used to start even while the last was still waiting on
// a slow gateway or Redis, and the batches piled up behind each other; now new launches wait in INTAKE and go together.
let intakeBusy = false;
async function flushIntake() {
  if (intakeBusy || !INTAKE.length) return;
  intakeBusy = true;
  const items = INTAKE;
  INTAKE = [];
  try {
    await ingestStream(items).catch((e) => console.log("intake error", e?.message || e));
  } finally {
    intakeBusy = false;
  }
}

let noteAt = 0;
const PP_KEY = process.env.PUMPPORTAL_API_KEY || "";
// every trade, from PumpPortal (with a key) or the Helius feed, goes through here
let TRADE_IN: (msg: any) => void = () => {};
let FEED: ReturnType<typeof heliusFeed> | null = null;
// v0.1.53: the live curve stream for every launch in its first 7 minutes (the minute-1 read and the minute-5 call).
// Its own socket, so the positions' feed never waits behind 400+ launch subscriptions.
let CURVES: ReturnType<typeof heliusFeed> | null = null;
// every curve update goes to the rats' memory and (sampled, every 10s per coin) to the archive (v0.1.55)
const onCurveUpd = (mint: string, v: Parameters<typeof noteCurve>[1]) => {
  noteCurve(mint, v);
  archiveTick(mint, v);
};
const CURVE_MAX = Math.max(50, Number(process.env.CURVE_FEED_MAX || 800));
const SHAPES = new Map<string, number>();
let shapesAt = 0;
function noteShape(msg: any) {
  const k = `${String(msg.txType ?? msg.type ?? "-")}|${Object.keys(msg).sort().slice(0, 24).join(",")}`.slice(0, 300);
  SHAPES.set(k, (SHAPES.get(k) || 0) + 1);
  if (SHAPES.size > 50) SHAPES.delete(SHAPES.keys().next().value as string);
  if (Date.now() - shapesAt > 60_000) {
    shapesAt = Date.now();
    redis().set("rn:stream:shapes", { at: shapesAt, shapes: Array.from(SHAPES.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12) }, { ex: 3600 }).catch(() => null);
  }
}
function pumpportal() {
  const WS: any = (globalThis as any).WebSocket;
  if (!WS) return console.log("no WebSocket in this Node version: launches are found by polling (Node 22+ recommended)");
  let lastCatch = 0;
  let ws: any = null;
  let up = false;
  const kick = () => {
    // v0.1.40: 10s (was 3s); each pass reads ~240 coins. v0.1.40: no bursts while the day's Redis bandwidth runs
    // ahead of pace (lib/bwgov.ts); the regular passes still run
    if (Date.now() - lastCatch < 10_000 || bwLevel() >= 1) return;
    lastCatch = Date.now();
    lane.run(2, () => catchPass(true)).catch(() => null);
  };
  TRADE_IN = (msg: any) => {
    ppCount();
    PP_COUNT.n++;
    const tx = String(msg.txType || "").toLowerCase();
    const fc = FLW.get(String(msg.mint));
    if (fc) {
      fc.trades.push({ t: Date.now(), side: tx as "buy" | "sell", sol: Number(msg.solAmount) || 0, w: String(msg.traderPublicKey || "") });
      if (Number(msg.vSolInBondingCurve) > 0) fc.vSol = Number(msg.vSolInBondingCurve);
      if (Number(msg.vTokensInBondingCurve) > 0) fc.vTok = Number(msg.vTokensInBondingCurve);
      if (Number(msg.marketCapSol) > 0) fc.mcSol = Number(msg.marketCapSol);
    }
    return onTrade(msg, kick);
  };
  const resync = async () => {
    if (!up) return;
    const want = await wantList();
    const add = [...want].filter((k) => !watched.has(k));
    const drop = [...watched].filter((k) => !want.has(k));
    // PumpPortal streams trades only with a funded key (since Oct 2026); without one the Helius feed brings them
    if (add.length && PP_KEY) ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: add }));
    if (drop.length) {
      if (PP_KEY) ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: drop }));
      drop.forEach((k) => (TAPE.delete(k), LAST.delete(k), SEEN.delete(k)));
    }
    watched = want;
  };
  let nudgeT: ReturnType<typeof setTimeout> | null = null;
  PP_NUDGE = () => {
    if (!nudgeT) nudgeT = setTimeout(() => ((nudgeT = null), resync().catch(() => null)), 250);
  };
  // v0.1.42: one live socket at a time. Each open() gets a generation number; an older socket's events are ignored and
  // a pending reconnect is cleared when the watchdog opens a fresh socket (the two used to race into two sockets,
  // every launch and trade arriving twice)
  let gen = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const open = () => {
    if (retry) clearTimeout(retry);
    retry = null;
    const my = ++gen;
    // PUMPPORTAL_API_KEY (optional): PumpPortal's keyed data stream, for when the free stream stops sending trades
    const sock = new WS(`wss://pumpportal.fun/api/data${PP_KEY ? `?api-key=${encodeURIComponent(PP_KEY)}` : ""}`);
    ws = sock;
    sock.onopen = () => {
      if (my !== gen) {
        try {
          sock.close();
        } catch {}
        return;
      }
      up = true;
      watched = new Set();
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      resync().catch(() => null);
      console.log("pumpportal: launches, migrations and live trades");
    };
    sock.onmessage = (ev: any) => {
      if (my !== gen) return;
      lastMsgAt = Date.now();
      let msg: any = null;
      try {
        msg = JSON.parse(String(ev?.data || ""));
      } catch {}
      if (!msg?.mint) {
        // PumpPortal's own notices (errors, limits, "needs a key"): kept for /status so a silent stream gets a reason
        const note = String(msg?.message || msg?.error || msg?.errors || "").replace(/api-key=\S+/gi, "").slice(0, 160);
        if (note && Date.now() - noteAt > 60_000) {
          noteAt = Date.now();
          console.log("pumpportal says:", note);
          redis().set("rn:stream:note", { at: noteAt, text: note }, { ex: 86400 }).catch(() => null);
        }
        return;
      }
      // message shapes, for /status: if PumpPortal changes its format, the field names show up there (no values kept)
      noteShape(msg);
      const tx = String(msg.txType || msg.type || "").toLowerCase();
      if (tx === "migrate" || tx === "migration") {
        noteMigration(String(msg.mint)).catch(() => null);
        streamComplete(String(msg.mint)).catch(() => null);
        kick();
        return;
      }
      if (tx === "buy" || tx === "sell") return TRADE_IN(msg);
      // a new launch: to the rats now (batched every 300ms), and onto FLASH's first-seconds watch
      // pump.fun launches only: PumpPortal also streams other launchpads (pool "bonk"...), which have no pump.fun
      // curve and used to be dug, resolved as dead and counted in the base rate
      if ((tx === "create" || (!tx && msg.uri && msg.name)) && (!msg.pool || msg.pool === "pump")) {
        const now = Date.now();
        const mint = String(msg.mint);
        INTAKE.push({ mint, sig: String(msg.signature || msg.sig || msg.txSignature || ""), creator: String(msg.traderPublicKey || ""), name: String(msg.name || "").slice(0, 64), symbol: String(msg.symbol || "").slice(0, 16), uri: String(msg.uri || ""), devBuySol: Math.round((Number(msg.solAmount) || 0) * 100) / 100, createdAt: now });
        logCreate(mint, String(msg.traderPublicKey || ""), now, Number(msg.solAmount) || 0, Number(msg.initialBuy ?? msg.tokenAmount) || 0);
        FLW.set(mint, { t0: now, mint, sym: String(msg.symbol || ""), creator: String(msg.traderPublicKey || ""), devSol: Number(msg.solAmount) || 0, vSol: Number(msg.vSolInBondingCurve) || 30, vTok: Number(msg.vTokensInBondingCurve) || 0, mcSol: Number(msg.marketCapSol) || 0, trades: [], done: [] });
        FEED?.nudge();
        CURVES?.nudge();
        if (++createN % LAG_EVERY === 0 && msg.signature) sampleLag(String(msg.signature), now);
      }
    };
    // reconnect once per drop, 3s later (errors are always followed by a close)
    sock.onclose = () => {
      if (my !== gen) return; // an old socket closing: the new one is already up
      up = false;
      if (!retry) retry = setTimeout(open, 3000);
    };
    sock.onerror = () => {};
  };
  open();
  // a socket can die without ever closing (half-open): pump.fun launches every few seconds, so 30s of silence means
  // the stream is dead. Close it and open a fresh one (before v0.1.25 FLASH, intake and the live tape just stopped
  // while /status stayed green)
  setInterval(() => {
    const quiet = Date.now() - lastMsgAt;
    if (quiet < 30_000) return;
    console.log(`pumpportal: no message for ${Math.round(quiet / 1000)}s, reconnecting`);
    lastMsgAt = Date.now();
    redis().incr("rn:stream:reconnects").catch(() => 0);
    up = false;
    const old = ws;
    open(); // the new generation first, so the old socket's close is ignored
    try {
      old.close();
    } catch {}
  }, 5_000);
  setInterval(() => resync().catch(() => null), 15_000);
  setInterval(() => flushTape().catch(() => null), 1_000);
  setInterval(() => flushIntake().catch(() => null), 300);
  setInterval(flashTick, 500);
}

async function deskLoop() {
  for (;;) {
    const t0 = Date.now();
    deskAt = t0;
    try {
      const r: any = await deskSession(DESK_MS); // the rats dig in their own lanes below
      await markAlive("desk", r);
      if (r?.skipped) await new Promise((res) => setTimeout(res, 2000)); // another desk holds the lock: wait for it
      else console.log(new Date().toISOString(), `desk ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(r).slice(0, 200));
    } catch (e: any) {
      console.log("desk error", e?.message || e);
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
}

// The rats, in two lanes of their own. Fast (about every second): launches the stream missed, WIRE picks, and the
// minute-1 reads and minute-5 calls the moment they are due. Slow (every ~4 seconds): the hot curves re-read,
// migrations, lessons, runners. Before v0.1.21 one combined pass ran every few minutes and fell ~12 minutes behind.
// One pass at a time per lane. Before v0.1.24 a pass that ran past 45s was left running while the loop started the
// next one: passes piled up on the same RPC lane, each made the others slower, and the slow lane starved for minutes.
// Now the loop waits for its pass (it reports "still running" while it waits); a pass stuck past its limit restarts
// the worker (the watchdog above), which is the only way to free a hung promise.
let fastAt = Date.now();
let slowAt = Date.now();
let histAt = Date.now();
async function waitFor<T>(name: string, p: Promise<T>, warnMs: number) {
  const t0 = Date.now();
  let done = false;
  const tick = setInterval(() => {
    if (!done) markBusy(name, Math.round((Date.now() - t0) / 1000)).catch(() => {});
  }, warnMs);
  try {
    return await p;
  } finally {
    done = true;
    clearInterval(tick);
  }
}
async function digFastLoop() {
  for (;;) {
    const t0 = Date.now();
    fastAt = t0;
    const r: any = await waitFor("rats_fast", digFast().catch((e) => ({ error: e?.message || e })), 20_000);
    await markAlive("rats_fast", r);
    if (r?.error || (r?.dug && Math.random() < 0.05) || Date.now() - t0 > 10_000) console.log(new Date().toISOString(), "dig fast", `${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(r).slice(0, 200));
    await new Promise((res) => setTimeout(res, Math.max(150, 1000 - (Date.now() - t0))));
  }
}
async function digSlowLoop(my = LOOP_GEN.slow) {
  let n = 0;
  for (;;) {
    if (my !== LOOP_GEN.slow) return;
    const t0 = Date.now();
    slowAt = t0;
    const r: any = await waitFor("rats_slow", digSlow().catch((e) => ({ error: e?.message || e })), 30_000);
    const f: any = await flashFollow().catch((e) => ({ flashError: e?.message || e }));
    await markAlive("rats_slow", { ...r, ...(f?.flashError ? { flashError: f.flashError } : {}) });
    if (n++ % 15 === 0 || r?.error || Date.now() - t0 > 30_000) console.log(new Date().toISOString(), "dig slow", `${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify({ ...r, ...f }).slice(0, 300));
    // v0.1.40: every ~4s, or every 12s / 30s in Redis saving mode 1 / 2
    await new Promise((res) => setTimeout(res, Math.max(500, [4000, 12_000, 30_000, 60_000][bwLevel()] - (Date.now() - t0))));
  }
}

// The historian replays the past around the clock in its own loop (it used to get 45 seconds of each agents'
// session and nothing in between). Its RPC lane only takes what the desk and the rats leave free.
async function historianLoop(my = LOOP_GEN.hist) {
  let n = 0;
  for (;;) {
    if (my !== LOOP_GEN.hist) return;
    const t0 = Date.now();
    histAt = t0;
    // waited for, never raced: a session left running in the background used to overlap the next one once its lock
    // expired (two historians on one lane, both slower)
    // v0.1.40: the historian is the first to wait when the day's Redis bandwidth runs ahead of pace
    if (bwLevel() >= 2) {
      await markAlive("historian", { paused: "Redis bandwidth saving mode" }).catch(() => {});
      await new Promise((res) => setTimeout(res, 60_000));
      continue;
    }
    const r: any = await waitFor("historian", historianSession(110_000).catch((e) => ({ history: "error", error: e?.message || e })), 180_000);
    if (bwLevel() === 1) await new Promise((res) => setTimeout(res, 60_000));
    await markAlive("historian", r);
    if (n++ % 5 === 0 || r?.error) console.log(new Date().toISOString(), "historian", `${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(r).slice(0, 240));
    // nothing to do (done, off, busy, waiting): look again in a few seconds instead of spinning
    if (Date.now() - t0 < 3000) await new Promise((res) => setTimeout(res, 5000));
  }
}

async function agentLoop(my = LOOP_GEN.agents) {
  for (;;) {
    if (my !== LOOP_GEN.agents) return; // a newer copy of this loop took over (see revive)
    const t0 = Date.now();
    sessionAt = t0;
    try {
      const r: any = await runSession(SESSION_MS, { desk: false, historian: false });
      // v0.1.40: in Redis saving mode the agents rest between sessions (30s, 2 minutes in mode 2, 5 minutes in mode 3).
      // v0.1.44: the rest beats the heartbeat every 20s and ends early when the mode drops. A 5-minute rest used to
      // look like a stuck loop to the watchdog (limit 275s): on 8 Oct mode 3 restarted the worker every 5 minutes, and
      // every restart re-read its caches, which kept the bandwidth in mode 3
      const lvl = bwLevel();
      if (lvl) {
        const until = Date.now() + [0, 30_000, 120_000, 300_000][lvl];
        while (Date.now() < until && bwLevel() >= lvl) {
          sessionAt = Date.now();
          await new Promise((res) => setTimeout(res, Math.min(20_000, Math.max(0, until - Date.now()))));
        }
      }
      console.log(new Date().toISOString(), `session ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify({ momo: r?.momo, mind: r?.mind, lens: r?.lens, catch: r?.catch, hound: r?.hound, overseer: r?.overseer }).slice(0, 500));
    } catch (e: any) {
      console.log("session error", e?.message || e);
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}

// a stray rejection or exception is logged and counted, never a silent crash
process.on("unhandledRejection", (e: any) => {
  console.log("unhandled rejection", e?.message || e);
  redis().hincrby("rn:worker:errs", "rejection", 1).catch(() => 0);
});
process.on("uncaughtException", (e: any) => {
  console.log("uncaught exception", e?.message || e);
  redis().hincrby("rn:worker:errs", "exception", 1).catch(() => 0);
});

async function main() {
  await redis().incr("rn:worker:boots").catch(() => 0);
  await redis().set("rn:worker:bootAt", Date.now()).catch(() => null);
  await seedRpcDay().catch(() => null);
  // v0.1.41: the epoch check first. On an empty database it wipes the models, so the warm start must come after it
  // (on 8 Oct it ran the other way round and the historian's queue was wiped twice)
  const { ensureEpoch } = await import("../src/lib/epoch");
  await ensureEpoch().catch(() => null);
  // King v1.1: nano moves to the v2 learner once (warm start on recent lessons); a no-op afterwards
  console.log("nano", JSON.stringify(await migrateNano().catch((e) => ({ nano: "error", error: String(e?.message || e) }))));
  console.log(`RATNET worker up · desk in ${DESK_MS / 1000}s sessions, agents in ${SESSION_MS / 1000}s sessions, rats in a 1s fast lane and a 4s slow lane, launches from the stream`);
  pumpportal();
  // trades for every followed coin from Helius (no PumpPortal key needed): the same handler as PumpPortal's trades
  // live prices of open positions from Helius account updates (with a PumpPortal key, its trades price them instead)
  // v0.1.54: the positions' Helius feed always runs (with a PumpPortal key it used to be switched off and positions
  // waited for PumpPortal trades); the trade stream now only adds who traded
  FEED = heliusFeed({ want: feedWant, onQuote: (q) => setQuote(q), onCurve: onCurveUpd, log: (x) => console.log(x) });
  setInterval(() => FEED && markFeedLive(FEED.live()), 1_000);
  if (PP_KEY) {
    await ppSeed().catch(() => null);
    // v0.1.58: only coins already moving fast at minute 1 (curve PP_MIN_CURVE%+, default 15). With every coin past the
    // 5% tape floor the shortlist held ~37 coins and used the day's 0.03 SOL in about 2 hours
    const PP_MIN_CURVE = Number(process.env.PP_MIN_CURVE ?? 15);
    setFollowHook((m) => {
      if (ppCapped()) return false;
      if ((liveCurveOf(m)?.progress ?? 0) < PP_MIN_CURVE) return false;
      PP_FOLLOW.set(m, Date.now());
      PP_NUDGE();
      return true;
    });
    setInterval(() => ppFlush().catch(() => null), 60_000);
  }
  CURVES = heliusFeed({ want: async () => new Set(youngMints().slice(-CURVE_MAX)), onQuote: () => {}, onCurve: onCurveUpd, max: CURVE_MAX, label: "live curves of every launch (first 7 minutes)", log: (x) => console.log(x) });
  setCurveLive(() => {
    const a = CURVES?.live() || new Set<string>();
    for (const m of FEED?.live() || []) a.add(m);
    return a;
  });
  setInterval(() => pruneCurves(), 5_000);
  // v0.1.58: ARENA's summary for the site, once a minute (only when it changed)
  setInterval(() => arenaPublish().catch(() => null), 60_000);
  // v0.1.55: the archive (Railway Postgres). Without DATABASE_URL all of this does nothing
  // v0.1.56: a failed first connect (the database still starting, a network blip) is retried every minute
  const startArchive = async () => {
    if (!(await archiveInit())) {
      if (process.env.DATABASE_URL) {
        console.log("archive: not connected, retrying in 60s:", archiveView().error);
        setTimeout(() => startArchive().catch(() => null), 60_000);
      }
      return;
    }
    console.log("archive: connected, tables ready");
    setInterval(() => archiveFlush().catch(() => null), 5_000);
    const board = async () => {
      const b = await archiveBoard().catch(() => null);
      if (b) await redis().set("rn:archive:board", b, { ex: 86400 }).catch(() => null);
    };
    setTimeout(board, 20_000);
    setInterval(board, 5 * 60_000);
    setInterval(() => archivePrune().catch(() => null), 6 * 3600_000);
  };
  await startArchive().catch(() => null);
  setInterval(() => {
    const v = archiveView();
    markAlive("archive", !v.on ? { off: "DATABASE_URL not set" } : !v.ready ? { error: v.error || "not connected" } : { launches: v.written.launches, ticks: v.written.ticks, trades: v.written.trades, trips: v.written.trips, queued: v.queued, fails: v.fails, ...(v.lastError ? { last: v.lastError.slice(0, 60).replace(/,/g, ";") } : {}) }).catch(() => {});
  }, 30_000);
  // live prices for the site's pages (/api/px reads them): what viewers asked for, every 4s, on the agents' lane
  let pxBusy = false;
  let pxAt = 0;
  setInterval(() => {
    if (pxBusy || !laneOpen(2) || Date.now() - pxAt < 4_000 * bwMul()) return;
    pxAt = Date.now();
    pxBusy = true;
    lane
      .run(2, () => refreshPxCache((ms) => priceOf(ms, false, 8_000) as any))
      .catch(() => null)
      .finally(() => (pxBusy = false));
  }, 4_000);
  setInterval(beat, 20_000);
  // X webhook posts the site queued (v0.1.40): ingested here, where WIRE's account list is in memory
  let xqBusy = false;
  setInterval(() => {
    if (xqBusy) return;
    xqBusy = true;
    drainXQueue()
      .catch((e) => console.log("x queue", e?.message || e))
      .finally(() => (xqBusy = false));
  }, 1_500);
  setInterval(() => siteTick().catch(() => null), 2_000);
  // v0.1.46: the Telegram webhook follows TG_HOOK_SECRET by itself
  const tgHook = () => import("../src/lib/tgbot").then((m) => m.ensureHook()).then((x) => x.tg !== "unchanged" && console.log("tg hook", x.tg)).catch(() => null);
  tgHook();
  setInterval(tgHook, 10 * 60_000);
  await beat();
  await Promise.all([deskLoop(), agentLoop(), digFastLoop(), digSlowLoop(), historianLoop()]);
}
main();
