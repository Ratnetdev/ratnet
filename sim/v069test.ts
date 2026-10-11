// v0.1.69: the worker never falls back to Upstash when Railway's Redis is slow to answer at boot. Run: npx tsx sim/v069test.ts
import { spawn } from "node:child_process";
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const { connectRedisWait } = await import("../src/lib/redisrest");
  const port = 16900 + Math.floor(Math.random() * 500);
  const url = `redis://127.0.0.1:${port}`;
  // Redis comes up 4 seconds after the worker starts (a restart during a volume resize)
  let srv: ReturnType<typeof spawn> | null = null;
  setTimeout(() => (srv = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" })), 4_000);
  const logs: string[] = [];
  let alerts = 0, backs = 0;
  const t0 = Date.now();
  const r = await connectRedisWait(url, { log: (s) => logs.push(s), onAlert: () => alerts++, onBack: () => backs++, alertAfterMs: 1_500, stepMs: 500, maxMs: 1_000, timeoutMs: 400 });
  const took = Date.now() - t0;
  ok(took >= 3_500, `waited for Redis instead of giving up (${took}ms)`);
  ok((await r.set("rn:t", "1")) === "OK" && (await r.get("rn:t")) === "1", "then reads and writes Railway's Redis");
  ok(logs.length >= 2 && logs.every((l) => /never Upstash/.test(l)), `every retry is logged (${logs.length})`);
  ok(alerts === 1 && backs === 1, `one alert while waiting, one "back" note (${alerts}/${backs})`);
  r.disconnect();

  // Redis already up: no wait, no alert
  let a2 = 0;
  const t1 = Date.now();
  const r2 = await connectRedisWait(url, { onAlert: () => a2++ });
  ok(Date.now() - t1 < 1_000 && a2 === 0, "Redis up: connects at once, no alert");
  r2.disconnect();

  const fs = await import("fs");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/await connectRedisWait\(url/.test(wk), "the worker waits for Railway's Redis at boot");
  ok(!/not reachable: staying on Upstash/.test(wk), "the old fallback (unreachable Redis -> Upstash) is gone");
  ok(/async function main\(\) \{\n  await setupRedis\(\);/.test(wk), "Redis is set up before anything else runs");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version && BUILD === "0.1.69", `build tag ${BUILD}`);
  (srv as any)?.kill();
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
