// v0.1.92: tapes say why they came from the chain (and who asked), the chain backfill skips launches quoted in
// another token, and GRID lets the worker breathe after every exit. Run: npx tsx sim/v092test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const SL = await import("../src/lib/streamlog");
  const T = await import("../src/lib/tape");
  const now = Date.now();
  SL.logTrade({ mint: "X", w: "a", buy: true, sol: 1, tok: 1 }); // trades flowing
  ok(T.tapeFromStream("NOLOG", "c", now - 60_000, undefined, now) === null && T.tapeStats.noLog === 1, "no log for the coin: counted as no log");
  SL.logCreate("PP", "c", now - 60_000, 1, 1, false);
  ok(T.tapeFromStream("PP", "c", now - 60_000, undefined, now) === null && T.tapeStats.notFull === 1, "a log not complete from birth: counted");
  SL.logCreate("FULL", "c", now - 60_000, 0, 0, true);
  ok(T.tapeFromStream("FULL", "c", now - 30_000, undefined, now) === null && T.tapeStats.t0 === 1, "create time 30s off: counted");
  ok(T.tapeFromStream("FULL", "c", now - 60_000, undefined, now)?.src === "stream", "the right create time: a stream tape");
  ok(T.tapeFromStream("OLD", "c", now - 9 * 60_000, undefined, now) === null && T.tapeStats.old === 1, "older than the log window: counted as old");
  const S = await import("../src/lib/solana");
  let tag = "";
  (globalThis as any).__rnConn = { getSignaturesForAddress: async () => ((tag = S.rpcTag.getStore() || ""), []) };
  await S.tagged("wire", () => T.readTape("So11111111111111111111111111111111111111112", "c", now - 60_000));
  ok(tag === "wire+tape" && T.tapeStats.chain >= 1, `a chain tape keeps who asked for it (${tag})`);
  await T.readTape("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "c", now - 60_000);
  ok(tag === "tape", "no caller: plain tape");
  const dg = fs.readFileSync(new URL("../src/lib/digger.ts", import.meta.url), "utf8");
  const D = await import("../src/lib/digger");
  await D.markSigsSeen(["SIGA", "SIGB"]);
  ok((await R.get("rn:sig:SIGA")) === 1 && (await R.get("rn:sig:SIGB")) === 1 && /!seen\[i\]/.test(dg), "creates in another quote are marked seen: the backfill skips them");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/if \(c\.sig\) OTHER_SIGS\.push\(c\.sig\);/.test(wk) && /markSigsSeen\(s\)/.test(wk) && /tapes: tapeStats/.test(wk), "the worker marks them and reports the tape sources");
  const gr = fs.readFileSync(new URL("../src/lib/grid.ts", import.meta.url), "utf8");
  ok(!/if \(x % 6 === 0\) await breathe\(\);/.test(gr), "GRID breathes after every exit");
  const st = fs.readFileSync(new URL("../src/components/StatusBoard.tsx", import.meta.url), "utf8");
  ok(/tapes since start:/.test(st), "/status shows where tapes came from");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const bld = fs.readFileSync(new URL("../src/config/build.ts", import.meta.url), "utf8");
  ok(pkg.version === "0.1.92" && bld.includes('"0.1.92"'), "v0.1.92");
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
