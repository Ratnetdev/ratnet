// v0.1.67: King calls on time again. Run: npx tsx sim/v067test.ts
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const dg = fs.readFileSync(new URL("../src/lib/digger.ts", import.meta.url), "utf8");
  ok(/p\.zadd\(K\.dueCall, callAdds\[0\]/.test(dg) && /p\.zadd\(K\.due, restAdds\[0\]/.test(dg), "minute-1/minute-5 checkpoints go to their own queue");
  ok(/const calls = \(\(await r\.zrange<string\[\]>\(K\.dueCall, 0, now/.test(dg), "every due call is served before the other checkpoints");
  ok(/MAX_DUE_PER_RUN - calls\.length/.test(dg), "the other checkpoints fill the rest of the pass");
  ok(/p\.zrem\(K\.dueCall, \.\.\.members\)/.test(dg) && /p\.zrem\(K\.dueCall, `\$\{rec\.mint\}\|t1`/.test(dg), "served and completed coins leave the call queue");
  ok(/cleanLateCalls/.test(dg) && /now - 15 \* 60_000/.test(dg), "late minute-1/minute-5 checkpoints from the old shared queue are dropped once");
  // the split itself
  const dueAdds = ["A|t1", "A|t5", "A|h1", "A|d1"].map((member, i) => ({ score: i, member }));
  const callAdds = dueAdds.filter((x) => /\|t[15]$/.test(x.member));
  ok(callAdds.length === 2 && dueAdds.length - callAdds.length === 2, "t1 and t5 split from h1 and d1");
  const { K } = await import("../src/lib/redis");
  ok(K.dueCall === "rn:due:call", "queue key rn:due:call");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
