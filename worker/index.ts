// The always-on worker: runs the whole protocol back to back, with no gaps between minute pings, and digs a new
// pump.fun launch the moment PumpPortal announces it. Deploy it on Railway (or any always-on host) from the same
// GitHub repo with the same environment variables; start command: npm run worker. While it runs, the Vercel minute
// ping steps aside on its own (it sees the worker's heartbeat) and comes back if the worker stops.
import { runSession } from "../src/lib/session";
import { dig } from "../src/lib/digger";
import { redis } from "../src/lib/redis";
import { catchPass, noteMigration } from "../src/lib/catcher";

process.env.RATNET_WORKER = "1";
const SESSION_MS = Number(process.env.WORKER_SESSION_MS || 55_000);

async function beat() {
  await redis().set("rn:worker:at", Date.now(), { ex: 120 }).catch(() => {});
}

// new launches pushed by PumpPortal: dig right away instead of waiting for the next 5s beat
function launches() {
  const WS: any = (globalThis as any).WebSocket;
  if (!WS) return console.log("no WebSocket in this Node version: launches are found by polling (Node 22+ recommended)");
  let lastDig = 0;
  let lastCatch = 0;
  let ws: any = null;
  const open = () => {
    ws = new WS("wss://pumpportal.fun/api/data");
    ws.onopen = () => {
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      console.log("pumpportal: watching new launches and migrations");
    };
    ws.onmessage = (ev: any) => {
      let msg: any = null;
      try {
        msg = JSON.parse(String(ev?.data || ""));
      } catch {}
      // a migration: CATCH looks at the coin right away (the fast migrators are decided in the first minutes)
      if (msg?.mint && (msg.txType === "migrate" || msg.txType === "migration")) {
        noteMigration(String(msg.mint)).catch(() => null);
        if (Date.now() - lastCatch > 3000) {
          lastCatch = Date.now();
          catchPass(true).catch(() => null);
        }
        return;
      }
      if (Date.now() - lastDig < 1500) return;
      lastDig = Date.now();
      dig().catch(() => null);
    };
    // reconnect once per drop, 3s later (errors are always followed by a close)
    let again = false;
    ws.onclose = () => {
      if (again) return;
      again = true;
      setTimeout(open, 3000);
    };
    ws.onerror = () => {};
  };
  open();
}

async function main() {
  console.log(`RATNET worker up · sessions of ${SESSION_MS / 1000}s back to back`);
  launches();
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
