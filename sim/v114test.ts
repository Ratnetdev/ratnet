// v0.1.114 PROFIT SCORE: the same combination of every rule, its target the trade itself (buy at the call, the first
// runner exit, money made after every cost) instead of the migration. Run: npx tsx sim/v114test.ts
import type { GCoin } from "../src/lib/grid";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
let seed = 21;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function coin(i: number, steps: number[], f: Partial<GCoin> = {}): GCoin {
  const n = steps.length + 1;
  const t = new Int32Array(n), mc = new Float32Array(n), real = new Float32Array(n), prog = new Float32Array(n), done = new Uint8Array(n);
  let px = 30;
  for (let k = 0; k < n; k++) {
    if (k) px *= 1 + steps[k - 1];
    t[k] = k * 60_000;
    mc[k] = px;
    real[k] = Math.max(1, px - 25);
    prog[k] = Math.min(99, Math.max(0, (px - 28) * 1.2));
  }
  return { mint: `M${i}`, symbol: `S${i}`, at: 1_790_000_000_000 + i * 60_000, createdAt: 1_790_000_000_000 + i * 60_000 - 90_000, verdict: "WATCH", score: 50, nano: 40, progress: prog[0], rise60: 2, uniq: 15, spb: 0.2, bs: 0.3, sn: 5, sm: 0, ds: false, soc: 0, t, mc, real, prog, done, ...f };
}
const walk = () => Array.from({ length: 80 }, () => (rnd() - 0.52) * 0.08);
const run = () => [...Array.from({ length: 20 }, () => 0.07 + rnd() * 0.05), ...Array.from({ length: 50 }, () => (rnd() - 0.5) * 0.03)];

(async () => {
  const fs = await import("fs");
  const g = await import("../src/lib/grid");
  // a world where the migration and the profit disagree: "near migration" (p70 via the curve) coins migrate but are
  // already priced (they drift), while a social link (soc) marks the coins that still run
  const world: GCoin[] = [];
  for (let i = 0; i < 3000; i++) {
    const near = rnd() < 0.2, soc = rnd() < 0.2;
    const runs = soc && rnd() < 0.55;
    world.push(coin(i, runs ? run() : walk(), { soc: soc ? 1 : 0, sm: near ? 1 : 0, bonded: near ? rnd() < 0.5 : rnd() < 0.02 }));
  }
  const v = await g.runGrid(world, { nulls: 0 });
  ok(!!v.score.model && v.score.model.ids.includes("sm"), "GRID SCORE (migration) leans on the coins that migrate");
  ok(!!v.pscore.model && (v.pscore.test?.auc ?? 0) > 0.55, `PROFIT SCORE is fitted on the trades and ranks the newer calls (AUC ${v.pscore.test?.auc})`);
  const pw = (id: string) => v.pscore.model!.w[v.pscore.model!.ids.indexOf(id)];
  ok(v.pscore.model!.ids.includes("soc") && pw("soc") > 0.5, `the profit score finds what pays (a social link: odds ${Math.exp(pw("soc")).toFixed(2)}x)`);
  ok((v.pscore.test?.top20.avgPct ?? -99) > (v.pscore.test?.avgPct ?? 0), `on the newer calls its top 20% beat the average trade (${v.pscore.test?.top20.avgPct}% vs ${v.pscore.test?.avgPct}%)`);
  ok(v.pscore.ref === g.keyOf("all", "now", g.RUNNER_EXITS[0]), `its reference trade: ${v.pscore.ref}`);
  ok(g.PREDS.some((p) => p.id === "pscore10") && g.PREDS.some((p) => p.id === "pscore20") && g.SCORE_RULES.has("pscore10"), "pscore10 / pscore20 on GRID's menu (left out of the score's own inputs and the lift table)");
  ok(!v.senders.lifts.some((l: any) => /score/.test(l.id)), "no score rule in the senders lift table (in-sample)");
  // the live family: the profit score's bands first
  const L = await import("../src/lib/gridlive");
  L.gridLiveReset();
  g.setWinModel(null); // v0.1.115: the WIN SCORE goes before it (v115test)
  const s1 = L.seedScore(Date.now());
  ok(s1.length >= 2 && s1[0].key.startsWith("pscore10") && s1[1].key.startsWith("pscore20"), `the SCORE family trades the profit score's bands first (${s1.map((b) => b.key.split("|")[0]).join(", ")})`);
  g.setProfitModel({ ...v.pscore.model!, auc: 0.5 });
  L.gridLiveReset();
  ok(!L.seedScore(Date.now()).some((b) => b.key.startsWith("pscore")), "a profit score no better than a coin flip: not traded");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/setProfitModel\(v\?\.pscore\?\.model\)/.test(wk), "the worker loads the last profit score at boot");
  ok(/PROFIT SCORE/.test(fs.readFileSync("src/lib/review.ts", "utf8")), "the daily review shows it");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 114 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.114 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.114 checks pass");
  process.exit(fail ? 1 : 0);
})();
