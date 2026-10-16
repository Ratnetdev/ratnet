// v0.1.90: WALLETS ON EVERY LAUNCH. Proven wallets buying a launch (firehose) trigger the WALLETS family on GRID LIVE,
// no King call needed, with runner and regular exits, in their own slots. Run: npx tsx sim/v090test.ts
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
  const g = await import("../src/lib/grid");
  const L = await import("../src/lib/gridlive");
  L.gridLiveReset();
  const msgs: string[] = [];
  await L.gridLiveTend(async (t) => msgs.push(t));
  const wb = L.gridLiveBooks().filter((b) => b.by === "wallets");
  ok(wb.length === 6 && wb.every((b) => b.any && b.key.startsWith("any:")), `the WALLETS family trades on every launch (${wb.map((b) => b.key).join(", ")})`);
  ok(wb.filter((b) => g.isRunner(b.exit)).length === 4 && wb.filter((b) => !g.isRunner(b.exit)).length === 2, "4 with runner exits, 2 with regular exits");
  ok(msgs.some((m) => /proven wallets on every launch/.test(m)), "Telegram names it");
  await L.gridLiveTend(async (t) => msgs.push(t));
  ok(L.gridLiveBooks().filter((b) => b.by === "wallets").length === 6 && msgs.filter((m) => /proven wallets/.test(m)).length === 1, "seeded once");

  // two proven wallets buy a launch: the pw2 books enter on the next curve update, pw1+u25 needs 25 buyers too
  let fx: any = { pw: 2, u60: 10, bs60: 0.8, wh: 0, ds: false };
  L.setLiveFeatures(() => fx);
  const t0 = Date.now();
  const mint = "WALLETCOIN111111111111111111111111111111111";
  L.gridLiveSymbol(mint, "WAL");
  L.gridLiveCurve(mint, { progress: 20, mcapSol: 40, realSol: 5 }, t0);
  L.gridLiveCurve(mint, { progress: 30, mcapSol: 45, realSol: 6 }, t0 + 61_000);
  const st = L.gridLiveState();
  const pend = [...st.pend.values()].map((p: any) => p.key);
  ok(pend.includes(`any:${g.keyOf("pw2", "now", g.RUNNER_EXITS[0])}`) && pend.some((k) => k.startsWith("any:pw2|now|2/0.25")), "the pw2 books are entering");
  ok(!pend.some((k) => k.includes("pw1+u25")), "pw1 + 25 buyers in the last minute: not yet (10 buyers)");
  L.gridLiveCurve(mint, { progress: 31, mcapSol: 46, realSol: 6 }, t0 + 64_000);
  const pos = [...st.pos.values()].map((p: any) => p.key);
  ok(pos.some((k) => k.startsWith("any:pw2|now|")) && pos.length >= 2, `filled 2s later (${pos.length} open)`);
  fx = { ...fx, u60: 30 };
  L.gridLiveCurve(mint, { progress: 33, mcapSol: 48, realSol: 6.5 }, t0 + 70_000);
  ok([...st.pend.values()].some((p: any) => p.key.includes("pw1+u25")), "30 buyers in the last minute: pw1 + 25 buyers enters too");
  // a dev who sold is now known to every-launch rules ("dev has not sold")
  const gl = fs.readFileSync(new URL("../src/lib/gridlive.ts", import.meta.url), "utf8");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/sm: 0, ds: !!fx\?\.ds, soc: 0/.test(gl) && /ds: tapeFeatures\(m\)\.ds/.test(wk), "the dev-sold flag reaches every-launch books");
  // the exams: runner wallets books on the runner exam, regular ones on the exploring exam (45 trips)
  const rk = wb.find((b) => g.isRunner(b.exit))!;
  const regk = wb.find((b) => !g.isRunner(b.exit))!;
  ok(L.bookStat(rk, []).runner === true && L.bookStat(regk, []).runner !== true && regk.grid.explore === true, "runner books take the runner exam, regular ones the exploring exam");
  const books = await L.gridLiveSetBooks(Array.from({ length: 20 }, (_, i) => ({ key: `bond|now|2/0.25/0.25/15/sell#${i}`, filterLabel: "King BOND", filter: "bond", mode: "now", modeLabel: "at the call", exit: { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15, mig: "sell" }, test: { n: 40, avgPct: 3 }, pass: false })) as any);
  ok(books.filter((b: any) => !b.parent && !b.by && !b.back).length === 16 && books.filter((b: any) => b.by === "wallets").length === 6, "GRID keeps its 16; WALLETS has its own slots");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const bld = fs.readFileSync(new URL("../src/config/build.ts", import.meta.url), "utf8");
  ok(pkg.version === bld.match(/"([0-9.]+)"/)![1], "build tag matches the package");
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
