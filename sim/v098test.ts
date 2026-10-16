// v0.1.98: FLASH benched once on its 16 Oct live record; ghosts bring it back. Run: npx tsx sim/v098test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const pm = await import("../src/lib/pm");
  ok(/flash benched/.test((await pm.benchOnce098()) || ""), "first start: FLASH benched");
  const w: any = await pm.sleeveWeight("flash");
  ok(w.paused && /15 sells, 1 won/.test(w.bench), `the desk sends FLASH to the ghost desk (${w.bench})`);
  ok((await pm.benchOnce098()) === null, "only once (a later unbench is never undone by a restart)");
  for (let i = 0; i < 20; i++) await pm.onGhost("flash", Math.log(i % 3 === 0 ? 0.9 : 1.25));
  ok(!(await pm.sleeveWeight("flash") as any).bench, "20 passing ghost trips: back on live money");
  ok(/benchOnce098\(\)/.test(fs.readFileSync("src/lib/desk.ts", "utf8")), "the desk runs it on start");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 98 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.98 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.98 checks pass");
  process.exit(fail ? 1 : 0);
})();
