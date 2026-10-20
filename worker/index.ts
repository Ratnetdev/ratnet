// The always-on worker: runs the whole protocol back to back, with no gaps between minute pings, and digs a new
// pump.fun launch the moment PumpPortal announces it. Deploy it on Railway (or any always-on host) from the same
// GitHub repo with the same environment variables; start command: npm run worker. While it runs, the Vercel minute
// ping steps aside on its own (it sees the worker's heartbeat) and comes back if the worker stops.
import { dailyReview, liveGapAlert } from "../src/lib/review";
import { LIVE_FEE, loadLiveFees } from "../src/lib/livecost";
import { senderStats } from "../src/lib/exec";
import { runSession } from "../src/lib/session";
import { historianSession } from "../src/lib/historian";
import { deskSession } from "../src/lib/desk";
import { FAST_STEP, INTAKE_STEP, DIGGING_MS, digFast, digSlow, ingestStream, markSigsSeen, migrateNano, setCallHook, streamComplete } from "../src/lib/digger";
import { flashFollow, flashLook, streamStats, FL_STAGES, type FlashLook, type FlCoin } from "../src/lib/flash";
import { K, redis } from "../src/lib/redis";
import { budgetState, curveFeed, curveFire, followedLonger, lane, laneOpen, liveCurveOf, noteCurve, parsedTx, pruneCurves, rpcView, setCurveLive } from "../src/lib/solana";
import { swapsInFlight } from "../src/lib/exec";
import { LOG_MS, logCreate, logTrade, logsGap, noteOtherQuote, markFeedLive, pruneStream, setFollowHook, setQuote, streamSize, tradesFlowing, youngMints } from "../src/lib/streamlog";
import { flushRpcDay, seedRpcDay } from "../src/lib/rpcday";
import { pruneRedis } from "../src/lib/prune";
import { heliusFeed } from "../src/lib/heliusfeed";
import { reviveAllowed } from "../src/lib/revive";
import { loopLag, startLoopLag } from "../src/lib/looplag";
import { tapeStats } from "../src/lib/tape";
import { arenaPublish, arenaRecentTrips } from "../src/lib/arena";
import { regimeTick } from "../src/lib/regimegate";
import { archiveBoard, archiveEarlyGrid, archiveFlush, archiveGrid, archiveGridTrips, archiveInit, archivePoolTick, archiveRunTick, runTrack, runTracked, loadRunTrack, archivePrune, archiveReplay, archiveTick, archiveView } from "../src/lib/archive";
import { refreshPxCache, refreshPxFast } from "../src/lib/pxcache";
import { classBoot, priceOf } from "../src/lib/desk";
import { gateStats, gateView } from "../src/lib/classgate";
import { stallAlerts } from "../src/lib/alive";
import { criticalChecks, criticalSend, redisDown } from "../src/lib/critical";
import { gridHistory, gridMessage, liveCandidates, setProfitModel, setScoreModel, setWinModel, withSeen, type GCoin, type GHist, type GridView } from "../src/lib/grid";
import { EARLY_CHECKS, earlyCoin, earlyCreate, earlyCurve, earlyPool, earlyStats, earlySweep } from "../src/lib/early";
import { gridLiveCall, gridLiveCurve, gridLiveLoad, gridLivePublish, gridLiveQuote, gridLiveSetBooks, gridLiveSweep, gridLiveSymbol, gridLiveTend, setGridFollow } from "../src/lib/gridlive";
import { poolFire, readPools } from "../src/lib/pool";
import { afterLoad, afterNoteMigration, afterResolve, afterStats, afterWant, migratedAt } from "../src/lib/after";
import { markAlive, markBusy } from "../src/lib/alive";
import { catchPass, noteMigration } from "../src/lib/catcher";
import { bwTick, installBwMeter } from "../src/lib/bwmeter";
import { radarTop } from "../src/lib/lcache";
import { bwFlush, bwLevel, bwMul, bwView } from "../src/lib/bwgov";
import { drainXQueue, publishWireView } from "../src/lib/wire";
import { publishSite } from "../src/lib/site";
import { fireLive, fireStats, startFirehose } from "../src/lib/firehose";
import { walletComplete, walletCreate, walletSweep, walletTrade, walletsLoad, walletsSave, walletsView } from "../src/lib/wallets";
import { flowFeatures, flowSweep, kolCount, setKols, tapeCreate, tapeFeatures, tapeSize, tapeSweep, tapeTrade } from "../src/lib/tapeall";
import { book } from "../src/lib/hound";
import { fomoLearn, fomoLoad, fomoNew, fomoSetKnown, fomoTx, fomoView, fomoHot } from "../src/lib/fomotap";
import { earnDump, earnLoad, earnStats, earnTrade, earnView } from "../src/lib/earners";
import { crewEdges, crewLoad, crewView } from "../src/lib/crews";
import { smartFeatures, smartStats, smartTrade } from "../src/lib/smartbuy";
import { setTapeExtra, solUsdNow } from "../src/lib/digger";
import { archivePool } from "../src/lib/archive";
import { duneBackfill, duneState } from "../src/lib/dune";
import { RESEARCH_EVERY_MS, researchPass } from "../src/lib/researcher";
import { fcPrice, fcSize } from "../src/lib/firecache";
import { setLiveFeatures, gridLiveSeer, setFlowFeatures, gridLiveRelabel, gridLiveSignals, setAnySignals, gridLiveEarly, gridLiveEarlyBooks, setEarlyModels, gridLiveTick, GAP_LIMIT, gridLiveBackfill, setEntryFeatures } from "../src/lib/gridlive";
import { seerLoad, seerSee, seerTick } from "../src/lib/seer";
import { trendAt, trendLoad, trendStats, trendTick } from "../src/lib/trend";
import { tickCreate, tickCurve, tickLoad, tickRun, tickSave, tickStats, tickView } from "../src/lib/tick";
import { originAt, originCreated, originLoad, originMc, originSee, originStats } from "../src/lib/origin";
import { dxDrain, dxLive, dxPoll, dxStats } from "../src/lib/attention";
import { setOnLabel, themeAt, themeBond, themeDrain, themeLoad, themeStats } from "../src/lib/theme";

// v0.1.102 SEER: a launch whose name or ticker matches a coin SEER saw coming (an event, a trend, a big post) goes to the
// SEER GRID LIVE books at once. Both launch feeds call this; each coin fires once.
const SEER_FIRED = new Set<string>();
function seerOn(mint: string, name: string, symbol: string, at: number) {
  if (!mint || SEER_FIRED.has(mint)) return;
  const m = seerSee(mint, name, symbol, at);
  if (!m) return;
  SEER_FIRED.add(mint);
  if (SEER_FIRED.size > 20_000) SEER_FIRED.delete(SEER_FIRED.values().next().value as string);
  console.log(`SEER match ${symbol} (${name}) for "${m.title}" tier ${m.tier} rank ${m.rank} by ${m.by}, ${m.lagMs}ms after create`);
  gridLiveSeer(mint, m);
}
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
// v0.1.85: the rats' fast lane too. Its pass is now capped at 100s (digFast), so a stale fast lane means the loop
// itself waited on something outside the pass (its Redis lock or heartbeat); a fresh loop is started instead of a
// restart, and a third time within 30 minutes still restarts the process.
const LOOP_GEN = { agents: 0, slow: 0, hist: 0, fast: 0 };
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
  else if (name === "fast") (fastAt = now), digFastLoop(LOOP_GEN.fast).catch(() => null);
  else (histAt = now), historianLoop(LOOP_GEN.hist).catch(() => null);
  return true;
}
// v0.1.126: each launch's dev buy (SOL) and create time, for the RUG GUARD's entry state (newest 20,000)
const DEV_SOL = new Map<string, { sol: number; at: number }>();
function noteDevSol(mint: string, sol: number, at: number) {
  DEV_SOL.set(mint, { sol: Math.round(sol * 1000) / 1000, at });
  if (DEV_SOL.size > 20_000) DEV_SOL.delete(DEV_SOL.keys().next().value as string);
}
let beatSide = false;
let lagLogAt = 0;
async function beat() {
  if (!beatSide) {
    beatSide = true;
    Promise.allSettled([stallAlerts(), criticalChecks()]).finally(() => (beatSide = false));
  }
  const stuck = Date.now() - sessionAt;
  const deskStuck = Date.now() - deskAt;
  // the process is up: the minute ping stays out (it only takes over when the worker is gone, see /api/desk/run)
  await redis().set("rn:worker:at", Date.now(), { ex: 120 }).catch(() => {});
  const lag = loopLag();
  redis().set("rn:rpc", { at: Date.now(), ...rpcView(), loop: lag, tapes: tapeStats, exec: { sender: senderStats, liveFee: LIVE_FEE }, origin: originStats, dx: dxStats, theme: themeStats }, { ex: 120 }).catch(() => {});
  if (lag && lag.p99 > 250 && Date.now() - lagLogAt > 60_000) (lagLogAt = Date.now()), console.log(`event loop late: p50 ${lag.p50}ms, p99 ${lag.p99}ms, worst ${lag.max}ms (last minute)`);
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
  if (Date.now() - fastAt > 150_000) {
    const at = FAST_STEP.step ? ` (at: ${FAST_STEP.step}, ${Math.round((Date.now() - FAST_STEP.at) / 1000)}s)` : "";
    if (!revive("fast", `the rats' fast lane is stuck${at}`)) return restart(`the rats' fast lane is stuck again${at}`);
  }
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
  // v0.1.82: while the FIREHOSE is up it logs every trade itself (PumpPortal's would be the same trades twice)
  if (!fireLive()) logTrade({ mint, w: String(m.traderPublicKey || ""), buy: m.txType !== "sell", sol: Number(m.solAmount) || 0, tok: Number(m.tokenAmount) || 0, vSol: Number(m.vSolInBondingCurve) || undefined, mcSol: Number(m.marketCapSol) || undefined, pool: m.pool ? String(m.pool) : undefined });
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
// v0.1.87: coins CATCH or SHIELD asked for in the last 2 minutes: the firehose keeps their live tape from then on
const RT_ASKED = new Map<string, number>();
const rtWanted = (mint: string, now = Date.now()) => {
  const a = RT_ASKED.get(mint);
  if (a == null) return false;
  if (now - a > 120_000) return RT_ASKED.delete(mint), false;
  return true;
};
(globalThis as any).__rnRt = (ms: string[]) => {
  const now = Date.now();
  const out: Record<string, unknown> = {};
  for (const m of ms) RT_ASKED.set(m, now);
  if (RT_ASKED.size > 5000) for (const [k, a] of RT_ASKED) if (now - a > 120_000) RT_ASKED.delete(k);
  for (const m of ms) {
    const w = TAPE.get(m);
    const l = LAST.get(m);
    if (!w || !l || now - l.at > 90_000) continue;
    out[m] = { mc: l.mc, at: l.at, ...tapeOf(w, now) };
  }
  return out;
};
let rtPruneAt = 0;
async function flushTape() {
  const now = Date.now();
  // v0.1.87: tapes of coins nobody watches or asked for any more
  if (now - rtPruneAt > 60_000) {
    rtPruneAt = now;
    for (const k of [...TAPE.keys()]) if (!watched.has(k) && !rtWanted(k, now)) (TAPE.delete(k), LAST.delete(k), SEEN.delete(k));
  }
  if (now - lastStreamMark > 10_000) {
    lastStreamMark = now;
    const quiet = Math.round((now - lastMsgAt) / 1000);
    markAlive("stream", quiet > 20 ? { error: `no message for ${quiet}s` } : { feed: FEED ? `${FEED.view().up ? "up" : "down"} ${FEED.view().addrs} accts ${FEED.view().quotes} px ${Math.round(FEED.view().perDay / 1000)}K/day${FEED.view().error ? ` err ${FEED.view().error.slice(0, 30)}` : ""}` : PP_KEY ? "pumpportal key" : "off", curves: CURVES ? `${CURVES.view().up ? "up" : "down"} ${CURVES.view().addrs} coins ${Math.round(CURVES.view().perDay / 1000)}K/day hit ${curveFeed.hits + curveFeed.misses ? Math.round((curveFeed.hits / (curveFeed.hits + curveFeed.misses)) * 100) : 0}%${CURVES.view().error ? ` err ${CURVES.view().error.slice(0, 30)}` : ""}` : "off", ppKey: PP_KEY ? 1 : 0, ...(PP_KEY ? { pp: `${watched.size} coins · ${ppCount()} trades today ~${((ppCount() / 10_000) * 0.01).toFixed(4)} SOL of ${PP_DAILY_SOL} SOL cap${ppCapped() ? " REACHED" : ""}` } : {}), lastTradeSec: streamSize().lastTradeSec ?? "never", lastMsgSec: quiet, logs: streamSize().logs, coins: TAPE.size, quotes: streamSize().quotes, intake: intakeNote() }).catch(() => {}); // v0.1.116: the intake note last (a long error in it cut ppKey off the note, and /status read the trade stream as off)
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
  if (!PP_KEY && !fireLive()) {
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
let OTHER_SIGS: string[] = []; // v0.1.92: creates in another quote, marked seen for the chain backfill

let flashPausedAt = 0;
// v0.1.54: on only if every launch's trades are streamed from birth. v0.1.87: the FIREHOSE streams every launch's
// trades from its first block, so FLASH runs while it is up (and the day's Redis bandwidth is on pace)
const flashAll = () => fireLive() && bwLevel() < 1;
function flashTick() {
  const now = Date.now();
  // FLASH reads the first seconds from trade messages alone. Without a PumpPortal key there are none (v0.1.34: the
  // Helius feed follows positions only), and a launch with no trades would read as dead and be learned as dead.
  // v0.1.54: FLASH needs every launch's trades from birth. The trade stream follows a shortlist only (paid per trade),
  // so FLASH stays paused: a launch without its trades would read as dead and be learned as dead
  if (!tradesFlowing(now) || !flashAll()) {
    FLW.clear();
    if (now - flashPausedAt > 30_000) {
      flashPausedAt = now;
      markAlive("flash", { paused: fireLive() ? "Redis bandwidth ahead of pace" : "the firehose is down (every launch's trades from birth come from it)" }).catch(() => {});
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
// v0.1.94: a batch gets 15s (DIGGING_MS). On 16 Oct one batch never ended (a read that never answered) and the intake
// stood still from 18:17: every launch after it was read from the chain, 20 to 30s late. Now the next batch starts.
const intakeStats = { batches: 0, items: 0, timeouts: 0, errors: 0, lastMs: 0, maxMs: 0, last: "", dropped: 0 };
const INTAKE_MAX = 5_000;
async function flushIntake() {
  if (OTHER_SIGS.length) {
    const s = OTHER_SIGS;
    OTHER_SIGS = [];
    markSigsSeen(s).catch(() => null);
  }
  if (intakeBusy || !INTAKE.length) return;
  intakeBusy = true;
  const items = INTAKE;
  INTAKE = [];
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ingestStream(items),
      new Promise((_, no) => (timer = setTimeout(() => no(new Error(`intake batch over ${DIGGING_MS / 1000}s (at: ${INTAKE_STEP.step || "start"})`)), DIGGING_MS))),
    ]).catch((e) => {
      const msg = String(e?.message || e);
      if (/^intake batch over/.test(msg)) intakeStats.timeouts++;
      else intakeStats.errors++;
      intakeStats.last = `${new Date().toISOString().slice(11, 19)} ${msg.slice(0, 80)}`;
      console.log("intake error", msg);
    });
  } finally {
    clearTimeout(timer);
    const ms = Date.now() - t0;
    intakeStats.batches++;
    intakeStats.items += items.length;
    intakeStats.lastMs = ms;
    intakeStats.maxMs = Math.max(intakeStats.maxMs, ms);
    intakeBusy = false;
  }
}
const intakeNote = () =>
  `${intakeStats.batches} batches ${intakeStats.items} launches last ${intakeStats.lastMs}ms max ${intakeStats.maxMs}ms queue ${INTAKE.length}${intakeStats.timeouts ? ` timeouts ${intakeStats.timeouts}` : ""}${intakeStats.errors ? ` errors ${intakeStats.errors}` : ""}${intakeStats.dropped ? ` dropped ${intakeStats.dropped}` : ""}${intakeStats.last ? ` (${intakeStats.last})` : ""}`;

let noteAt = 0;
const PP_KEY = process.env.PUMPPORTAL_API_KEY || "";
// every trade, from PumpPortal (with a key) or the Helius feed, goes through here
let TRADE_IN: (msg: any) => void = () => {};
// v0.1.87: coins PumpPortal streams trades for right now (only while the firehose is down), and the live-tape hook the
// firehose uses for the watch list (CATCH and SHIELD read that tape; with PumpPortal's trades refused it was empty)
const PP_SUBBED = new Set<string>();
let TAPE_IN: (msg: any) => void = () => {};
let FEED: ReturnType<typeof heliusFeed> | null = null;
// v0.1.53: the live curve stream for every launch in its first 7 minutes (the minute-1 read and the minute-5 call).
// Its own socket, so the positions' feed never waits behind 400+ launch subscriptions.
let CURVES: ReturnType<typeof heliusFeed> | null = null;
// every curve update goes to the rats' memory and (sampled, every 10s per coin) to the archive (v0.1.55)
const onCurveUpd = (mint: string, v: Parameters<typeof noteCurve>[1]) => {
  noteCurve(mint, v);
  archiveTick(mint, v);
  if (!fireLive()) gridLiveCurve(mint, v as any); // v0.1.71: GRID LIVE books (v0.1.81: the FIREHOSE feeds them when it is up)
  if ((v as any)?.complete) afterNoteMigration(mint); // v0.1.72: AFTER follows its pool for 6 hours
};
// v0.1.72: AFTER, the pool prices of every migrated coin for 6 hours (archive + GRID LIVE)
let AFTER: ReturnType<typeof heliusFeed> | null = null;
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
  TAPE_IN = (msg: any) => onTrade(msg, kick);
  const resync = async () => {
    if (!up) return;
    const want = await wantList();
    const add = [...want].filter((k) => !watched.has(k));
    const drop = [...watched].filter((k) => !want.has(k));
    // PumpPortal streams trades only with a funded key (since Oct 2026); without one the Helius feed brings them
    // v0.1.87: while the FIREHOSE is up it has every trade; PumpPortal's keyed trade stream then only answered "Minimum
    // balance not met for PumpSwap websocket data" (386 reconnects). It is asked again only when the firehose is down.
    // The watch list itself stays: the firehose feeds these coins' live tape (CATCH, SHIELD) instead.
    const pp = !fireLive();
    if (add.length && PP_KEY && pp) ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: add }));
    if (!pp && PP_SUBBED.size) {
      ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [...PP_SUBBED] }));
      PP_SUBBED.clear();
    } else if (pp) for (const k of add) PP_SUBBED.add(k);
    if (drop.length) {
      if (PP_KEY && PP_SUBBED.size) ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: drop }));
      for (const k of drop) PP_SUBBED.delete(k);
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
      PP_SUBBED.clear();
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
        gridLiveSymbol(mint, String(msg.symbol || "").slice(0, 16)); // v0.1.78: names for the every-launch twins
        seerOn(mint, String(msg.name || ""), String(msg.symbol || ""), now);
        originSee(mint, String(msg.name || ""), String(msg.symbol || ""), String(msg.traderPublicKey || ""), now); // v0.1.103
        INTAKE.push({ mint, sig: String(msg.signature || msg.sig || msg.txSignature || ""), creator: String(msg.traderPublicKey || ""), name: String(msg.name || "").slice(0, 64), symbol: String(msg.symbol || "").slice(0, 16), uri: String(msg.uri || ""), devBuySol: Math.round((Number(msg.solAmount) || 0) * 100) / 100, createdAt: now });
        logCreate(mint, String(msg.traderPublicKey || ""), now, Number(msg.solAmount) || 0, Number(msg.initialBuy ?? msg.tokenAmount) || 0);
        if (!FLW.has(mint)) FLW.set(mint, { t0: now, mint, sym: String(msg.symbol || ""), creator: String(msg.traderPublicKey || ""), devSol: Number(msg.solAmount) || 0, vSol: Number(msg.vSolInBondingCurve) || 30, vTok: Number(msg.vTokensInBondingCurve) || 0, mcSol: Number(msg.marketCapSol) || 0, trades: [], done: [] });
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
async function digFastLoop(my = LOOP_GEN.fast) {
  for (;;) {
    if (my !== LOOP_GEN.fast) return; // a newer copy of this loop took over (see revive)
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

// v0.1.64: Railway's own Redis (REDIS_URL, private network) instead of Upstash. On the first start the worker copies
// every key from Upstash before any loop runs (lib/redismove.ts). If the first copy fails, the worker stays on Upstash
// and logs why (the next restart tries again).
// v0.1.69: with REDIS_URL set the worker NEVER falls back to Upstash when Railway's Redis does not answer. On 11 Oct
// Redis restarted (volume resize) while the worker redeployed: the worker started on Upstash, ran every loop there, and
// the site (reading Railway's Redis) saw every loop silent for 50+ minutes. Now it waits for Redis, retrying with
// backoff, and sends one Telegram alert after 2 minutes.
async function setupRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return console.log("redis: Upstash (REDIS_URL not set)");
  const { connectRedisWait, installLocal } = await import("../src/lib/redisrest");
  const { criticalSend } = await import("../src/lib/critical");
  const r = await connectRedisWait(url, {
    log: (s) => console.log(s),
    onAlert: (mins) => criticalSend(`🚨 <b>Worker waiting for Redis</b>\nRailway's Redis has not answered for ${mins} minutes. Every loop waits until it does.\n\nRailway: open the Redis service. Online? Check Metrics and the volume (a full disk stops writes).`),
    onBack: (mins) => criticalSend(`✅ <b>Redis is back</b> after ${mins} minutes. The worker is starting its loops.`),
  });
  // v0.1.70: a failed disk snapshot must not block writes (a Redis restart resets this setting, so it is checked here
  // and every minute in the critical checks)
  const { redisGuard } = await import("../src/lib/redisrest");
  const h = await redisGuard(r).catch(() => null);
  console.log("redis guard:", JSON.stringify(h));
  const upUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
  const upTok = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
  if (/upstash\.io/i.test(upUrl) && upTok) {
    const { moveFromUpstash, upstashRaw } = await import("../src/lib/redismove");
    try {
      const res = await moveFromUpstash(r, upstashRaw(upUrl, upTok));
      console.log("redis move:", JSON.stringify(res));
    } catch (e: any) {
      console.log("redis move failed, staying on Upstash for now:", e?.message || e);
      r.disconnect();
      return;
    }
  }
  installLocal(r);
  console.log("redis: Railway's Redis (private network)");
}

// v0.1.71: Telegram when GRID finds a candidate that held up on the unseen test calls (once per candidate)
async function gridAlert(res: GridView) {
  const msg = gridMessage(res);
  if (!msg) return;
  const key = res.rows.filter((r) => r.pass).map((r) => `${r.filter}:${r.mode}`).sort().join(",");
  if ((await redis().get("rn:grid:alerted").catch(() => null)) === key) return;
  await redis().set("rn:grid:alerted", key, { ex: 7 * 86400 }).catch(() => null);
  await criticalSend(msg);
}

// v0.1.100 (audit): one worker at a time. On a deploy Railway starts the new worker before the old one is gone, and on
// 16 Oct the old one ran ~6 more minutes next to it (two firehoses, two diggers, two GRID LIVE books writing over each
// other, the old desk holding the lock). Each boot claims the generation; a worker that sees a newer one hands over:
// it frees the desk lock and exits once no swap of its own is in flight.
const GEN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let handing = false;
async function checkGen() {
  if (handing) return;
  const g = await redis().get<string>("rn:worker:gen").catch(() => null);
  if (!g || g === GEN) return;
  if (swapsInFlight() > 0) return console.log("a newer worker started: handing over once the swap in flight settles");
  handing = true;
  console.log(`a newer worker started (${g}): handing over and exiting`);
  const { releaseDeskLock } = await import("../src/lib/desk");
  await releaseDeskLock().catch(() => null);
  await redis().lpush("rn:worker:exits", { at: Date.now(), why: "handed over to a newer worker" }).catch(() => {});
  await redis().ltrim("rn:worker:exits", 0, 49).catch(() => {});
  process.exit(0);
}

async function main() {
  await setupRedis();
  await redis().incr("rn:worker:boots").catch(() => 0);
  await redis().set("rn:worker:bootAt", Date.now()).catch(() => null);
  await redis().set("rn:worker:gen", GEN).catch(() => null);
  setInterval(() => checkGen().catch(() => null), 5_000);
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
  // young launches first (the calls depend on them), then called coins in the hour after their call (v0.1.59)
  CURVES = heliusFeed({ want: async () => new Set([...youngMints().slice(-CURVE_MAX), ...followedLonger()].slice(0, CURVE_MAX)), onQuote: () => {}, onCurve: onCurveUpd, max: CURVE_MAX, pools: false, label: "live curves of every launch (first 7 minutes)", log: (x) => console.log(x) });
  // v0.1.72: AFTER: migrated coins' pool vaults, streamed for 6 hours after the migration
  await afterLoad().catch(() => null);
  AFTER = heliusFeed({
    want: async () => afterWant(),
    onQuote: (q) => {
      if (q.curve) return;
      afterStats.quotes++;
      archivePoolTick(q.mint, { mcSol: q.mcSol, real: q.real }, migratedAt(q.mint) ?? Date.now());
      if (!fireLive()) gridLiveQuote(q.mint, { mcSol: q.mcSol, real: q.real }); // v0.1.81: the FIREHOSE feeds GRID LIVE when up
    },
    max: 400,
    label: "pool prices of migrated coins (6 hours after the migration)",
    log: (x) => console.log(x),
  });
  setInterval(() => {
    afterResolve((ms) => readPools(ms) as any)
      .then((found) => found.length && AFTER?.nudge())
      .catch(() => null);
  }, 20_000);
  setInterval(() => {
    redis().set("rn:after:view", { at: Date.now(), ...afterStats, following: afterWant().size, feed: AFTER?.view() ?? null }, { ex: 3600 }).catch(() => null);
  }, 60_000);
  setCurveLive(() => {
    const a = CURVES?.live() || new Set<string>();
    for (const m of FEED?.live() || []) a.add(m);
    return a;
  });
  setInterval(() => pruneCurves(), 5_000);
  // v0.1.71: GRID LIVE: GRID's best strategies trade on live coins (paper), the books loaded from the last run
  await gridLiveLoad().catch((e) => console.log("grid live load error", e?.message || e));
  // v0.1.112 GRID SCORE: the last run's model scores live calls until the next GRID run fits a new one
  await redis()
    .get<any>("rn:grid:view")
    .then((v) => (setScoreModel(v?.score?.model), setProfitModel(v?.pscore?.model), setWinModel(v?.wscore?.model)))
    .catch(() => null);
  // v0.1.115: the EARLY search's scores for the EARLY books
  // v0.1.117: one EARLY search per reading age (rn:grid:early is the 2-minute one, rn:grid:early:<sec> the others)
  for (const sec of EARLY_CHECKS())
    await redis()
      .get<any>(sec === 120 ? "rn:grid:early" : `rn:grid:early:${sec}`)
      .then((v) => setEarlyModels({ mig: v?.score?.model, pft: v?.pscore?.model, win: v?.wscore?.model }, sec))
      .catch(() => null);
  await seerLoad().catch((e) => console.log("seer load error", e?.message || e));
  // v0.1.119 TREND: TikTok and Instagram through Apify (APIFY_TOKEN), a run every TREND_EVERY_MIN (default 2 hours)
  await trendLoad().catch(() => 0);
  let trending = false;
  const trend = () => {
    if (trending) return;
    trending = true;
    trendTick()
      .then((r: any) => markAlive("trend", { ...r, rising: trendStats.rising, ...(trendStats.lastErr && !trendStats.down ? { last: trendStats.lastErr } : {}), ...(trendStats.down ? { error: trendStats.down } : {}) }))
      .catch((e) => markAlive("trend", { error: String(e?.message || e) }))
      .finally(() => (trending = false));
  };
  setTimeout(trend, 90_000);
  setInterval(trend, 10 * 60_000);
  // v0.1.109 IMAGE and THEME: Claude's labels, one every 6s within the daily cap; a new label re-reads its call
  await themeLoad().catch(() => 0);
  setOnLabel((mint) => {
    const th = themeAt(mint, Date.now());
    if (th) gridLiveRelabel(mint, th);
  });
  let themeBusy = false;
  setInterval(() => {
    if (themeBusy) return;
    themeBusy = true;
    themeDrain().catch(() => null).finally(() => (themeBusy = false));
  }, 6_000);
  // v0.1.102: SEER looks ahead every 10 minutes (events, trends, big posts -> names and tickers to watch for)
  let seerBusy = false;
  const seerRun = () => {
    if (seerBusy) return;
    seerBusy = true;
    seerTick()
      .then((s) => s && console.log("SEER tick", JSON.stringify(s)))
      .catch((e) => console.log("seer error", e?.message || e))
      .finally(() => (seerBusy = false));
  };
  setTimeout(seerRun, 60_000);
  setInterval(seerRun, 10 * 60_000);
  await loadLiveFees().catch(() => null); // v0.1.96: paper pays what live transactions paid
  await loadRunTrack().catch(() => null); // v0.1.100: the day's runner paths keep going after a restart
  setCallHook((call) => {
    gridLiveCall(call);
    // v0.1.89: runner paths: BOND calls and calls already 30%+ up the curve are followed for a day (archive)
    if (call?.mint && (call.verdict === "BOND" || Number(call.progress) >= 30)) runTrack(String(call.mint), Number(call.at) || Date.now());
  });
  // v0.1.75: FOLLOW: the desk buys every entry of GRID LIVE's leader (a strategy that passed the exam live)
  {
    const { queueGridOrder } = await import("../src/lib/desk");
    setGridFollow((o) => queueGridOrder(o));
  }
  setInterval(() => {
    try {
      gridLiveSweep();
    } catch (e: any) {
      console.log("grid live sweep error", e?.message || e);
    }
  }, 10_000);
  setInterval(() => gridLivePublish((t) => criticalSend(t)).catch(() => null), 60_000);
  // v0.1.97: the daily review on Telegram, 06:50 UTC (08:50 Amsterdam), once a day
  setInterval(() => dailyReview((t) => criticalSend(t)).catch((e) => console.log("review error", e?.message || e)), 10 * 60_000);
  // v0.1.123: live fills vs paper over the last 20 live trades of each side, alert when worse than the fill limit
  setInterval(() => liveGapAlert((t) => criticalSend(t), GAP_LIMIT * 100).catch(() => null), 5 * 60_000);
  // v0.1.128 FOMO TAP, EARNERS, CREWS: who is buying (after CRAWLNET's Queen x FOMO). Books load at boot, save as they grow
  {
    const r = redis();
    const known = async () => {
      const b = await book().catch(() => ({}) as Record<string, any>);
      fomoSetKnown(Object.entries(b).filter(([, x]: [string, any]) => String(x?.cls || "").startsWith("fomo")).map(([w]) => w));
    };
    void known();
    setInterval(() => void known(), 30 * 60_000);
    fomoLearn(); // v0.1.130: the pinned FOMO account from the first second
    classBoot().then((n) => console.log(`class gate: ${n} live round trips by market-cap class`)).catch((e) => console.log("class gate boot error", e?.message || e));
    void (async () => {
      // v0.1.130: once, drop the books built with the shared accounts (FOMO), the 1,755-wallet bot crew and records with
      // misread amounts; they rebuild from the stream with the new rules
      if (await r.set("rn:v130:purged", Date.now(), { nx: true }).catch(() => null)) await Promise.all([r.del("rn:fomo:w"), r.del("rn:crew:edges"), r.del("rn:earn:rec")]).catch(() => null);
      await r.hgetall<Record<string, number>>("rn:fomo:w").then((x) => fomoLoad(x || {})).catch(() => null);
      await r.hgetall<Record<string, any>>("rn:earn:rec").then((x) => earnLoad(x || {})).catch(() => null);
      await r.get<[string, string][]>("rn:crew:edges").then((x) => crewLoad(x || [])).catch(() => null);
    })();
    setInterval(async () => {
      try {
        fomoLearn();
        const nw = fomoNew();
        if (nw.length) for (let i = 0; i < nw.length; i += 500) await r.hset("rn:fomo:w", Object.fromEntries(nw.slice(i, i + 500).map((w) => [w, Date.now()])));
        await r.set("rn:crew:edges", crewEdges(), { ex: 14 * 86400 });
        await r.set("rn:smart:view", { at: Date.now(), fomo: fomoView(), hot: fomoHot(), earners: earnView(), crews: crewView(), buys: smartStats, gate: { classes: gateView(), ...gateStats } }, { ex: 86400 });
      } catch (e: any) {
        console.log("smart save error", e?.message || e);
      }
    }, 5 * 60_000);
    // the records with 5+ round trips, every 30 minutes (they keep growing across restarts)
    setInterval(async () => {
      const d = earnDump(5);
      const ks = Object.keys(d);
      for (let i = 0; i < ks.length; i += 1000) await r.hset("rn:earn:rec", Object.fromEntries(ks.slice(i, i + 1000).map((k) => [k, d[k]]))).catch(() => null);
      earnStats.saved = ks.length;
    }, 30 * 60_000);
  }
  // v0.1.81: the FIREHOSE (Shyft gRPC): every pump.fun and PumpSwap trade feeds GRID LIVE, WALLETS and TAPE ALL
  {
    const on = await startFirehose({
      create: (c) => {
        walletCreate(c.mint, c.creator, c.at);
        tapeCreate(c.mint, c.creator, c.at);
        gridLiveSymbol(c.mint, c.symbol);
        // v0.1.82: every launch's log from birth (the dev's buy follows as the transaction's first trade): the rats'
        // minute-1 and minute-5 tapes are built from it instead of ~42 chain reads per coin
        // v0.1.87: only SOL launches get a log from birth (another quote's trades are never logged: its tape would be
        // empty, and the King scored $ZECRET blind on 16 Oct)
        if (c.solQuote === false) {
          noteOtherQuote(c.mint);
          if (c.sig) OTHER_SIGS.push(c.sig);
        } else {
          logCreate(c.mint, c.creator, c.at, 0, 0, true);
          // v0.1.87: FLASH watches every launch from its first block (the firehose has all its trades)
          if (!FLW.has(c.mint) && flashAll()) FLW.set(c.mint, { t0: c.at, mint: c.mint, sym: String(c.symbol || ""), creator: c.creator, devSol: c.devSol || 0, vSol: 30 + (c.devSol || 0), vTok: 1_073_000_000, mcSol: 0, trades: [], done: [] });
        }
        // v0.1.85: every launch goes to the rats from here too (PumpPortal misses many: the chain backfill then read each
        // one with getTransaction, ~3,000 an hour). The rats keep the first copy of a launch, from either source.
        if (c.solQuote !== false && c.mint) seerOn(c.mint, String(c.name || ""), String(c.symbol || ""), c.at);
        if (c.solQuote !== false && c.mint) originSee(c.mint, String(c.name || ""), String(c.symbol || ""), String(c.creator || ""), c.at); // v0.1.103
        if (c.solQuote !== false && c.mint) earlyCreate(c.mint, c.at, String(c.symbol || ""), String(c.name || "")); // v0.1.115 EARLY
        if (c.solQuote !== false && c.mint) noteDevSol(c.mint, Number(c.devSol) || 0, c.at); // v0.1.126 RUG GUARD
        if (c.solQuote !== false && c.mint) tickCreate(c.mint, c.at, String(c.symbol || ""), String(c.name || "")); // v0.1.120 TICK
        if (c.solQuote !== false && c.mint && c.sig) {
          if (INTAKE.length >= INTAKE_MAX) INTAKE.shift(), intakeStats.dropped++; // never grows without end
          INTAKE.push({ mint: c.mint, sig: c.sig, creator: c.creator, name: String(c.name || "").slice(0, 64), symbol: String(c.symbol || "").slice(0, 16), uri: String(c.uri || ""), devBuySol: Math.round((c.devSol || 0) * 100) / 100, createdAt: c.at });
        }
      },
      tx: (keys, users) => void fomoTx(keys, users),
      trade: (t) => {
        tapeTrade(t);
        // v0.1.128 EARNERS: every wallet's record. v0.1.129: curve trades and the coin's own SOL pool only (a PumpSwap pool
        // quoted in USDC or another token reported its amounts as SOL: one wallet showed +1.3M SOL)
        if (t.venue === "curve" || t.mcSol != null) earnTrade(t);
        smartTrade(t); // v0.1.128: FOMO crowd, earners, crews
        originMc(t.mint, t.mcSol); // v0.1.103 ORIGIN: market caps for alpha/beta
        // v0.1.87: the live tape for the watch list (CATCH bursts, SHIELD), in PumpPortal's message shape
        const fl = t.venue === "curve" ? FLW.get(t.mint) : undefined;
        if (fl) {
          fl.trades.push({ t: t.at, side: t.isBuy ? "buy" : "sell", sol: t.sol, w: t.user });
          if (t.real != null) fl.vSol = 30 + t.real;
          if (t.prog != null) fl.vTok = 1_073_000_000 - (t.prog / 100) * 793_100_000;
          if (t.mcSol) fl.mcSol = t.mcSol;
        }
        if (watched.has(t.mint) || rtWanted(t.mint)) TAPE_IN({ mint: t.mint, traderPublicKey: t.user, txType: t.isBuy ? "buy" : "sell", solAmount: t.sol, tokenAmount: t.tokens, marketCapSol: t.mcSol, pool: t.venue === "curve" ? "pump" : "pump-amm" });
        if (t.venue === "curve") walletTrade(t, t.prog ?? 0);
        logTrade({ mint: t.mint, w: t.user, buy: t.isBuy, sol: t.sol, tok: t.tokens, mcSol: t.mcSol, pool: t.venue === "curve" ? "pump" : "pump-amm", real: t.real });
      },
      connected: () => {
        const n = logsGap();
        if (n) console.log(`firehose: (re)connected, ${n} launch logs from before it are read from the chain`);
      },
      curve: (mint, v) => {
        gridLiveCurve(mint, v as any);
        earlyCurve(mint, v as any); // v0.1.115
        tickCurve(mint, v as any); // v0.1.120
        archiveRunTick(mint, { mcSol: v.mcapSol, real: v.realSol, progress: v.progress, pool: false, complete: v.complete });
      },
      pool: (mint, q) => {
        gridLiveQuote(mint, { mcSol: q.mcSol, real: q.real });
        earlyPool(mint, { mcSol: q.mcSol, real: q.real }); // v0.1.115
        archiveRunTick(mint, { mcSol: q.mcSol, real: q.real, progress: 100, pool: true });
      },
      complete: (mint, at) => (walletComplete(mint, at), themeBond(mint, at)),
      otherQuote: (mint) => noteOtherQuote(mint),
    }).catch((e) => (console.log("firehose start error", e?.message || e), false));
    console.log(on ? "firehose: starting (Shyft gRPC)" : "firehose: off (set SHYFT_GRPC_URL and SHYFT_GRPC_TOKEN)");
    const fx = (mint: string) => {
      if (!fireLive()) return null;
      const f = tapeFeatures(mint);
      // v0.1.105: KOL flow and the first 20 buyers (KOL counts only once HOUND's roster is in memory)
      const fl = flowFeatures(mint);
      const usd = solUsdNow();
      const kols = kolCount() > 0;
      return { pw: f.pw, u60: f.u60, bs60: f.bs60, wh: f.wh, kf: kols ? fl.kf : null, kmu: kols && fl.kmc != null && usd > 0 ? Math.round(fl.kmc * usd) : null, kx: kols ? fl.kx : null, e20: fl.e20 };
    };
    setTapeExtra(fx);
    // v0.1.90: GRID LIVE's every-launch books also know whether the dev sold (the "dev has not sold" rule)
    setLiveFeatures((m: string) => {
      const x = fx(m);
      return x ? { ...x, ds: tapeFeatures(m).ds } : null;
    });
    setInterval(() => (tapeSweep(), flowSweep()), 30_000);
    // v0.1.105: HOUND's KOL wallets for the flow book (every 30 minutes: the roster hash is large, Redis bandwidth); GRID LIVE positions watch the flow
    const loadKols = () =>
      book()
        .then((b) => setKols(Object.values(b || {}).filter((x: any) => x && x.cls === "kol" && !x.off).map((x: any) => x.w)))
        .catch(() => null);
    loadKols();
    setInterval(loadKols, 30 * 60_000);
    const flowOf = (m: string) => {
      const fl = flowFeatures(m);
      return { kx: kolCount() > 0 ? fl.kx : null, e20: fl.e20 };
    };
    setFlowFeatures(flowOf);
    // v0.1.126 RUG GUARD: the coin's state at each paper buy (age, dev buy, last minute's flow, dev sold, origin rank)
    setEntryFeatures((m: string, now: number) => {
      const created = originCreated(m) ?? DEV_SOL.get(m)?.at ?? null;
      const f = tapeFeatures(m, now);
      const og = originAt(m, null, now);
      const sm = smartFeatures(m, now); // v0.1.128
      return { age: created ? Math.round((now - created) / 1000) : null, dev: DEV_SOL.get(m)?.sol ?? null, u60: f.u60 ?? null, bs60: f.bs60 ?? null, wh: f.wh ?? null, ds: f.ds ?? null, og: og?.rank ?? null, fc: sm.fc, ea: sm.ea, pwi: sm.pwi, pwr: sm.pwr, bt: sm.bt };
    });
    // v0.1.110: every-launch books on the new rules know the coin's origin, DexScreener orders and flow without a call
    setAnySignals((m: string, now: number) => {
      const created = originCreated(m);
      const fl = flowFeatures(m);
      const usd = solUsdNow();
      const kols = kolCount() > 0;
      return {
        sx: { og: originAt(m, null, now), dx: created ? dxLive(m, created, now) : null },
        kf: kols ? fl.kf : null,
        kmu: kols && fl.kmc != null && usd > 0 ? Math.round(fl.kmc * usd) : null,
        kx: kols ? fl.kx : null,
        e20: fl.e20,
      };
    });
    // v0.1.115 EARLY: every launch still alive at 2 minutes is read (the same reads as the every-launch books), archived
    // and followed; the EARLY books trade the read on paper
    setInterval(() => {
      if (!fireLive()) return;
      try {
        const reads = earlySweep((m: string, now: number, name: string, sym: string) => {
          const x = fx(m);
          if (!x) return null;
          const created = originCreated(m);
          return { ...x, ds: tapeFeatures(m).ds, og: originAt(m, null, now), dx: created ? dxLive(m, created, now) : null, tr: trendAt(name, sym) };
        });
        for (const r of reads) gridLiveEarly(r.mint, earlyCoin(r.mint, r.at, r.createdAt, r.f) as unknown as GCoin, r.at, r.sec);
      } catch (e: any) {
        console.log("early sweep error", e?.message || e);
      }
    }, 5_000);
    // v0.1.120 TICK MODEL: every coin trading on its curve, every 20 seconds: grade, learn, predict; signals to the TICK books
    await tickLoad().catch(() => null);
    let tickBusy = false;
    setInterval(() => {
      if (!fireLive() || tickBusy) return;
      tickBusy = true;
      try {
        const t0 = Date.now();
        const sigs = tickRun((m: string, now: number, name: string, sym: string) => {
          const x = fx(m);
          if (!x) return null;
          const tf = tapeFeatures(m);
          const created = originCreated(m);
          const og = originAt(m, null, now);
          const dx = created ? dxLive(m, created, now) : null;
          return { u60: x.u60, bs60: x.bs60, wh: x.wh, pw: x.pw, n60: tf.n60 ?? null, kf: x.kf, kx: x.kx, e20: x.e20, ds: tf.ds, og: og ? { rank: og.rank, cr: og.cr } : null, dx: dx ? { paid: dx.paid } : null, tr: trendAt(name, sym) };
        });
        for (const g of sigs) gridLiveTick(g.mint, g.sym, g.h, g.ev);
        const ms = Date.now() - t0;
        if (ms > 2000) console.log(`tick: a pass took ${ms}ms (${tickStats.coins} coins)`);
      } catch (e: any) {
        console.log("tick error", e?.message || e);
      } finally {
        tickBusy = false;
      }
    }, 5_000);
    setInterval(() => {
      tickSave().catch(() => null);
      const v = tickView();
      markAlive("tick", { coins: tickStats.coins, graded: tickStats.graded, pending: tickStats.pending, ...Object.fromEntries(v.models.map((m) => [`h${m.h}`, `${m.n}${m.ready ? "" : " warming"} ic ${m.ic ?? "-"}`])) }).catch(() => null);
    }, 5 * 60_000);
    // v0.1.108: the desk runs a followed strategy's flow exit on live money with the same read
    import("../src/lib/desk").then((d) => d.setDeskFlow(flowOf)).catch(() => null);
    // v0.1.82: the firehose logs every launch and quotes every trade; PumpPortal's resync (which pruned these) only runs
    // while PumpPortal is connected, so they are pruned here too (old launch logs, quotes older than 2 minutes)
    setInterval(() => pruneStream(new Set()), 30_000);
    setInterval(() => walletSweep(), 5 * 60_000);
    setInterval(() => walletsSave(archivePool()).catch(() => 0), 10 * 60_000);
    setInterval(() => {
      if (!on) return void markAlive("firehose", { status: "off until SHYFT_GRPC_URL and SHYFT_GRPC_TOKEN are set" }).catch(() => null);
      markAlive("firehose", { up: fireLive(), msgs: fireStats.msgs, trades: fireStats.trades, pool: fireStats.poolTrades, reconnects: fireStats.reconnects, otherQuote: fireStats.otherQuoteCreates, runners: runTracked(), early: `${earlyStats.coins}/${earlyStats.seen} (${EARLY_CHECKS().map((x) => `${x}s:${earlyStats.bySec[x] || 0}`).join(" ")})`, ...(fireLive() ? {} : { error: fireStats.lastErr || "no messages" }) }).catch(() => null);
      // v0.1.82: what the firehose saved (curve and pool reads answered from it) and the Dune backfill's progress
      const pctOf = (h: number, r: number) => (h + r ? Math.round((h / (h + r)) * 100) : 0);
      // v0.1.86: coins read with no curve (remembered 30s); a few examples in the log so the cause can be checked
      if (curveFire.missing) console.log("curves missing", curveFire.missing, curveFire.missingSample.join(","));
      redis().set("rn:wallets:view", { ...walletsView(), fire: { up: fireLive(), since: fireStats.since, trades: fireStats.trades, creates: fireStats.creates, completes: fireStats.completes, tape: tapeSize(), curveSaved: pctOf(curveFire.hits, curveFire.reads), curveMissing: curveFire.missing, poolSaved: pctOf(poolFire.hits, poolFire.reads), cached: fcSize().curves + fcSize().pools }, dune: { on: !!process.env.DUNE_API_KEY, running: duneState.running, done: duneState.done, chunks: duneState.chunks, rows: duneState.rows, error: duneState.error ? "the history query failed (details in the worker log)" : "", stopped: duneState.stopped ? "paused" : "" } }, { ex: 3600 }).catch(() => null);
    }, 60_000);
  }
  // v0.1.78: every 5 minutes: drop ruled-out books, spawn the hot strategy's family (exit variants + every-launch twin)
  const tend = () =>
    gridLiveTend((t) => criticalSend(t))
      .then((r) => (r.dropped.length || r.added.length || r.revived.length) && console.log(`grid live tend: dropped ${r.dropped.length}, added ${r.added.length}, revived ${r.revived.length}${r.hot ? `, hot ${r.hot}` : ""}`))
      .catch((e) => console.log("grid live tend error", e?.message || e));
  setTimeout(tend, 2 * 60_000);
  setInterval(tend, 5 * 60_000);
  // v0.1.82: RESEARCHER, at most once an hour (the last run is kept in Redis, so restarts never make it run more often)
  let researchLast: Record<string, unknown> = { status: "first run within the hour" };
  const research = async () => {
    if (!process.env.ANTHROPIC_API_KEY) return void markAlive("researcher", { status: "off until ANTHROPIC_API_KEY is set" }).catch(() => null);
    const last = Number((await redis().get("rn:research:at").catch(() => 0)) || 0);
    if (Date.now() - last >= RESEARCH_EVERY_MS) {
      await redis().set("rn:research:at", Date.now()).catch(() => null);
      const res: any = await researchPass((t) => criticalSend(t)).catch((e) => ({ error: String(e?.message || e) }));
      console.log("researcher:", JSON.stringify(res).slice(0, 300));
      researchLast = res?.error ? { error: String(res.error).slice(0, 120) } : res?.full ? { status: "all 4 of its books are trading" } : res?.wait ? { status: res.wait } : { added: res?.added?.length ?? 0, refused: res?.refused?.length ?? 0 };
    }
    markAlive("researcher", researchLast).catch(() => null);
  };
  setTimeout(() => research().catch(() => null), 8 * 60_000);
  setInterval(() => research().catch(() => null), 10 * 60_000);
  // v0.1.58: ARENA's summary for the site, once a minute (only when it changed)
  setInterval(() => arenaPublish().catch(() => null), 60_000);
  // v0.1.63: REGIME, every 5 minutes (first reading 90s after start): market + ARENA hit rates switch the desk's strategies
  const regime = async () => {
    const t = await regimeTick(await arenaRecentTrips()).catch((e) => (console.log("regime error", e?.message || e), null));
    if (t?.switches.length) console.log(`regime: ${t.switches.map((x) => `${x.sleeve} ${x.from}->${x.to}`).join(", ")} (market ${t.market.state})`);
  };
  setTimeout(() => regime().catch(() => null), 90_000);
  setInterval(() => regime().catch(() => null), 5 * 60_000);
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
    // v0.1.124b: GRID LIVE's records reloaded from the archive (every paper trip since v0.1.123 is there)
    archiveGridTrips(14, 400)
      .then((rows) => {
        const n = rows ? gridLiveBackfill(rows as any) : 0;
        console.log(`grid live: ${n} trips restored from the archive (${rows?.length ?? 0} read)`);
        redis().set("rn:gridlive:backfill", { at: Date.now(), read: rows?.length ?? 0, added: n }, { ex: 7 * 86400 }).catch(() => null);
      })
      .catch((e) => console.log("grid live backfill error", e?.message || e));
    // v0.1.104 ATTENTION: DexScreener's paid profiles and boosts, live every 10s; order histories for calls (30 a
    // minute, the calls of the last 14 days queued once at boot behind the new ones)
    let dxBusy = false;
    setInterval(() => dxPoll().catch(() => null), 10_000);
    setInterval(() => {
      if (dxBusy) return;
      dxBusy = true;
      dxDrain().catch(() => null).finally(() => (dxBusy = false));
    }, 2_000);
    // v0.1.106: no boot backfill; each GRID run queues its own coins that have no DexScreener history yet
    // v0.1.103 ORIGIN: 21 days of launches in time order (the live 7-day index, and the origin of GRID's older calls)
    originLoad(archivePool())
      .then((n) => console.log(`origin: ${n} launches read, ${originStats.hist} older calls, ${originStats.index} in the live index, ${Math.round(originStats.loadMs / 1000)}s${originStats.error ? `, error: ${originStats.error}` : ""}`))
      .catch((e) => console.log("origin load error", e?.message || e));
    // v0.1.81: WALLETS' scores live in the archive
    walletsLoad(archivePool())
      .then((n) => {
        console.log(`wallets: ${n} scored wallets loaded`);
        // v0.1.82: 90 days of history from Dune (once: done chunks are skipped), after the live scores are in memory
        if (process.env.DUNE_API_KEY) duneBackfill(archivePool()).then((d) => console.log(`dune backfill: ${d.done}/${d.chunks} chunks, ${d.rows} wallets, ${Math.round(d.credits)} credits${d.error ? `, error: ${d.error}` : ""}${d.stopped ? `, ${d.stopped}` : ""}`));
      })
      .catch(() => null);
    setInterval(() => archiveFlush().catch(() => null), 5_000);
    const board = async () => {
      const b = await archiveBoard().catch(() => null);
      if (b) await redis().set("rn:archive:board", b, { ex: 86400 }).catch(() => null);
    };
    setTimeout(board, 20_000);
    setInterval(board, 5 * 60_000);
    setTimeout(() => archivePrune().catch(() => null), 60_000); // v0.1.68: also once at start (frees disk after a full day)
    setInterval(() => archivePrune().catch(() => null), 6 * 3600_000);
    // v0.1.59: REPLAY over the archive, 3 minutes after start and then every 3 hours (one run at a time)
    let replaying = false;
    const replay = async () => {
      if (replaying) return;
      replaying = true;
      const t0 = Date.now();
      try {
        const res = await archiveReplay();
        if (res) {
          await redis().set("rn:replay:view", { ...res, ms: Date.now() - t0 }, { ex: 2 * 86400 }).catch(() => null);
          console.log(`replay: ${res.usable} calls (${res.covered} with a path) in ${Math.round((Date.now() - t0) / 1000)}s`);
        }
      } catch (e: any) {
        console.log("replay error", e?.message || e);
      } finally {
        replaying = false;
      }
    };
    setTimeout(() => replay().catch(() => null), 3 * 60_000);
    setInterval(() => replay().catch(() => null), 3 * 3600_000);
    // v0.1.71: GRID, the big strategy search, 8 minutes after start and then every 3 hours (never next to REPLAY)
    let gridding = false;
    const grid = async () => {
      if (gridding || replaying) return;
      gridding = true;
      try {
        // v0.1.112 NULL RUN: 3 shuffled searches each run (GRID_NULL), their luck stats kept across runs for the bar
        const nullHist = ((await redis().get<number[]>("rn:grid:null").catch(() => null)) || []) as number[];
        const res = await archiveGrid(14, { nulls: Math.max(0, Math.min(10, Number(process.env.GRID_NULL ?? 3) || 0)), nullHist: Array.isArray(nullHist) ? nullHist : [] });
        if (res) {
          await redis().set("rn:grid:null", res.nullHist).catch(() => null);
          // learning across runs: each strategy's record over earlier runs, then the best go live in GRID LIVE
          const hist = gridHistory(((await redis().get("rn:grid:hist").catch(() => null)) as GHist | null) || null, res);
          withSeen(res, hist);
          await redis().set("rn:grid:hist", hist).catch(() => null);
          const books = await gridLiveSetBooks(liveCandidates(res, 16));
          gridLiveSignals(res.senders?.lifts); // v0.1.110: the SIGNALS family reads the lift table
          console.log(`grid live: ${books.length} strategies trading on live coins (${(books as any).kept} kept, ${(books as any).added} new, ${(books as any).dropped?.length ?? 0} dropped)`);
          await redis().set("rn:grid:view", res, { ex: 3 * 86400 }).catch(() => null);
          console.log(`grid: ${res.coins} calls, ${res.tried} combinations, ${res.rankable} rankable, ${res.passed} passed every check (quality: ${res.quality.rules}/${res.quality.of} rules good alone, ${res.quality.pairs} pairs; ${res.passedBasic} the test alone; luck bar t ${res.nullRun.bar}, ${res.nullRun.lucky}/${res.nullRun.kept} null runs lucky; score AUC ${res.score.test?.auc ?? "-"}, profit score AUC ${res.pscore.test?.auc ?? "-"}, win score edge ${res.wscore.test?.edge ?? "-"} pts, effective N ${res.score.effN}) (load ${Math.round(res.loadMs / 1000)}s, search ${Math.round(res.ms / 1000)}s)`);
          await gridAlert(res).catch(() => null);
        }
        // v0.1.115 the EARLY search: every launch read at 2 minutes, its own scores, checks and luck bar
        // v0.1.117: one search per reading age (60s, 2, 3 and 5 minutes), each with its own scores, luck bar and books
        for (const sec of EARLY_CHECKS()) {
          const vk = sec === 120 ? "rn:grid:early" : `rn:grid:early:${sec}`;
          const nk = sec === 120 ? "rn:grid:enull" : `rn:grid:enull:${sec}`;
          const eHist = ((await redis().get<number[]>(nk).catch(() => null)) || []) as number[];
          const er: any = await archiveEarlyGrid(10, { nulls: sec === 120 ? 2 : 1, nullHist: Array.isArray(eHist) ? eHist : [] }, sec).catch((e: any) => ({ early: true, sec, error: String(e?.message || e).slice(0, 200) }));
          if (!er) continue;
          if (er.nullHist) await redis().set(nk, er.nullHist).catch(() => null);
          if (er.rows) {
            setEarlyModels({ mig: er.score?.model, pft: er.pscore?.model, win: er.wscore?.model }, sec);
            const eb = await gridLiveEarlyBooks(er.rows, er.explore, Date.now(), sec);
            console.log(`grid early ${sec}s: ${er.coins} reads, ${er.passed} passed every check (${er.passedBasic} the test alone), win score edge ${er.wscore?.test?.edge ?? "-"} pts, ${eb.length} new EARLY books`);
          } else console.log(`grid early ${sec}s: ${er.why || er.error || "no run"}`);
          const { nullHist: _nh, ...ev } = er;
          await redis().set(vk, { ...ev, at: Date.now() }, { ex: 3 * 86400 }).catch(() => null);
        }
      } catch (e: any) {
        console.log("grid error", e?.message || e);
        // v0.1.85: the last good run stays (the site and RESEARCHER read it); the failure is noted next to it
        const prev = await redis().get<any>("rn:grid:view").catch(() => null);
        const err = { error: String(e?.message || e).slice(0, 200), failedAt: Date.now() };
        await redis().set("rn:grid:view", prev?.at ? { ...prev, ...err } : { at: null, ...err }, { ex: prev?.at ? 3 * 86400 : 86400 }).catch(() => null);
      } finally {
        gridding = false;
      }
    };
    // v0.1.73: GRID's 3-hour timer fired in the same millisecond as REPLAY's (both set at start, both 3 hours), found
    // REPLAY running and skipped, every time: after its first run GRID never ran again (13-14 Oct: 17 hours). Now a
    // check every 5 minutes runs it once an hour has passed since the last run (a run takes ~1-2 s), waiting while
    // REPLAY runs. Hourly is safe since books are kept until their live record decides them (gridLiveSetBooks).
    let gridAt = 0;
    const gridDue = async () => {
      if (gridding || replaying || Date.now() - gridAt < 3600_000) return;
      gridAt = Date.now();
      await grid();
    };
    setTimeout(() => gridDue().catch(() => null), 8 * 60_000);
    setInterval(() => gridDue().catch(() => null), 5 * 60_000);
  };
  await startArchive().catch(() => null);
  setInterval(() => {
    const v = archiveView();
    markAlive("archive", !v.on ? { off: "DATABASE_URL not set" } : !v.ready ? { error: v.error || "not connected" } : { launches: v.written.launches, ticks: v.written.ticks, trades: v.written.trades, trips: v.written.trips, queued: v.queued, fails: v.fails, dropped: (v as any).dropped ?? 0, ...(v.lastError ? { last: v.lastError.slice(0, 60).replace(/,/g, ";") } : {}) }).catch(() => {});
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
  // v0.1.84: the same prices every second from the firehose (every trade, no chain read), so the site's market caps,
  // changes and P&L follow the chain within ~2-3s instead of up to ~20s
  let pxFastBusy = false;
  setInterval(() => {
    if (pxFastBusy || !fireLive()) return;
    pxFastBusy = true;
    refreshPxFast((m) => fcPrice(m))
      .catch(() => null)
      .finally(() => (pxFastBusy = false));
  }, 1_000);
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
  startLoopLag();
  await Promise.all([deskLoop(), agentLoop(), digFastLoop(), digSlowLoop(), historianLoop()]);
}
main();
