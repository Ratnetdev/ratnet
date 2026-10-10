// v0.1.65: the King's caller is picked on the honest record. Run: npx tsx sim/v065test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const { leaderOf } = await import("../src/lib/kingcal");
  // the live record on 10 Oct: v0.3 206 BOND calls, 22 bonded; v1.1 570, 8 bonded
  const live = { "lb:v0.3:n": 206, "lb:v0.3:hit": 22, "lb:v1.1:n": 570, "lb:v1.1:hit": 8 };
  let l = leaderOf(live, "v0.3");
  ok(l.leader === "v0" && l.v0.prec === 10.7 && l.v1.prec === 1.4, `live record: ${l.why}`);
  l = leaderOf({ ...live, "lbv:v0:n": 120, "lbv:v0:hit": 9, "lbv:v1:n": 200, "lbv:v1:hit": 30 }, "v0.3");
  ok(l.leader === "v1" && l.v1.n === 200, `v1 earns it back on the fresh side-by-side record: ${l.why}`);
  l = leaderOf({ "lb:v0.3:n": 206, "lb:v0.3:hit": 22, "lbv:v1:n": 100, "lbv:v1:hit": 50 }, "v0.3");
  ok(l.leader === "v0", `too few v1 calls graded: ${l.why}`);
  l = leaderOf({ "lbv:v0:n": 30, "lbv:v0:hit": 3, "lb:v0.3:n": 206, "lb:v0.3:hit": 22 }, "v0.3");
  ok(l.v0.n === 236 && l.v0.hit === 25, "until the fresh record is big enough, it adds to the old per-version record");
  const fs = await import("fs");
  const dg = fs.readFileSync(new URL("../src/lib/digger.ts", import.meta.url), "utf8");
  ok(/const v1 = v1c && LEAD\?\.leader === "v1" \? v1c : null;/.test(dg), "v1 makes the call only while it leads");
  ok(/rec\.call\.v0\?\.verdict === "BOND"\) \{\n      inc\(c, "lbv:v0:n"\)/.test(dg) && /rec\.call\.v1v === "BOND"\) \{\n      inc\(c, "lbv:v1:n"\)/.test(dg), "both verdicts graded on every counted call");
  const dk = fs.readFileSync(new URL("../src/lib/desk.ts", import.meta.url), "utf8");
  ok(/rule: "king_or_nano_bond", ok: rec\.call!\.verdict === "BOND",/.test(dk), "the desk takes the King's verdict only (no nano-only BOND)");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
