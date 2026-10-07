// The always-on worker: runs the whole protocol back to back, with no gaps between minute pings, and digs a new
// pump.fun launch the moment PumpPortal announces it. Deploy it on Railway (or any always-on host) from the same
// GitHub repo with the same environment variables; start command: npm run worker. While it runs, the Vercel minute
// ping steps aside on its own (it sees the worker's heartbeat) and comes back if the worker stops.
import { runSession } from "../src/lib/session";
import { deskSession } from "../src/lib/desk";
import { dig } from "../src/lib/digger";
import { K, redis } from "../src/lib/redis";
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
  return want;
}

function pumpportal() {
  const WS: any = (globalThis as any).WebSocket;
  if (!WS) return console.log("no WebSocket in this Node version: launches are found by polling (Node 22+ recommended)");
  let lastDig = 0;
  let lastCatch = 0;
  let ws: any = null;
  let up = false;
  const kick = () => {
    if (Date.now() - lastCatch < 3000) return;
    lastCatch = Date.now();
    catchPass(true).catch(() => null);
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
      if (tx === "buy" || tx === "sell") return onTrade(msg, kick);
      // a new launch
      if (Date.now() - lastDig < 1500) return;
      lastDig = Date.now();
      dig().catch(() => null);
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
  setInterval(() => flushTape().catch(() => null), 2_000);
}

async function deskLoop() {
  for (;;) {
    const t0 = Date.now();
    deskAt = t0;
    try {
      const r: any = await deskSession(DESK_MS, () => dig());
      if (r?.skipped) await new Promise((res) => setTimeout(res, 2000)); // another desk holds the lock: wait for it
      else console.log(new Date().toISOString(), `desk ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(r).slice(0, 200));
    } catch (e: any) {
      console.log("desk error", e?.message || e);
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
}

async function agentLoop() {
  for (;;) {
    const t0 = Date.now();
    sessionAt = t0;
    try {
      const r: any = await runSession(SESSION_MS, { desk: false });
      console.log(new Date().toISOString(), `session ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify({ momo: r?.momo, mind: r?.mind, catch: r?.catch, hound: r?.hound }).slice(0, 400));
    } catch (e: any) {
      console.log("session error", e?.message || e);
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}

async function main() {
  console.log(`RATNET worker up · desk in ${DESK_MS / 1000}s sessions, agents in ${SESSION_MS / 1000}s sessions, side by side`);
  pumpportal();
  setInterval(beat, 20_000);
  await beat();
  await Promise.all([deskLoop(), agentLoop()]);
}
main();
