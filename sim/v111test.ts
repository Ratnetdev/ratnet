// v0.1.111 LIVE ONLY ON PROOF: every strategy family without a passed exam moves to the ghost desk (once); it comes back
// to live money when its last 20 ghost trips pass. Run: npx tsx sim/v111test.ts
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
  const P = await import("../src/lib/pm");
  const lg = (pct: number) => Math.log(1 + pct / 100);
  // MOMO: losing (7 live trips, 14% won); KING: a record that passes (25 trips, 60% won, +8%); FLASH: already benched
  const passing = Array.from({ length: 25 }, (_, i) => lg(i % 5 < 3 ? 25 : -10));
  await R.set("rn:desk:pm", {
    momo: { r: [lg(-30), lg(-20), lg(15), lg(-25), lg(-10), lg(-5), lg(-12)], lv: [lg(-30), lg(-20), lg(15), lg(-25), lg(-10), lg(-5), lg(-12)], pausedUntil: 0, n: 7, wins: 1, v: 50 },
    king: { r: passing, pausedUntil: 0, n: 25, wins: 15, v: 50 },
    flash: { r: [], pausedUntil: 0, n: 0, wins: 0, v: 50, bench: { why: "16 Oct live record", at: 1 } },
  });
  const note = await P.benchOnce111(Date.now());
  ok(!!note && /momo/.test(note!) && !/king/.test(note!) && !/flash/.test(note!), `families without proof move to the ghost desk: ${note}`);
  const w = async (s: any) => P.sleeveWeight(s);
  ok((await w("momo")).paused && /live only on proof/.test(String((await w("momo")).bench)), "MOMO is off live money, with the reason");
  ok(!(await w("king")).paused, "a family whose record passes the exam keeps live money");
  ok(/16 Oct/.test(String((await w("flash")).bench)), "an earlier bench is left as it was");
  ok((await w("early")).paused && (await w("catch")).paused, "families with no record yet: off live money until they prove it");
  ok((await P.benchOnce111(Date.now())) === null, "once only (a family that earns its way back is not benched again)");
  // the way back: 20 ghost trips that pass the exam
  let back: string | null = null;
  for (let i = 0; i < 20; i++) back = (await P.onGhost("momo", lg(i % 5 < 3 ? 30 : -10))) || back;
  ok(/momo back on live money/.test(String(back)) && !(await w("momo")).paused, "20 ghost trips that pass: back on live money");
  const dk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/const proof = await benchOnce111\(\)/.test(dk), "the desk runs it at its next start, under its lock");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 111 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.111 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.111 checks pass");
  process.exit(fail ? 1 : 0);
})();
