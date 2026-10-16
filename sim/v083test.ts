// v0.1.83: RESEARCHER reads its ideas wherever they sit in the answer. Run: npx tsx sim/v083test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const RS = await import("../src/lib/researcher");
  const fs = await import("fs");
  const idea = { ideas: [{ filter: "p70+r5", mode: "d15", exit: 3, why: "dips {often} recover, \"see\" the test" }] };
  const J = JSON.stringify(idea);
  ok(RS.extractIdeas(J)?.ideas.length === 1, "plain JSON");
  ok(RS.extractIdeas(`Looking at the data: p70+r5 {near migration} holds up. The rule {filter, mode} works.\n\n${J}`)?.ideas[0].why === idea.ideas[0].why, "prose with braces before it, braces and quotes inside a reason");
  ok(RS.extractIdeas("```json\n" + JSON.stringify(idea, null, 2) + "\n```\nThat is all.")?.ideas[0].exit === 3, "a fenced, indented block with text after it");
  ok(RS.extractIdeas(`Some thinking {"ideas": [ {"filter": "p70"`) === null, "an answer cut off: null (logged, no books)");
  ok(RS.extractIdeas(`{"note":"x"} then ${J}`)?.ideas.length === 1, "another object first");
  const src = fs.readFileSync(new URL("../src/lib/researcher.ts", import.meta.url), "utf8");
  ok(/brief\(gridOk \? grid : null, live, seen, room(, desk)?\) \}\], 4000, 180_000, model\(\)\)/.test(src), "room to think: 4,000 tokens");
  ok(/head: text \? text\.slice\(0, 600\)/.test(src), "a failed answer is kept (start and end) in Redis for the next fix");
  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
