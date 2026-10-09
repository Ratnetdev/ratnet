// v0.1.55: the archive (Postgres) and the build tag on every trade. Run: npx tsx sim/v055test.ts
import { readFileSync } from "fs";
import { newDb } from "pg-mem";
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `the build tag matches package.json (${BUILD})`);

  const ar = await import("../src/lib/archive");
  // no DATABASE_URL: everything is a no-op, nothing breaks
  delete process.env.DATABASE_URL;
  process.env.RATNET_WORKER = "1";
  ok((await ar.archiveInit()) === false && ar.archiveView().on === false, "without DATABASE_URL the archive is off and the worker runs as before");
  ar.archiveTrades([{ id: "x", mint: "M", side: "buy" }], false);
  ok(ar.archiveView().queued === 0, "nothing is queued when off");

  // an in-memory Postgres
  const db = newDb();
  (globalThis as any).__rnPg = db.adapters.createPg();
  process.env.DATABASE_URL = "postgres://test";
  ok((await ar.archiveInit()) === true, `tables created (${ar.archiveView().error || "ok"})`);

  const t0 = Date.now() - 120_000;
  ar.archiveLaunch({ mint: "M1", symbol: "AAA", name: "a", creator: "dev", createdAt: t0, devBuySol: 1, cp: {} });
  ar.archiveLaunch({ mint: "M1", symbol: "AAA", name: "a", creator: "dev", createdAt: t0, devBuySol: 1, cp: {} });
  ok(ar.archiveView().queued === 1, "an unchanged launch is not queued twice");
  ar.archiveLaunch({ mint: "M1", symbol: "AAA", name: "a", creator: "dev", createdAt: t0, devBuySol: 1, cp: { t5: {} }, call: { score: 84, verdict: "BOND", nano: { score: 0, verdict: "DUST" } } });
  for (let i = 0; i < 5; i++) ar.archiveTick("M1", { progress: 30 + i, mcapSol: 40, realSol: 10, complete: false }, t0 + i * 3_000);
  ar.archiveTick("M1", { progress: 50, mcapSol: 40, realSol: 10, complete: false }, t0 + 20_000);
  const cfg = ar.cfgTag({ needNano: true });
  ok(cfg.length === 8 && cfg === ar.cfgTag({ needNano: true }) && cfg !== ar.cfgTag({ needNano: false }), "the settings fingerprint is stable and changes with the settings");
  ar.archiveTrades([{ v: BUILD, cfg, id: "1b", mint: "M1", symbol: "AAA", side: "buy", at: t0, sol: 0.05, cost: 0.0526, tokens: 1000, px: 1e-6, live: false }], false);
  ar.archiveTrades([{ v: BUILD, cfg, id: "1s", mint: "M1", symbol: "AAA", side: "sell", at: t0 + 60_000, sol: 0.06, tokens: 1000, px: 1.2e-6, pnlSol: 0.0074, pnlPct: 14, live: false }], false);
  ar.archiveTrip({ book: "paper", mint: "M1", symbol: "AAA", openedAt: t0, closedAt: t0 + 60_000, costSol: 0.0526, backSol: 0.06, how: "direct", king: 84, nano: 0, peakX: 1.3, reason: "trailing stop", build: BUILD, cfg });
  ar.archiveTrip({ book: "ghost", mint: "M2", symbol: "BBB", openedAt: t0, closedAt: t0 + 30_000, costSol: 0.1, backSol: 0.07, reason: "stop loss" });
  await ar.archiveFlush();
  const v = ar.archiveView();
  ok(v.fails === 0, `batches written without errors (${v.lastError || "ok"})`);
  ok(v.written.launches === 1 && v.written.trades === 2 && v.written.trips === 2, `launch, trades and trips written (${JSON.stringify(v.written)})`);
  ok(v.written.ticks === 2, `curve ticks sampled to one per 10 seconds (${v.written.ticks} of 6)`);

  const b: any = await ar.archiveBoard();
  const paper = b?.rows.find((r: any) => r.book === "paper");
  const ghost = b?.rows.find((r: any) => r.book === "ghost");
  ok(paper?.build === BUILD && paper.n === 1 && paper.wins === 1, "results per build: the paper trip under this build");
  ok(ghost?.build === "before 0.1.55", "a trip opened before the tags shows as 'before 0.1.55'");
  ok(b?.sizes?.launches === 1 && b.sizes.trips === 2, "archive sizes");

  // the same trade again is not doubled; a launch update keeps the call
  ar.archiveTrades([{ v: BUILD, cfg, id: "1b", mint: "M1", side: "buy", at: t0, live: false }], false);
  ar.archiveLaunch({ mint: "M1", symbol: "AAA", createdAt: t0, cp: { t5: {}, h1: {} }, outcome: "DEAD", resolvedAt: t0 + 3600_000 });
  await ar.archiveFlush();
  const rows = (globalThis as any).__rnPg;
  const pool = new rows.Pool();
  const n = (await pool.query("select count(*)::int as n from trades")).rows[0].n;
  const l = (await pool.query("select outcome, call_score from launches where mint = 'M1'")).rows[0];
  ok(n === 2, "a trade written twice is stored once");
  ok(l.outcome === "DEAD" && l.call_score === 84, "a launch update adds the outcome and keeps the call");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.55 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
