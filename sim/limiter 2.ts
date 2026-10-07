// RPC limiter test: rate under RPC_RPS, desk before dig before historian. Run: npx tsx sim/limiter.ts
process.env.HELIUS_RPC_URL = "http://fake.rpc";
process.env.RPC_RPS = "10";
const hits: { t: number; n: number }[] = [];
const t0 = Date.now();
(globalThis as any).fetch = async (_u: any, init: any) => {
  const body = JSON.parse(init.body);
  const arr = Array.isArray(body) ? body : [body];
  hits.push({ t: Date.now() - t0, n: arr.length });
  const out = arr.map((b: any) => ({ jsonrpc: "2.0", id: b.id, result: { context: { slot: 1 }, value: 5 } }));
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "content-type": "application/json" } });
};
(async () => {
  const { conn, lane } = await import("../src/lib/solana");
  const { PublicKey } = await import("@solana/web3.js");
  const k = new PublicKey("So11111111111111111111111111111111111111112");
  const done: string[] = [];
  const jobs: Promise<any>[] = [];
  for (let i = 0; i < 15; i++) jobs.push(lane.run(2, () => conn().getBalance(k).then(() => done.push("hist"))));
  for (let i = 0; i < 15; i++) jobs.push(lane.run(1, () => conn().getBalance(k).then(() => done.push("dig"))));
  for (let i = 0; i < 15; i++) jobs.push(conn().getBalance(k).then(() => done.push("desk")));
  await Promise.all(jobs);
  const secs = (Date.now() - t0) / 1000;
  const total = hits.reduce((a, h) => a + h.n, 0);
  const per = (s: number) => hits.filter((h) => h.t >= s * 1000 && h.t < (s + 1) * 1000).reduce((a, h) => a + h.n, 0);
  console.log("45 calls in", secs.toFixed(1), "s; per second:", [0, 1, 2, 3, 4].map(per).join(" "));
  console.log("finish order:", ["desk", "dig", "hist"].map((x) => `${x} last at #${done.lastIndexOf(x) + 1}`).join(", "));
  const max1s = Math.max(...hits.map((h) => hits.filter((x) => x.t >= h.t && x.t < h.t + 1000).reduce((a, x) => a + x.n, 0)));
  console.log("max calls in any 1s window:", max1s, max1s <= 11 ? "PASS" : "FAIL");
  process.exit(0);
})();
