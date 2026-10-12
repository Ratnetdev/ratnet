// v0.1.70: a failed Redis disk snapshot (MISCONF) no longer stops the desk. Run: npx tsx sim/v070test.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { connectRedisWait, redisGuard } = await import("../src/lib/redisrest");
  const port = 17500 + Math.floor(Math.random() * 400);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rn070-"));
  // snapshots on, as on Railway's Redis template
  const srv = spawn("redis-server", ["--port", String(port), "--dir", dir, "--save", "3600 1", "--appendonly", "no"], { stdio: "ignore" });
  const r = await connectRedisWait(`redis://127.0.0.1:${port}`, { stepMs: 200, timeoutMs: 500 });
  await r.set("rn:a", "1");
  let h = await redisGuard(r);
  ok(h.saveOk && h.healed && h.stopWrites === "yes", "a fresh Redis has the block on (Redis default, back after every restart): switched off at once");
  h = await redisGuard(r);
  ok(h.saveOk && !h.healed, "healthy and already off: nothing to fix");
  await r.call("CONFIG", "SET", "stop-writes-on-bgsave-error", "yes"); // what a Redis restart puts back
  // the disk goes away under Redis: the next snapshot fails, like a full volume
  fs.rmSync(dir, { recursive: true, force: true });
  await r.call("BGSAVE").catch(() => null);
  for (let i = 0; i < 40; i++) {
    const p = String(await r.call("INFO", "persistence"));
    if (/rdb_bgsave_in_progress:0/.test(p) && /rdb_last_bgsave_status:err/.test(p)) break;
    await sleep(100);
  }
  const blocked = await r.set("rn:b", "1").then(() => "", (e) => String(e?.message || e));
  ok(/MISCONF/.test(blocked), `a failed snapshot blocks every write (the 11/12 Oct outage): ${blocked.slice(0, 40)}`);
  h = await redisGuard(r);
  ok(h.healed && h.stopWrites === "yes", "the guard switches the block off");
  ok(!h.saveOk && /snapshot to disk failed/.test(h.saveErr || ""), "and reports that the disk snapshot is failing");
  ok(h.usedMb != null, `memory reported (${h.usedMb}MB)`);
  ok((await r.set("rn:b", "2")) === "OK" && (await r.get("rn:b")) === "2", "writes work again at once");
  h = await redisGuard(r);
  ok(!h.healed, "a second check changes nothing (already off)");
  r.disconnect();
  srv.kill();

  const cr = fs.readFileSync(new URL("../src/lib/critical.ts", import.meta.url), "utf8");
  ok(/\/MISCONF\/i\.test\(msg\)/.test(cr) && /await checkRedisDisk\(local\)/.test(cr), "the critical check unblocks on MISCONF and retries the write");
  ok(/"redisdisk"/.test(cr) && /make the volume bigger/.test(cr), "a failing disk is its own Telegram alert, with the fix");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/redisGuard\(r\)/.test(wk), "the worker checks at boot (a Redis restart resets the setting)");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
