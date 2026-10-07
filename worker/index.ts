// The always-on worker: runs the whole protocol back to back, with no gaps between minute pings, and digs a new
// pump.fun launch the moment PumpPortal announces it. Deploy it on Railway (or any always-on host) from the same
// GitHub repo with the same environment variables; start command: npm run worker. While it runs, the Vercel minute
// ping steps aside on its own (it sees the worker's heartbeat) and comes back if the worker stops.
import { runSession } from "../src/lib/session";
import { historianSession } from "../src/lib/historian";
import { deskSession } from "../src/lib/desk";
import { digFast, digSlow, ingestStream } from "../src/lib/digger";
import { flashFollow, flashLook, streamStats, FL_STAGES, type FlashLook, type FlCoin } from "../src/lib/flash";
import { K, redis } from "../src/lib/redis";
import { lane } from "../src/lib/solana";
import { markAlive } from "../src/lib/alive";
import { catchPass, noteMigration } from "../src/lib/catcher";

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
async function beat() {
  const stuck = Date.now() - sessionAt;
  const deskStuck = Date.now() - deskAt;
  if (Date.now() - fastAt > 120_000) {
    console.log("watchdog: the rats' fast lane is stuck, restarting");
    process.exit(1);
  }
  if (stuck > SESSION_MS * 5 || deskStuck > DESK_MS + 180_000) {
    console.log(`watchdog: ${deskStuck > DESK_MS + 180_000 ? "desk" : "agent"} loop stuck (${Math.round(Math.max(stuck, deskStuck) / 1000)}s), restarting`);
    process.exit(1);
  }
  if (stuck > SESSION_MS * 3 || deskStuck > DESK_MS + 90_000) return console.log("watchdog: a loop is running long, heartbeat paused");
  await redis().set("rn:worker:at", Date.now(), { ex: 120 }).catch(() => {});
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
let lastStreamMark = 0;

function onTrade(m: any, kick: () => void) {
  const mint = String(m.mint);
  const now = Date.now();
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

async function flushTape() {
  const now = Date.now();
  if (now - lastStreamMark > 10_000) {
    lastStreamMark = now;
    markAlive("stream", { coins: TAPE.size, watching: watched.size, firstSeconds: FLW.size }).catch(() => {});
  }
  const out: Record<string, unknown> = {};
  for (const [mint, w] of TAPE) {
    const l = LAST.get(mint);
    if (!l || now - l.at > 90_000) continue;
    out[mint] = { mc: l.mc, at: l.at, ...tapeOf(w, now) };
  }
  if (Object.keys(out).length) {
    const r = redis();
    await r.hset("rn:rt", out).catch(() => {});
    await r.expire("rn:rt", 180).catch(() => {});
  }
}

/** Which coins to stream trades for: open positions, the 100 hottest curves, every migration of the last 2 hours
 *  (their pool stage too: PumpPortal streams PumpSwap trades), and whatever CATCH is watching. */
async function wantList() {
  const r = redis();
  const now = Date.now();
  const [pos, radar, mig, cw] = await Promise.all([
    r.hkeys(K.deskPos).catch(() => []),
    r.zrange<string[]>(K.radar, 0, 99, { rev: true }).catch(() => []),
    r.zrange<string[]>("rn:ct:mig", now - 2 * 3600_000, now, { byScore: true }).catch(() => []),
    r.hkeys("rn:ct:watch").catch(() => []),
  ]);
  const want = new Set([...(pos || []), ...(radar || []), ...(mig || [])].map(String).filter(Boolean));
  for (const m of cw || []) if (want.size < 400) want.add(String(m));
  for (const m of FLW.keys()) want.add(m); // launches in their first ~100 seconds (FLASH)
  return want;
}

// FLASH: every new launch is streamed for its first ~100 seconds and read at 15s, 45s and 90s, from the trades
// alone (no chain reads). The create message also goes straight to the rats (dug ~1 second after birth).
const FLW = new Map<string, FlCoin>();
let INTAKE: any[] = [];

function flashTick() {
  const now = Date.now();
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

async function flushIntake() {
  if (!INTAKE.length) return;
  const items = INTAKE;
  INTAKE = [];
  await ingestStream(items).catch((e) => console.log("intake error", e?.message || e));
}

function pumpportal() {
  const WS: any = (globalThis as any).WebSocket;
  if (!WS) return console.log("no WebSocket in this Node version: launches are found by polling (Node 22+ recommended)");
  let lastCatch = 0;
  let ws: any = null;
  let up = false;
  const kick = () => {
    if (Date.now() - lastCatch < 3000) return;
    lastCatch = Date.now();
    lane.run(2, () => catchPass(true)).catch(() => null);
  };
  const resync = async () => {
    if (!up) return;
    const want = await wantList();
    const add = [...want].filter((k) => !watched.has(k));
    const drop = [...watched].filter((k) => !want.has(k));
    if (add.length) ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: add }));
    if (drop.length) {
      ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: drop }));
      drop.forEach((k) => (TAPE.delete(k), LAST.delete(k), SEEN.delete(k)));
    }
    watched = want;
  };
  const open = () => {
    ws = new WS("wss://pumpportal.fun/api/data");
    ws.onopen = () => {
      up = true;
      watched = new Set();
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      resync().catch(() => null);
      console.log("pumpportal: launches, migrations and live trades");
    };
    ws.onmessage = (ev: any) => {
      let msg: any = null;
      try {
        msg = JSON.parse(String(ev?.data || ""));
      } catch {}
      if (!msg?.mint) return;
      const tx = String(msg.txType || "");
      if (tx === "migrate" || tx === "migration") {
        noteMigration(String(msg.mint)).catch(() => null);
        kick();
        return;
      }
      if (tx === "buy" || tx === "sell") {
        const fc = FLW.get(String(msg.mint));
        if (fc) {
          fc.trades.push({ t: Date.now(), side: tx, sol: Number(msg.solAmount) || 0, w: String(msg.traderPublicKey || "") });
          if (Number(msg.vSolInBondingCurve) > 0) fc.vSol = Number(msg.vSolInBondingCurve);
          if (Number(msg.vTokensInBondingCurve) > 0) fc.vTok = Number(msg.vTokensInBondingCurve);
          if (Number(msg.marketCapSol) > 0) fc.mcSol = Number(msg.marketCapSol);
        }
        return onTrade(msg, kick);
      }
      // a new launch: to the rats now (batched every 300ms), and onto FLASH's first-seconds watch
      if (tx === "create" || (!tx && msg.uri && msg.name)) {
        const now = Date.now();
        const mint = String(msg.mint);
        INTAKE.push({ mint, sig: String(msg.signature || ""), creator: String(msg.traderPublicKey || ""), name: String(msg.name || "").slice(0, 64), symbol: String(msg.symbol || "").slice(0, 16), uri: String(msg.uri || ""), devBuySol: Math.round((Number(msg.solAmount) || 0) * 100) / 100, createdAt: now });
        FLW.set(mint, { t0: now, mint, sym: String(msg.symbol || ""), creator: String(msg.traderPublicKey || ""), devSol: Number(msg.solAmount) || 0, vSol: Number(msg.vSolInBondingCurve) || 30, vTok: Number(msg.vTokensInBondingCurve) || 0, mcSol: Number(msg.marketCapSol) || 0, trades: [], done: [] });
        if (up) ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
        watched.add(mint);
      }
    };
    // reconnect once per drop, 3s later (errors are always followed by a close)
    let again = false;
    ws.onclose = () => {
      up = false;
      if (again) return;
      again = true;
      setTimeout(open, 3000);
    };
    ws.onerror = () => {};
  };
  open();
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
let fastAt = Date.now();
async function digFastLoop() {
  for (;;) {
    const t0 = Date.now();
    fastAt = t0;
    // a pass that waits too long is left to finish on its own: the lane moves on (its lock expires in 30s)
    const r: any = await Promise.race([digFast().catch((e) => ({ error: e?.message || e })), new Promise((res) => setTimeout(() => res({ error: "fast pass ran past 45s" }), 45_000))]);
    await markAlive("rats_fast", r);
    if (r?.error || (r?.dug && Math.random() < 0.05)) console.log(new Date().toISOString(), "dig fast", JSON.stringify(r).slice(0, 200));
    await new Promise((res) => setTimeout(res, Math.max(150, 1000 - (Date.now() - t0))));
  }
}
async function digSlowLoop() {
  let n = 0;
  for (;;) {
    const t0 = Date.now();
    const r: any = await digSlow().catch((e) => ({ error: e?.message || e }));
    const f: any = await flashFollow().catch((e) => ({ flashError: e?.message || e }));
    await markAlive("rats_slow", r);
    if (n++ % 15 === 0 || r?.error) console.log(new Date().toISOString(), "dig slow", `${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify({ ...r, ...f }).slice(0, 300));
    await new Promise((res) => setTimeout(res, Math.max(500, 4000 - (Date.now() - t0))));
  }
}

// The historian replays the past around the clock in its own loop (it used to get 45 seconds of each agents'
// session and nothing in between). Its RPC lane only takes what the desk and the rats leave free.
async function historianLoop() {
  let n = 0;
  for (;;) {
    const t0 = Date.now();
    const r: any = await Promise.race([historianSession(110_000).catch((e) => ({ history: "error", error: e?.message || e })), new Promise((res) => setTimeout(() => res({ history: "ran past 3 minutes" }), 180_000))]);
    await markAlive("historian", r);
    if (n++ % 5 === 0 || r?.error) console.log(new Date().toISOString(), "historian", `${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(r).slice(0, 240));
    // nothing to do (done, off, busy, waiting): look again in a few seconds instead of spinning
    if (Date.now() - t0 < 3000) await new Promise((res) => setTimeout(res, 5000));
  }
}

async function agentLoop() {
  for (;;) {
    const t0 = Date.now();
    sessionAt = t0;
    try {
      const r: any = await runSession(SESSION_MS, { desk: false, historian: false });
      console.log(new Date().toISOString(), `session ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify({ momo: r?.momo, mind: r?.mind, lens: r?.lens, catch: r?.catch, hound: r?.hound, overseer: r?.overseer }).slice(0, 500));
    } catch (e: any) {
      console.log("session error", e?.message || e);
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}

async function main() {
  console.log(`RATNET worker up · desk in ${DESK_MS / 1000}s sessions, agents in ${SESSION_MS / 1000}s sessions, rats in a 1s fast lane and a 4s slow lane, launches from the stream`);
  pumpportal();
  setInterval(beat, 20_000);
  await beat();
  await Promise.all([deskLoop(), agentLoop(), digFastLoop(), digSlowLoop(), historianLoop()]);
}
main();
