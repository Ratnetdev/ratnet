// v0.1.85: trading 24/7 on the chain budget. Reads tagged by part, curves trusted until their next trade, "no pool yet"
// remembered, every launch from the firehose (no chain backfill read), a fast pass capped at 100s, GRID LIVE books
// never wiped by a failed read and brought back when lost in profit, RESEARCHER runs without a ranked GRID row.
// Run: npx tsx sim/v085test.ts
process.env.FAST_PASS_MS = "300";
import { Keypair } from "@solana/web3.js";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const pk = () => Keypair.generate().publicKey.toBase58();
(async () => {
  const fs = await import("fs");
  const S = await import("../src/lib/solana");
  const FC = await import("../src/lib/firecache");
  const FH = await import("../src/lib/firehose");
  const L = await import("../src/lib/gridlive");
  const g = await import("../src/lib/grid");

  // ---- 1. every read says which part of a lane made it
  await S.lane.run(1, () => S.tagged("hot", async () => S.noteMethod(1, "getMultipleAccounts", 3)));
  await S.lane.run(1, async () => S.noteMethod(1, "getSignaturesForAddress", 1));
  const top = new Map(S.methodsView().top);
  ok(top.get("rats:getMultipleAccounts@hot") === 3 && top.get("rats:getSignaturesForAddress") === 1, "reads counted as lane:method@part (untagged reads keep lane:method)");
  ok(S.methodsView().top.length <= 16, "/status lists the top 16");

  // ---- 2. a curve is trusted until its next trade (10 min guard); a pool still 60s
  FC._fcReset();
  const t0 = Date.now();
  FC.fcConnected(t0);
  const cv = { progress: 40, mcapSol: 80, realSol: 20, complete: false, priceSol: 8e-8, supply: 1e9 };
  FC.fcCurveTrade("C", cv, 1, t0);
  FC.fcPoolTrade("P", { pool: "x", sol: 300, tok: 5e7, px: 6e-6 }, 2, t0);
  FC.fcBeat(t0 + 9 * 60_000);
  ok(!!FC.fcCurve("C", t0 + 9 * 60_000) && FC.fcPool("P", t0 + 9 * 60_000) === null, "a quiet curve 9 minutes later: still from the firehose; a pool after 60s: the chain");
  FC.fcBeat(t0 + 11 * 60_000);
  ok(FC.fcCurve("C", t0 + 11 * 60_000) === null, "after 10 minutes the curve is checked against the chain once");

  // ---- 3. "no pool yet" is remembered for 30s, cleared the moment the pool is created
  FC._fcReset();
  const n0 = Date.now();
  FC.fcConnected(n0);
  FC.fcNoPool("M", n0);
  FC.fcBeat(n0 + 20_000);
  ok(FC.fcNoPoolYet("M", n0 + 20_000), "no pool at the last read: not asked again for 30s");
  FC.fcBeat(n0 + 31_000);
  ok(!FC.fcNoPoolYet("M", n0 + 31_000), "after 30s the chain is asked again");
  FC.fcNoPool("M2", n0 + 31_000);
  const mint = pk();
  const { canonicalPool } = await import("../src/lib/pool");
  FC.fcNoPool(mint, n0 + 31_000);
  FH.handleTx([{ kind: "createPool", ts: 1, creator: pk(), baseMint: mint, quoteMint: "So11111111111111111111111111111111111111112", poolBase: 1n, poolQuote: 1n, pool: canonicalPool(mint) } as any], [], {}, undefined, Date.now(), 1);
  ok(!FC.fcNoPoolYet(mint, n0 + 31_000) && FC.fcNoPoolYet("M2", n0 + 31_000), "the firehose sees the canonical pool created: the mark is gone at once (others stay)");
  FC.fcConnected(n0 + 32_000);
  ok(!FC.fcNoPoolYet("M2", n0 + 32_000), "a reconnect forgets every mark (a creation may have been missed)");
  const P = await import("../src/lib/pool");
  FC.fcNoPool("NP", Date.now());
  const hits = P.poolFire.hits;
  const rp = await P.readPools(["NP"]);
  ok(rp.NP === null && P.poolFire.hits === hits + 1, "readPools answers \"no pool\" without a chain read");

  // ---- 4. every launch from the firehose: signature, uri and the dev's buy (the backfill skips it)
  const creator = pk();
  const cm = pk();
  const got: any[] = [];
  const create = { kind: "create", name: "Rat", symbol: "RAT", uri: "https://x/y.json", mint: cm, curve: pk(), user: creator, creator, ts: 1_760_000_000 };
  const dev = { kind: "trade", mint: cm, sol: 1_500_000_000n, tokens: 50_000_000_000_000n, isBuy: true, user: creator, ts: 1_760_000_000, vSol: 31_500_000_000n, vTok: 1_023_000_000_000_000n, rSol: 1_500_000_000n, rTok: 743_000_000_000_000n };
  FH.handleTx([create as any, dev as any], [], { create: (c: any) => got.push(c) }, "SIG1", Date.now(), 5);
  ok(got.length === 1 && got[0].sig === "SIG1" && got[0].uri === "https://x/y.json" && got[0].devSol === 1.5 && got[0].devTok === 50_000_000 && got[0].solQuote === true && got[0].at === 1_760_000_000_000, "the create carries its signature, uri, the dev's 1.5 SOL buy and the SOL quote");
  got.length = 0;
  FH.handleTx([create as any, { ...dev, user: pk() } as any], [], { create: (c: any) => got.push(c) }, "SIG2", Date.now(), 6);
  ok(got[0].devSol === 0, "a buy by someone else in the same transaction is not the dev's");
  got.length = 0;
  FH.handleTx([create as any, { ...dev, quoteMint: pk() } as any], [], { create: (c: any) => got.push(c) }, "SIG3", Date.now(), 7);
  ok(got[0].solQuote === false, "a curve quoted in another token is flagged (the rats only take SOL launches)");
  const fhSrc = fs.readFileSync(new URL("../src/lib/firehose.ts", import.meta.url), "utf8");
  ok(/evs\.some\(\(e\) => e\.kind === "create"\) && tx\.signature \? bs58\.encode\(tx\.signature\)/.test(fhSrc), "the stream encodes a signature only for transactions with a create");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/c\.solQuote !== false && c\.mint && c\.sig\) \{\s*(if \(INTAKE\.length >= INTAKE_MAX\)[^\n]*\n\s*)?INTAKE\.push\(\{ mint: c\.mint, sig: c\.sig/.test(wk), "the worker hands every firehose launch to the rats (intake marks its signature seen)");
  const dg = fs.readFileSync(new URL("../src/lib/digger.ts", import.meta.url), "utf8");
  ok(/!seen\[i\]/.test(dg) && /p\.set\(SEEN_SIG\(x\.sig\)/.test(dg), "the backfill skips any launch whose signature the intake marked");

  // ---- 5. a fast pass never hangs the lane
  const D = await import("../src/lib/digger");
  const realGet = R.get.bind(R);
  (R as any).get = () => new Promise(() => {}); // Redis that never answers
  const ta = Date.now();
  const r1: any = await D.digFast();
  (R as any).get = realGet;
  ok(r1.ok === false && /^fast pass over 0s \(at: start\)/.test(r1.error) && Date.now() - ta < 3000 && D.fastStats.timeouts === 1, `a hung pass gives up on its own (${r1.error})`);
  const lock = await R.get("rn:lock:digfast");
  ok(lock === null, "its lock is released (the next pass is not \"busy\")");
  ok(/revive\("fast", `the rats' fast lane is stuck\$\{at\}`\)/.test(wk) && /if \(my !== LOOP_GEN\.fast\) return;/.test(wk), "a stuck fast loop is restarted on its own, naming its step; the process only on a third time");

  // ---- 6. GRID LIVE: a failed read never wipes the books
  const exit = { initials: 1.5, trail: 0.25, stop: 0.25, timeMin: 60, mig: "hold" as const };
  const k1 = g.keyOf("p70+r5", "now", exit);
  const saved = [L.bookFromKey(k1, 1)!];
  await R.set("rn:gridlive:books", saved);
  L._gridLiveUnload();
  (R as any).get = async (k: string) => (k === "rn:gridlive:books" ? Promise.reject(new Error("redis down")) : realGet(k));
  ok((await L.gridLiveLoad(2, 5)) === false && !L.gridLiveLoaded(), "Redis failing at boot: the books are not taken as empty");
  const row = (i: number) => ({ key: `bond|now|2/0.25/0.25/15/sell#${i}`, filterLabel: "King BOND", filter: "bond", mode: "now", modeLabel: "at the call", exit: { ...exit, initials: 2, timeMin: 15, mig: "sell" }, test: { n: 40, avgPct: 3 }, pass: false });
  await L.gridLiveSetBooks([row(1)] as any);
  (R as any).get = realGet;
  const still: any = await R.get("rn:gridlive:books");
  ok(still.length === 1 && still[0].key === k1, "a GRID run meanwhile does not overwrite the saved books");
  await L.gridLiveSetBooks([row(2)] as any);
  const after: any = await R.get("rn:gridlive:books");
  ok(L.gridLiveLoaded() && after.some((b: any) => b.key === k1) && after.some((b: any) => b.key === row(2).key), "Redis back: the saved books are read first, the new ones join them");

  // ---- 7. lost in profit: back in the race, in slots of their own
  L.gridLiveReset();
  const tr = (k: string, pnl: number, i: number) => ({ k, mint: `m${k}${i}`, symbol: "X", openedAt: i, closedAt: i + 1, pnl, pnlPct: (pnl / 0.0525) * 100, why: "t" });
  const k2 = g.keyOf("p70+r5", "now", { ...exit, initials: 3 });
  const k3 = g.keyOf("p70+r5", "now", { ...exit, stop: 0.4 });
  const lostA = Array.from({ length: 15 }, (_, i) => tr(k2, i % 3 ? 0.04 : -0.02, i)); // 15 trips, in profit
  const lostB = Array.from({ length: 23 }, (_, i) => tr(k3, i % 3 ? 0.03 : -0.02, 100 + i)); // 23 trips, in profit
  const short = Array.from({ length: 6 }, (_, i) => tr(g.keyOf("p70", "now", exit), 0.03, 200 + i)); // too few trips
  const neg = Array.from({ length: 12 }, (_, i) => tr(g.keyOf("p35", "now", exit), i % 2 ? 0.01 : -0.02, 300 + i)); // losing
  L._setTrips([...lostA, ...lostB, ...short, ...neg] as any);
  const t = await L.gridLiveTend();
  ok(t.revived.length === 2 && t.revived[0] === k2 && t.revived[1] === k3, "the two strategies lost in profit (15 and 23 trips) come back, best record first");
  ok(!t.revived.includes(g.keyOf("p70", "now", exit)) && !t.revived.includes(g.keyOf("p35", "now", exit)), "never one with under 8 trips or one losing");
  ok(L.gridLiveBooks().filter((b) => b.back).length === 2, "marked as brought back");
  const books = await L.gridLiveSetBooks(Array.from({ length: 20 }, (_, i) => row(10 + i)) as any);
  ok(books.filter((b: any) => !b.parent && !b.by && !b.back).length === 16 && books.filter((b: any) => b.back).length === 2, "GRID still gets its 16; the revived ones have their own slots");
  // the cap
  L.gridLiveReset();
  const many = Array.from({ length: 12 }, (_, j) => Array.from({ length: 9 }, (_, i) => tr(g.keyOf("p70", "now", g.GEXITS[j]), 0.02, j * 100 + i))).flat();
  L._setTrips(many as any);
  let total = 0;
  for (let i = 0; i < 4; i++) total += (await L.gridLiveTend()).revived.length;
  ok(total === L.REVIVE_MAX && L.gridLiveBooks().filter((b) => b.back).length === L.REVIVE_MAX, `at most ${L.REVIVE_MAX} at once (4 per pass)`);

  // ---- 8. RESEARCHER without a ranked GRID row
  const RS = await import("../src/lib/researcher");
  L.gridLiveReset();
  process.env.ANTHROPIC_API_KEY = "sk-test";
  let calls = 0;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => (calls++, { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ ideas: [{ filter: "p70+r5", mode: "d15", exit: 3, why: "dips" }] }) }] }) }) as any;
  await R.set("rn:grid:view", { at: Date.now(), coins: 2000, rows: [], explore: [{ key: k1, filter: "p70+r5", mode: "now", exit, train: { n: 50 }, test: { n: 20 } }], base: [] });
  await R.set(L.LIVE_VIEW, { books: [], past: [] });
  const a: any = await RS.researchPass();
  ok(calls === 1 && a.added?.length === 1, "a GRID run with no ranked row: RESEARCHER still works from the explorers");
  await R.set("rn:grid:view", { at: null, error: "x" });
  await R.set(L.LIVE_VIEW, { books: [{ key: k1, live: { n: 12 } }], past: [] });
  const b: any = await RS.researchPass();
  ok(calls === 2 && !b.wait, "no GRID run at all but live records: it still runs");
  await R.set(L.LIVE_VIEW, { books: [], past: [] });
  const c: any = await RS.researchPass();
  ok(calls === 2 && /no GRID run or GRID LIVE record yet/.test(c.wait), "nothing to read at all: it waits (no cost)");
  (globalThis as any).fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
  ok(/prev\?\.at \? \{ \.\.\.prev, \.\.\.err \}/.test(wk), "a failed GRID run keeps the last good view (with the error next to it)");

  // ---- version
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const bld = fs.readFileSync(new URL("../src/config/build.ts", import.meta.url), "utf8");
  ok(pkg.version === bld.match(/"([0-9.]+)"/)![1], "build tag matches the package");
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
