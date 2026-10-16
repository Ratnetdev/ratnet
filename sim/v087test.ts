// v0.1.87: fix before building. Each lane keeps its own room in the day's chain budget; launches quoted in another
// token (ZEC, PUMP) are never called or traded; every live fill sits next to what paper would have booked; the
// worker's event-loop delay on /status; PumpPortal's refused trade stream replaced by the firehose (the live tape for
// CATCH and SHIELD, FLASH on every launch); LENS keeps under the X budget. Run: npx tsx sim/v087test.ts
process.env.RPC_CALLS_PER_DAY = "100000";
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
  const bs58 = (await import("bs58")).default;
  const S = await import("../src/lib/solana");

  // ---- 1. lanes keep their own room
  const day = new Date().toISOString().slice(0, 10);
  const P = S.budgetState().pace;
  // 16 Oct: the rats spent the morning, the agents made ~1,200 reads all day
  S.seedDayUsed(day, Math.round(P * 1.0), [Math.round(P * 0.12), Math.round(P * 0.83), Math.round(P * 0.003), Math.round(P * 0.03)]);
  ok(S.laneOpen(2), "the day is at pace, the agents used almost nothing: they read (their own floor)");
  ok(S.laneOpen(3), "the historian under its own floor reads too");
  ok(S.laneOpen(1) || P * 1.05 * S.RATS_MAX <= P * 0.83, "the rats stop at their share of the line");
  S.seedDayUsed(day, Math.round(P * 1.01), [Math.round(P * 0.1), Math.round(P * 0.85), Math.round(P * 0.04), Math.round(P * 0.02)]);
  ok(!S.laneOpen(1), `the rats past ${Math.round(S.RATS_MAX * 100)}% of the line: paused, the other lanes keep their part`);
  ok(S.laneOpen(0), "the desk always reads");
  S.seedDayUsed(day, Math.round(P * 1.02), [Math.round(P * 0.1), Math.round(P * 0.7), Math.round(P * 0.15), Math.round(P * 0.07)]);
  ok(!S.laneOpen(2) && !S.laneOpen(3), "past pace and past their own floors: the agents and the historian wait");
  S.seedDayUsed(day, 100_001, [0, 100_001, 0, 0]);
  // v0.1.101: the rats' line is pace x 1.05 by design, so late in the UTC day (pace near the whole budget) they may still
  // read up to that line; the test ran green only before ~21:00 UTC
  const bst = S.budgetState();
  ok(!S.laneOpen(2) && !S.laneOpen(3) && (!S.laneOpen(1) || bst.used < bst.pace * 1.05) && S.laneOpen(0), "the whole day's budget used: only the desk (the rats up to their line)");
  ok(Array.isArray(S.budgetState().lanes) && S.budgetState().lanes.length === 4, "the lanes' counts are part of the budget view");
  const rd = fs.readFileSync(new URL("../src/lib/rpcday.ts", import.meta.url), "utf8");
  ok(/seedDayUsed\(d, sum\(v\), LANES\.map/.test(rd), "a restart carries each lane's count for the day");

  // ---- 2. launches quoted in another token
  const PE = await import("../src/lib/pumpevents");
  const enc = (fields: Buffer[]) => Buffer.concat([Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]), ...fields]);
  const str = (s: string) => {
    const b = Buffer.from(s, "utf8");
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    return Buffer.concat([l, b]);
  };
  const key = (k: string) => Buffer.from(bs58.decode(k));
  const u64 = (n: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b;
  };
  const ZEC = pk();
  const mint = pk();
  const creator = pk();
  const base = [str("ZECRET"), str("ZECRET"), str("https://x/z.json"), key(mint), key(pk()), key(creator), key(creator), u64(1_760_000_000n), u64(1n), u64(1n), u64(1n), u64(1_000_000_000_000_000n)];
  const ev: any = PE.decodeEvent(enc([...base, key(pk()), Buffer.from([0]), Buffer.from([0]), key(ZEC), u64(1n), u64(0n), Buffer.from([0]), Buffer.from([0])]));
  ok(ev?.kind === "create" && ev.quoteMint === ZEC && ev.mint === mint, "a create's quote mint is read (ZEC)");
  const old: any = PE.decodeEvent(enc(base));
  ok(old?.kind === "create" && !old.quoteMint, "an older, shorter create: no quote mint (SOL)");
  const FH = await import("../src/lib/firehose");
  const got: any[] = [];
  const other: string[] = [];
  FH.handleTx([ev], [], { create: (c: any) => got.push(c), otherQuote: (m: string) => other.push(m) }, "SIGZ", Date.now(), 1);
  ok(got[0]?.solQuote === false && FH.fireStats.otherQuoteCreates === 1, "the firehose flags the launch as not SOL");
  FH.handleTx([{ kind: "trade", mint, sol: 1n, tokens: 1n, isBuy: true, user: pk(), ts: 1, vSol: 1n, vTok: 1n, rSol: 1n, rTok: 1n, quoteMint: ZEC } as any], [], { otherQuote: (m: string) => other.push(m) }, undefined, Date.now(), 2);
  ok(other[0] === mint && FH.fireStats.otherQuote === 1, "a trade in another quote marks the coin");
  const SL = await import("../src/lib/streamlog");
  SL.logCreate(mint, creator, Date.now(), 0, 0, true);
  SL.noteOtherQuote(mint);
  ok(SL.isOtherQuote(mint) && SL.streamLog(mint, Date.now()) === null, "its log is dropped (no empty tape for the King)");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/if \(c\.solQuote === false\) \{\s*noteOtherQuote\(c\.mint\);[\s\S]{0,80}\} else \{\s*logCreate/.test(wk) && /otherQuote: \(mint\) => noteOtherQuote\(mint\)/.test(wk), "the worker logs only SOL launches from birth");
  const dg = fs.readFileSync(new URL("../src/lib/digger.ts", import.meta.url), "utf8");
  ok(/!otherQuote\(it\.mint, curves\[it\.mint\]\)\);/.test(dg) && /inc\(c, "calls_other_quote"\)/.test(dg) && /isOtherQuote\(mint\) \|\| \(!!cv && !cv\.complete && !\(cv\.priceSol > 0\)\)/.test(dg), "the rats never call one (marked by the firehose, or a curve with no SOL price)");
  const curve = Buffer.alloc(151);
  curve.writeBigUInt64LE(1_000_000_000_000_000n, 8);
  curve.writeBigUInt64LE(40_000_000_000n, 16);
  curve.writeBigUInt64LE(500_000_000_000_000n, 24);
  curve.writeBigUInt64LE(10_000_000_000n, 32);
  curve.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  key(ZEC).copy(curve, 83);
  const v = S.viewCurve(S.parseCurve(curve)!);
  ok(v.priceSol === 0 && v.progress > 0, "a ZEC curve read from the chain has progress but no SOL price (the rats' second check)");

  // ---- 3. live fills next to paper
  const desk = fs.readFileSync(new URL("../src/lib/desk.ts", import.meta.url), "utf8");
  ok(/par = \{ tok: Math\.round\(\(tokens \/ modelTok - 1\) \* 1000\) \/ 10/.test(desk) && /par = \{ out: Math\.round\(\(proceeds \/ model - 1\) \* 1000\) \/ 10/.test(desk), "every live buy and sell keeps the gap to what paper would have booked");
  const db = fs.readFileSync(new URL("../src/components/DeskBoard.tsx", import.meta.url), "utf8");
  ok(/function LiveParity/.test(db) && /<LiveParity trades=/.test(db), "the live panel shows it");

  // ---- 4. event-loop delay
  const LL = await import("../src/lib/looplag");
  ok(LL.loopLag() === null, "not measured until started");
  LL.startLoopLag();
  await new Promise((r) => setTimeout(r, 120));
  const lag = LL.loopLag();
  ok(!!lag && Number.isFinite(lag.p50) && Number.isFinite(lag.p99) && lag.max >= lag.p50, `measured (p50 ${lag?.p50}ms, p99 ${lag?.p99}ms)`);
  ok(/loop: lag/.test(wk) && /event loop late by/.test(fs.readFileSync(new URL("../src/components/StatusBoard.tsx", import.meta.url), "utf8")), "on /status next to the worker");

  // ---- 5. PumpPortal and the firehose
  ok(/if \(add\.length && PP_KEY && pp\) ws\.send/.test(wk), "PumpPortal's trade stream is asked only while the firehose is down");
  ok(/if \(watched\.has\(t\.mint\) \|\| rtWanted\(t\.mint\)\) TAPE_IN\(/.test(wk) && /for \(const m of ms\) RT_ASKED\.set\(m, now\)/.test(wk), "the firehose feeds the live tape CATCH and SHIELD read");
  ok(/const flashAll = \(\) => fireLive\(\) && bwLevel\(\) < 1;/.test(wk) && /fl\.trades\.push\(\{ t: t\.at/.test(wk) && /if \(!FLW\.has\(mint\)\) FLW\.set/.test(wk), "FLASH watches every launch from the firehose (PumpPortal never overwrites its watch)");
  const lens = fs.readFileSync(new URL("../src/lib/lens.ts", import.meta.url), "utf8");
  ok(/xAllowed\(0\.7(, true)?\)/.test(lens), "LENS stops at 70% of the hour's X budget");

  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const bld = fs.readFileSync(new URL("../src/config/build.ts", import.meta.url), "utf8");
  ok(pkg.version === bld.match(/"([0-9.]+)"/)![1], "build tag matches the package");
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
