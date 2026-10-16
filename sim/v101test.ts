// v0.1.101 SIGNAL PIPE: the social agents' reads reach GRID and GRID LIVE as rules. Run: npx tsx sim/v101test.ts
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
  const ids = g.PREDS.map((p) => p.id);
  const NEW = ["post", "bigpost", "pulse", "lens60", "xf5k", "tg500", "kol2", "ftop", "mindpass", "mindwatch"];
  ok(NEW.every((x) => ids.includes(x)) && ids.indexOf("post") > ids.indexOf("wh"), "10 social rules on GRID's menu, appended after the old ones");
  const blank: any = { sx: null };
  ok(g.PREDS.filter((p) => NEW.includes(p.id)).every((p) => !p.ok(blank)), "unknown never passes");
  const pred = (id: string) => g.PREDS.find((p) => p.id === id)!;
  const live: any = { sx: { post: 1, bigpost: 1, pulse: 0, lens: 72, xf: 8000, tg: 300, kol: 3, ftop: 0, mind: "WATCH" } };
  ok(pred("post").ok(live) && pred("bigpost").ok(live) && !pred("pulse").ok(live) && pred("lens60").ok(live) && pred("xf5k").ok(live) && !pred("tg500").ok(live) && pred("kol2").ok(live) && !pred("ftop").ok(live) && pred("mindwatch").ok(live) && !pred("mindpass").ok(live), "each rule reads its field");
  // history: older calls get post/pulse from the archived launch; a CA posted is never counted (it may come later)
  const h1 = g.sxOf({ at: 1 }, { h: "a", how: "links the post", f: 130148 }, { term: "x" });
  ok(h1?.post === 1 && h1?.bigpost === 1 && h1?.pulse === 1 && h1?.lens === null && h1?.kol === null, "older calls: post, big post and pulse from the archive; the rest unknown");
  const h2 = g.sxOf({ at: 1 }, { h: "a", how: "posted the CA", f: 1 }, null);
  ok(h2?.post === 0 && h2?.bigpost === 0, "older calls: a CA post is not counted (no look ahead)");
  ok(g.sxOf({ at: 1, sx: live.sx })?.lens === 72, "new calls carry their own read");
  // live: the read at the call
  const dg = await import("../src/lib/digger");
  const rec: any = { mint: "M", wire: { how: "posted the CA", f: 10 }, pulse: null };
  const s = dg.sxAt(rec, { lens: null, xf: null, tg: null, kol: 0, ftop: 1, mind: null });
  ok(s.post === 1 && s.bigpost === 1 && s.pulse === 0 && s.kol === 0 && s.ftop === 1 && s.lens === null, "live: a CA posted before minute 5 counts; HOUND's empty book reads as 0 buys");
  ok(dg.sxAt({ mint: "N" } as any, null).kol === null, "live: no HOUND read at all stays unknown");
  const src = fs.readFileSync("src/lib/digger.ts", "utf8");
  ok(/sx: sxAt\(rec, SX_IN\.get\(rec\.mint\)\)/.test(src) && /SX_IN\.set\(m, await socialRead\(m\)/.test(src), "every King call stores the read (made before the calls, no reads inside makeCall)");
  ok(/data->'wire' as wire, data->'pulse' as pulse/.test(fs.readFileSync("src/lib/grid.ts", "utf8")), "GRID loads the archived wire and pulse for older calls");
  ok(/sx: call\.sx \?\? null/.test(fs.readFileSync("src/lib/gridlive.ts", "utf8")), "GRID LIVE books filter on the same read live");
  ok(/PREDS\.map\(\(p\) => `\$\{p\.id\}: \$\{p\.label\}`\)/.test(fs.readFileSync("src/lib/researcher.ts", "utf8")), "RESEARCHER's menu lists them");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 101 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.101 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.101 checks pass");
  process.exit(fail ? 1 : 0);
})();
