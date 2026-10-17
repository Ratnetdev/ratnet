// v0.1.110 EVIDENCE SPEED: the SIGNALS family (the new rules with the best lift trade on paper in their own slots, call
// based and on every launch), every-launch books know origin / DexScreener / flow without a call, RESEARCHER is told the
// measured research. Run: npx tsx sim/v110test.ts
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
  const L = await import("../src/lib/gridlive");
  const g = await import("../src/lib/grid");
  const now = Date.now();

  // ---- 1. the family follows GRID's lift table
  L.gridLiveReset();
  L.gridLiveSignals([
    { id: "dexpaid", calls: 45, lift: 5.21 },
    { id: "alpha", calls: 426, lift: 2.11 },
    { id: "seer", calls: 131, lift: 1.79 },
    { id: "lowauto", calls: 1363, lift: 1.3 }, // under 1.5x: not taken
    { id: "kol3", calls: 3, lift: 9 }, // under 30 calls: not taken
    { id: "p70", calls: 161, lift: 13.6 }, // an old rule: GRID's own list already trades those
  ]);
  const s = L.seedSignals(now);
  const keys = s.map((b) => b.key);
  ok(s.length === 6 && s.every((b) => b.by === "signals"), `3 rules x (call + every launch): ${keys.join(", ")}`);
  ok(keys[0] === g.keyOf("dexpaid", "now", g.RUNNER_EXITS[0]) && keys[1] === `any:${g.keyOf("dexpaid", "now", g.RUNNER_EXITS[0])}`, "best lift first; a rule that needs no call also runs on every launch");
  ok(!keys.some((k) => /lowauto|kol3|p70/.test(k)), "under 1.5x, under 30 calls, or not a new rule: not taken");
  ok(L.seedSignals(now).length === 0, "seeded once");
  L.gridLiveSignals([{ id: "firstpost", calls: 60, lift: 3 }, { id: "bigfirst", calls: 40, lift: 2.5 }]);
  const s2 = L.seedSignals(now);
  ok(s2.length === 2 && s2.every((b) => !b.any), `room for 2 more (8 slots); post rules need a call: ${s2.map((b) => b.key).join(", ")}`);

  // ---- 2. every-launch books read the new signals without a call
  L.gridLiveReset();
  L._setBooks([{ key: `any:${g.keyOf("dexpaid", "now", g.RUNNER_EXITS[0])}`, label: "x", filter: "dexpaid", mode: "now", exit: g.RUNNER_EXITS[0], since: 0, grid: { testN: 0, testAvg: 0, pass: false }, any: true, by: "signals" } as any, { key: `any:${g.keyOf("kol3", "now", g.RUNNER_EXITS[0])}`, label: "y", filter: "kol3", mode: "now", exit: g.RUNNER_EXITS[0], since: 0, grid: { testN: 0, testAvg: 0, pass: false }, any: true, by: "signals" } as any]);
  L.setAnySignals((m) => (m === "PAID" ? { sx: { dx: { paid: 1, boost: 0 } }, kf: 0 } : m === "KOLS" ? { sx: {}, kf: 3 } : { sx: {}, kf: 0 }));
  for (const m of ["PAID", "KOLS", "NONE"]) {
    L.gridLiveCurve(m, { progress: 20, mcapSol: 40, realSol: 10 }, now);
    L.gridLiveCurve(m, { progress: 30, mcapSol: 50, realSol: 12 }, now + 61_000);
  }
  const pend = [...L.gridLiveState().pend.keys()];
  ok(pend.some((k) => k.includes("dexpaid") && k.endsWith("#PAID")) && pend.some((k) => k.includes("kol3") && k.endsWith("#KOLS")) && !pend.some((k) => k.endsWith("#NONE")), "a paid profile, 3 KOLs: each every-launch book takes its coin; a coin with neither is left alone");

  // ---- 3. wiring and RESEARCHER
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/gridLiveSignals\(res\.senders\?\.lifts\)/.test(wk) && /setAnySignals\(/.test(wk) && /og: originAt\(m, null, now\), dx: created \? dxLive\(m, created, now\) : null/.test(wk), "GRID's lifts feed the family; every-launch books get origin, DexScreener and flow");
  const rs = fs.readFileSync("src/lib/researcher.ts", "utf8");
  ok(/the first coin of a meme graduates ~10x more often than its copies/.test(rs) && /paid DexScreener profiles and boosts were never measured anywhere/.test(rs), "RESEARCHER is told what outside research measured (as a prior, never over our own numbers)");
  const O = await import("../src/lib/origin");
  O._originReset(true);
  O.originSee("Z", "Zed", "ZED", "creatorZ", now - 1000);
  O.originSee("Z2", "Zed two", "ZTWO", "creatorZ", now);
  ok(O.originAt("Z2", null, now)?.cr === 1 && O.originCreated("Z") === now - 1000, "origin works without the creator passed in (the index keeps it)");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 110 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.110 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.110 checks pass");
  process.exit(fail ? 1 : 0);
})();
