// v0.1.57: a hung background loop restarts on its own; the third hang in 30 minutes restarts the worker. Run: npx tsx sim/v057test.ts
import { readFileSync } from "fs";
import { reviveAllowed } from "../src/lib/revive";
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const t = Date.now();
let r = reviveAllowed([], t);
ok(r.ok && r.recent.length === 1, "first hang: only that loop restarts");
r = reviveAllowed(r.recent, t + 60_000);
ok(r.ok && r.recent.length === 2, "second hang within 30 minutes: still only that loop");
r = reviveAllowed(r.recent, t + 120_000);
ok(!r.ok, "third hang within 30 minutes: the worker restarts");
ok(reviveAllowed([t, t + 60_000], t + 31 * 60_000).ok, "hangs older than 30 minutes are forgotten");
const w = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
ok(/the desk loop is stuck[^\n]*\n/.test(w) && /deskStuck > DESK_MS \+ 180_000\) return restart/.test(w), "the desk still restarts the whole worker (money first)");
ok(/!revive\("agents"/.test(w) && /!revive\("slow"/.test(w) && /!revive\("hist"/.test(w), "agents, the rats' slow lane and the historian restart on their own");
ok((w.match(/if \(my !== LOOP_GEN\.\w+\) return;/g) || []).length === 3, "an abandoned copy of a loop stops at its next pass");
console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.57 checks passed");
process.exit(fail ? 1 : 0);
