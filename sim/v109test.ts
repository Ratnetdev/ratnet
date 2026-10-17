// v0.1.109 IMAGE and THEME: Claude labels a call's picture and name (meme strength, theme), within a daily cap; theme
// heat from migrations; GRID rules for them; GRID LIVE reads a call again when its label lands. Also the v0.1.105 flow
// read now reaches GRID LIVE. Run: npx tsx sim/v109test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test";
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const T = await import("../src/lib/theme");
  const g = await import("../src/lib/grid");
  const now = Date.now();

  // ---- 1. the label
  ok(T.checkLabel({ meme: 82, theme: "Animal", subject: "a hippo" }, now)?.t === "animal" && T.checkLabel({ meme: 140, theme: "animal" }) === null && T.checkLabel({ meme: 50, theme: "sports" }) === null, "a label is a 0-100 score and one of 7 themes; anything else is refused");
  T._themeReset();
  let asked: any[] = [];
  const llm = async (_s: string, blocks: any[]) => ((asked = blocks), JSON.stringify({ meme: 88, theme: "animal", subject: "baby hippo" }));
  T.themeQueue({ mint: "MOO", image: "https://ipfs.io/ipfs/Qm123", name: "Moo Deng", symbol: "MOODENG", desc: "" });
  T.themeQueue({ mint: "MOO", image: "https://ipfs.io/ipfs/Qm123", name: "Moo Deng", symbol: "MOODENG", desc: "" });
  ok(T.themeStats.queue === 1, "queued once");
  let got: any = null;
  T.setOnLabel((m, l) => (got = { m, l }));
  const l = await T.themeDrain(llm as any, now);
  ok(l?.m === 88 && l?.t === "animal" && asked[0]?.type === "image" && /Moo Deng/.test(asked[1]?.text), "Claude sees the picture and the name, answers a label");
  ok(got?.m === "MOO" && ((await R.hgetall<any>("rn:th:h")) as any).MOO?.t === "animal", "the label is stored and announced");
  T.themeQueue({ mint: "MOO", image: "x", name: "x", symbol: "x", desc: "" });
  ok(T.themeStats.queue === 0, "a labelled coin is never asked again");
  // the daily cap
  process.env.THEME_PER_DAY = "1";
  T.themeQueue({ mint: "C2", image: "https://a/b", name: "Cat", symbol: "CAT", desc: "" });
  ok((await T.themeDrain(llm as any, now)) === null && T.themeStats.capped === 1 && T.themeStats.queue === 1, "over the day's cap: it waits (the queue keeps it)");
  delete process.env.THEME_PER_DAY;
  T._themeReset();
  T.themeQueue({ mint: "BAD", image: "", name: "x", symbol: "x", desc: "" });
  ok((await T.themeDrain((async () => "no json") as any, now)) === null && T.themeStats.failed === 1, "no usable answer: no label");

  // ---- 2. theme heat
  const bonds = [{ t: "animal" as const, at: now - 3600_000 }, { t: "animal" as const, at: now - 2 * 3600_000 }, { t: "animal" as const, at: now - 7 * 3600_000 }, { t: "ai" as const, at: now - 600_000 }];
  ok(T.themeHeat("animal", now, bonds) === 2 && T.themeHeat("ai", now, bonds) === 1 && T.themeHeat("animal", now - 3 * 3600_000, bonds) === 1, "heat = same-theme migrations in the 6 hours before (none after the moment)");
  T._themeReset();
  await R.hset("rn:th:h", { A1: { m: 70, t: "animal", s: "", at: now }, A2: { m: 60, t: "animal", s: "", at: now } });
  ok((await T.themeLoad()) >= 2, "labels load at boot");
  T.themeBond("A1", now - 1000);
  T.themeBond("A2", now - 2000);
  T.themeBond("NOLABEL", now);
  ok(T.themeAt("A1", now)?.heat === 2 && T.themeAt("ZZ", now) === null, "live: a labelled coin's migration heats its theme; unlabelled ones do not count");

  // ---- 3. GRID
  const ids = g.PREDS.map((p) => p.id);
  const NEW = ["meme70", "thanimal", "thpolitical", "thai", "thcelebrity", "thculture", "themehot"];
  ok(NEW.every((x) => ids.includes(x)) && ids.indexOf("meme70") > ids.indexOf("repeatpost"), "7 IMAGE and THEME rules on GRID's menu, appended");
  const pred = (id: string) => g.PREDS.find((p) => p.id === id)!;
  const moo: any = { sx: { th: { m: 88, t: "animal", heat: 3 } } };
  ok(pred("meme70").ok(moo) && pred("thanimal").ok(moo) && pred("themehot").ok(moo) && !pred("thai").ok(moo), "each rule reads the label");
  ok(NEW.every((x) => !pred(x).ok({ sx: null } as any)), "unknown never passes");
  const gs = fs.readFileSync("src/lib/grid.ts", "utf8");
  ok(/themeQueue\(\{ mint: g\.mint, image: String\(c\.image\)/.test(gs) && /heat: themeHeat\(l\.t, x\.at, bonds\)/.test(gs), "GRID queues its older calls for a label and computes heat from its window's migrations (before each call)");

  // ---- 4. GRID LIVE reads a call again when its label lands; the flow read reaches GRID LIVE
  const L = await import("../src/lib/gridlive");
  L.gridLiveReset();
  const ex = { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15, mig: "sell" as const };
  L._setBooks([{ key: g.keyOf("thanimal", "now", ex), label: "t", filter: "thanimal", mode: "now", exit: ex, since: 0, grid: { testN: 0, testAvg: 0, pass: false } } as any, { key: g.keyOf("kol3", "now", ex), label: "k", filter: "kol3", mode: "now", exit: ex, since: 0, grid: { testN: 0, testAvg: 0, pass: false } } as any]);
  L.gridLiveCurve("HIP", { progress: 30, mcapSol: 50, realSol: 10 }, now);
  L.gridLiveCall({ mint: "HIP", symbol: "HIP", at: now, createdAt: now - 300_000, verdict: "BOND", score: 90, progress: 30, tp: { kf: 4 }, sx: { post: 0 } }, now);
  const pend = () => [...L.gridLiveState().pend.keys()].filter((k) => k.includes("HIP"));
  ok(pend().length === 1 && pend()[0].startsWith("kol3"), "at the call: the kol3 book takes it (the flow read now reaches GRID LIVE); the theme book waits for the label");
  ok(L.gridLiveRelabel("HIP", { m: 80, t: "animal", heat: 0 }, now + 8_000) && pend().length === 2, "the label lands 8s later: the theme book starts its entry");
  ok(!L.gridLiveRelabel("HIP", { m: 80, t: "animal", heat: 0 }, now + 9_000), "read again once only");
  L.gridLiveCurve("OLD", { progress: 30, mcapSol: 50, realSol: 10 }, now);
  L.gridLiveCall({ mint: "OLD", symbol: "OLD", at: now, createdAt: now - 300_000, verdict: "BOND", score: 90, progress: 30, tp: {} }, now);
  ok(!L.gridLiveRelabel("OLD", { m: 80, t: "animal", heat: 0 }, now + 4 * 60_000), "a label more than 3 minutes after the call is too late to trade on");

  // ---- 5. wiring
  const ds = fs.readFileSync("src/lib/digger.ts", "utf8");
  ok(/th: themeAt\(rec\.mint, Date\.now\(\)\)/.test(ds) && /\(curveNow >= 15 \|\| kv\.verdict === "BOND" \|\| kv\.verdict === "WATCH"\)\) themeQueue/.test(ds), "calls carry the label if made; the calls GRID is most likely to test are queued");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/await themeLoad\(\)/.test(wk) && /themeDrain\(\)/.test(wk) && /\}, 6_000\);/.test(wk) && /gridLiveRelabel\(mint, th\)/.test(wk) && /themeBond\(mint, at\)/.test(wk), "labels load at boot, one every 6s, re-read the call, migrations heat themes");
  ok(/theme: themeStats/.test(wk) && /theme: rpc\?\.theme/.test(fs.readFileSync("src/lib/review.ts", "utf8")), "the counts show in the worker status and the review");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 109 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.109 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.109 checks pass");
  process.exit(fail ? 1 : 0);
})();
