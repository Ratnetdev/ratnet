// v0.1.45 (Run 11, part 2): the exam after a demotion, the admin reset (refused while live, done by the lock holder),
// room checks for stalk fills and re-entries. Run: npx tsx sim/v045test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
(globalThis as any).fetch = async () => new Response("{}");
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};

(async () => {
  const { K } = await import("../src/lib/redis");
  const d = await import("../src/lib/desk");
  const { DEFAULT_SETTINGS } = await import("../src/config/site");
  const cfg: any = { ...DEFAULT_SETTINGS.desk };
  const now = Date.now();

  // 1. after a demotion the exam starts over: only paper round trips since then count
  const trades: any[] = [];
  for (let i = 0; i < 30; i++) {
    const at = now - 3 * 3600_000 + i * 60_000;
    trades.push({ id: `b${i}`, mint: `M${i}`, side: "buy", at, sol: 0.05, live: false });
    trades.push({ id: `s${i}`, mint: `M${i}`, side: "sell", at: at + 30_000, sol: 0.08, pnlSol: 0.03, live: false });
  }
  await R.lpush(K.deskTrades, ...trades.reverse());
  const st: any = { live: false, start: 1, startedAt: now - 4 * 3600_000, cash: 1, dayStart: 1 };
  const before = await d.exam(st, 1);
  const after = await d.exam({ ...st, demotedAt: now - 3600_000 }, 1);
  ok(before.trades === 30 && after.trades === 0, `30 winning paper trips before the demotion count ${before.trades} before, ${after.trades} after: the exam is taken again`);

  // 2. admin reset
  await R.set(K.deskState, { live: true });
  const refused = await d.requestReset();
  ok(!refused.ok && /live/.test(refused.how), "refused while the desk is live (it wiped live positions from the books)");
  await R.set(K.deskState, { live: false, start: 1, cash: 0.4 });
  await R.set("rn:lock:desk", "running-session", { px: 60_000 } as any);
  const asked = await d.requestReset();
  ok(asked.ok && !!(await R.get("rn:desk:resetreq")) && !!(await R.get(K.deskState)), "a running desk is asked to reset itself under its lock; nothing is wiped from outside");
  await R.del("rn:lock:desk");
  await R.del("rn:desk:resetreq");
  const done = await d.requestReset();
  ok(done.ok && done.how === "reset done" && !(await R.get("rn:lock:desk")), "no desk running: reset here, holding the lock, and the lock released");

  // 3. room for stalk fills and re-entries
  const st2: any = { live: false, start: 1, cash: 1, dayStart: 1 };
  ok((await d.roomFor("stalk", st2, 0.7, cfg)) === "the daily loss limit is hit", "30% down on the day (limit 25%): no stalk fill");
  ok((await d.roomFor("stalk", st2, 1, cfg)) === null, "room in the King lane: fill");
  const pos = (mint: string, how: string) => ({ mint, symbol: mint, openedAt: now, entryPx: 1, costSol: 0.05, tokens: 1, tokens0: 1, soldSol: 0, tp1Done: false, lastPx: 1, peakPx: 1, king: 0, nano: null, live: false, series: [], how, msHi: -1 });
  for (let i = 0; i < 3; i++) await R.hset(K.deskPos, { [`MO${i}`]: pos(`MO${i}`, "momo") });
  ok((await d.roomFor("momo", st2, 1, cfg)) === "the MOMO slots are full", "3 MOMO positions: a MOMO bounce is not bought");
  for (let i = 0; i < cfg.maxOpen; i++) await R.hset(K.deskPos, { [`K${i}`]: pos(`K${i}`, "direct") });
  ok(/King slots are full/.test(String(await d.roomFor("direct", st2, 1, cfg))), `${cfg.maxOpen} King positions: no re-entry`);

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.45 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
