// v0.1.68: the archive survives bad rows and a full disk. Run: npx tsx sim/v068test.ts
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const { cleanStr, safeJson } = await import("../src/lib/archive");
  const cut = "rocket 🚀".slice(0, 8); // half an emoji: a lone surrogate
  ok(cleanStr(cut) === "rocket " && cleanStr("a\u0000b") === "ab", "lone surrogates and NUL characters are removed");
  ok(cleanStr("ok 🚀") === "ok 🚀", "whole emoji are kept");
  const j = safeJson({ name: cut, deep: [{ t: "x\u0000y" }] });
  ok(!/\\u0000|\\ud83d(?!\\ude)/i.test(j) && JSON.parse(j).deep[0].t === "xy", `stored JSON is clean: ${j}`);
  const fs = await import("fs");
  const ar = fs.readFileSync(new URL("../src/lib/archive.ts", import.meta.url), "utf8");
  ok(/async function insertSafe/.test(ar) && /if \(!isDataError\(e\)\) throw e;/.test(ar), "a batch refused for its content is retried row by row, bad rows dropped");
  ok(!/throw e;\n      \}\n    \}\n    for \(const \[name/.test(ar) && /fail\(e\);/.test(ar), "one table's failure no longer stops the others");
  ok(/interval '10 days'/.test(ar), "ticks kept 10 days (was 30)");
  const wk = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  ok(/setTimeout\(\(\) => archivePrune\(\)/.test(wk), "the archive prunes once at start");
  const cr = fs.readFileSync(new URL("../src/lib/critical.ts", import.meta.url), "utf8");
  ok(/redis: "Redis"/.test(cr) && /Railway: open the Redis service/.test(cr), "the Redis alert no longer says Upstash");
  const rr = fs.readFileSync(new URL("../src/app/api/runners/route.ts", import.meta.url), "utf8");
  ok(/topRunners\(400\)/.test(rr) && /cUsd \?\? 0\) >= 1500/.test(rr), "Hall of Fame: BOND calls from the top 400 runners, broken call prices left out");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version && BUILD === "0.1.68", `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
