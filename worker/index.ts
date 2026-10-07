// The always-on worker: runs the whole protocol back to back, with no gaps between minute pings, and digs a new
// pump.fun launch the moment PumpPortal announces it. Deploy it on Railway (or any always-on host) from the same
// GitHub repo with the same environment variables; start command: npm run worker. While it runs, the Vercel minute
// ping steps aside on its own (it sees the worker's heartbeat) and comes back if the worker stops.
import { runSession } from "../src/lib/session";
import { dig } from "../src/lib/digger";
import { K, redis } from "../src/lib/redis";
import { catchPass, noteMigration } from "../src/lib/catcher";

process.env.RATNET_WORKER = "1";
const SESSION_MS = Number(process.env.WORKER_SESSION_MS || 55_000);

async function beat() {
  await redis().set("rn:worker:at", Date.now(), { ex: 120 }).catch(() => {});
}

// PumpPortal, one connection for everything the agents need the second it happens:
//  - new launches        -> dig right away instead of waiting for the next 5s beat
//  - migrations          -> CATCH looks at the coin at once (fast migrators are decided in the first minutes)
//  - trades on the coins that matter (open positions, the hottest curves, fresh migrations) -> a live tape in Redis
//    (rn:rt) and a CATCH look the moment a buying burst starts, instead of at its next 12-second pass
type Win = { at: number; side: "buy" | "sell"; sol: number; w: string }[];
const TAPE = new Map<string, Win>();
const LAST = new Map<string, { mc: number; at: number }>();
let watched = new Set<string>();

function onTrade(m: any, kick: () => void) {
  const mint = String(m.mint);
  const now = Date.now();
  const w = TAPE.get(mint) || [];
  w.push({ at: now, side: m.txType === "sell" ? "sell" : "buy", sol: Number(m.solAmount) || 0, w: String(m.traderPublicKey || "") });
  while (w.length && now - w[0].at > 20_000) w.shift();
  TAPE.set(mint, w);
  if (Number(m.marketCapSol) > 0) LAST.set(mint, { mc: Number(m.marketCapSol), at: now });
  // a burst: 10+ buys from 6+ wallets and 4+ SOL net in 20 seconds
  const buys = w.filter((x) => x.side === "buy");
  const net = buys.reduce((a, x) => a + x.sol, 0) - w.filter((x) => x.side === "sell").reduce((a, x) => a + x.sol, 0);
  if (buys.length >= 10 && new Set(buys.map((x) => x.w)).size >= 6 && net >= 4) kick();
}

async function flushTape() {
  const now = Date.now();
  const out: Record<string, unknown> = {};
  for (const [mint, w] of TAPE) {
    const l = LAST.get(mint);
    if (!l || now - l.at > 60_000) continue;
    const buys = w.filter((x) => x.side === "buy");
    const sells = w.filter((x) => x.side === "sell");
    out[mint] = { mc: l.mc, at: l.at, b20: buys.length, s20: sells.length, u20: new Set(w.map((x) => x.w)).size, bsol: Math.round(buys.reduce((a, x) => a + x.sol, 0) * 100) / 100, ssol: Math.round(sells.reduce((a, x) => a + x.sol, 0) * 100) / 100 };
  }
  if (Object.keys(out).length) {
    const r = redis();
    await r.hset("rn:rt", out).catch(() => {});
    await r.expire("rn:rt", 120).catch(() => {});
  }
}

/** Which coins to stream trades for: open positions, the 40 hottest curves, fresh migrations. */
async function wantList() {
  const r = redis();
  const [pos, radar, mig] = await Promise.all([r.hkeys(K.deskPos).catch(() => []), r.zrange<string[]>(K.radar, 0, 39, { rev: true }).catch(() => []), r.zrange<string[]>("rn:ct:mig", 0, 29, { rev: true }).catch(() => [])]);
  return new Set([...(pos || []), ...(radar || []), ...(mig || [])].map(String).filter(Boolean));
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
      drop.forEach((k) => (TAPE.delete(k), LAST.delete(k)));
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

async function main() {
  console.log(`RATNET worker up · sessions of ${SESSION_MS / 1000}s back to back`);
  pumpportal();
  setInterval(beat, 20_000);
  await beat();
  for (;;) {
    const t0 = Date.now();
    try {
      const r: any = await runSession(SESSION_MS);
      console.log(new Date().toISOString(), `session ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify({ desk: r?.desk, momo: r?.momo, mind: r?.mind }).slice(0, 300));
    } catch (e: any) {
      console.log("session error", e?.message || e);
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}
main();
