// v0.1.77: records panel with two menus (desk, trades) and GRID LIVE inside it. Run: npx tsx sim/v077test.ts
import fs from "fs";
import { BUILD } from "../src/config/build";
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
const tr = fs.readFileSync(new URL("../src/components/TrackRecord.tsx", import.meta.url), "utf8");
const gl = fs.readFileSync(new URL("../src/components/GridLiveBoard.tsx", import.meta.url), "utf8");
const db = fs.readFileSync(new URL("../src/components/DeskBoard.tsx", import.meta.url), "utf8");
ok(/useState<"desk" \| "ghost" \| "grid">/.test(tr) && /useState<"all" \| "open" \| "closed">/.test(tr), "two separate states: desk and trades");
ok(!/"ghost"\] as const\)\.map/.test(tr) && /\["grid", "grid live"\]/.test(tr), "desk menu: paper/live, ghost, grid live");
ok(/show === "all" \? true : show === "open" \? t\.open : !t\.open/.test(tr), "open/closed filter applies to the chosen desk");
ok(/isGrid \? null : fullUrl/.test(tr), "no record request while GRID LIVE is shown");
ok(/<GridLiveBoard embedded show=\{show\} \/>/.test(tr), "GRID LIVE renders inside the records panel");
ok(/function Trades\(/.test(gl) && /show === "closed" \? \[\]/.test(gl) && /show === "open" \? \[\]/.test(gl), "GRID LIVE trades follow the open/closed menu");
ok(!/<GridLiveBoard \/>/.test(db), "no separate GRID LIVE panel on the desk page");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
ok(BUILD === pkg.version, `build tag ${BUILD}`);
console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
