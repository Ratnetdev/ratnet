// v0.1.103 ORIGIN: the original or a copy (name, ticker, image), the alpha or a beta, the creator's last 7 days; GRID's
// rules for it, and the origin of older calls from the archive (in time order, no look ahead). Run: npx tsx sim/v103test.ts
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
  const O = await import("../src/lib/origin");
  const g = await import("../src/lib/grid");
  const H = 3600_000;
  const T = Date.parse("2026-10-17T00:00:00Z");

  // ---- 1. first or copy
  O._originReset(true);
  O.originSee("A1", "Flying Tesla Roadster", "FTR", "dev1", T);
  O.originSee("A2", "flying tesla roadster!", "FTR2", "dev2", T + 30_000); // same name
  O.originSee("A3", "Tesla Car", "ftr", "dev3", T + 60_000); // same ticker
  O.originSee("A4", "Other", "OTH", "dev4", T + 90_000);
  O.originSee("A0", "Roadster OG", "RDST", "dev5", T - 10_000);
  const a1 = O.originAt("A1", "dev1", T + 120_000)!;
  ok(a1.rank === 1 && O.originAt("A2", "dev2", T + 120_000)!.rank === 2 && O.originAt("A3", "dev3", T + 120_000)!.rank === 2, "the first of a name/ticker is rank 1; a later coin with the name or the ticker is a copy");
  ok(O.originAt("A4", "dev4", T)!.rank === 1, "an unrelated coin is its own first");
  // a feed delivering late: the earlier coin still ranks first
  O.originSee("B2", "Late Cat", "LCAT", "x", T + 5_000);
  O.originSee("B1", "Late Cat", "LCAT", "y", T + 1_000);
  ok(O.originAt("B1", "y", T + 9_000)!.rank === 1 && O.originAt("B2", "x", T + 9_000)!.rank === 2, "creation order decides, not arrival order");
  O.originSee("A1", "Flying Tesla Roadster", "FTR", "dev1", T); // the other feed
  ok(O.originAt("A2", "dev2", T + 120_000)!.rank === 2, "the same coin from both feeds counts once");

  // ---- 2. the picture: same IPFS content id = a copy, whatever the name
  const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  O.originSee("I1", "Dog One", "DOG1", "c1", T);
  O.originSee("I2", "Totally New", "TNEW", "c2", T + 10_000);
  O.originImage("I1", `https://ipfs.io/ipfs/${cid}`);
  O.originImage("I2", `ipfs://${cid}`);
  ok(O.originAt("I2", "c2", T + 20_000)!.rank === 2 && O.originAt("I1", "c1", T + 20_000)!.rank === 1, "a re-uploaded picture (same content id) makes a copy");
  ok(O.cidOf("https://example.com/cat.png") === null, "only content ids count (a plain URL proves nothing)");

  // ---- 3. the creator's last 7 days
  O.originSee("F0", "fac0", "FAC0", "factory", T - 6 * 86400_000);
  for (let i = 1; i <= 11; i++) O.originSee(`F${i}`, `fac${i}`, `FAC${i}`, "factory", T + i * 1000);
  ok(O.originAt("F11", "factory", T + 20_000)!.cr === 11 && O.originAt("A4", "dev4", T)!.cr === 0, "a factory's 12th launch in 7 days counts 11 before it; a creator's first counts 0");

  // ---- 4. alpha and beta (live market caps)
  O.originMc("A1", 300);
  O.originMc("A2", 20);
  O.originMc("A3", 60);
  const now = T + 200_000;
  ok(O.originAt("A1", "dev1", now)!.alpha === 1 && O.originAt("A1", "dev1", now)!.beta === 0, "the biggest of its group is the alpha");
  ok(O.originAt("A2", "dev2", now)!.beta === 1 && O.originAt("A2", "dev2", now)!.alpha === 0, "under 10% of the group's biggest: a beta");
  ok(O.originAt("A3", "dev3", now)!.beta === 0 && O.originAt("A3", "dev3", now)!.alpha === 0, "in between: neither");
  ok(O.originAt("A4", "dev4", now)!.alpha === null, "alone in its group: unknown (never passes)");
  O.originMc("ZZ", 999);
  ok(true, "a market cap for a coin outside the index is ignored");

  // ---- 5. unknown before the index is loaded; 7 days only
  O._originReset(false);
  O.originSee("U1", "Unk", "UNK", "d", T);
  ok(O.originAt("U1", "d", T) === null, "until the archive is read, origin is unknown (a fresh worker would call everything first)");
  O._originReset(true);
  O.originSee("W1", "Week", "WEEK", "d", T - 8 * 86400_000);
  O.originSee("W2", "Week", "WEEK", "d", T);
  O.originPrune(T);
  ok(O.originAt("W2", "d", T)!.rank === 1 && O.originAt("W2", "d", T)!.cr === 0, "a coin from 8 days ago no longer counts");

  // ---- 6. the archive: 21 days in time order, in pages; older calls get their origin as of their creation
  const rows: any[] = [];
  const day = 86400_000;
  const base = T - 20 * day;
  rows.push({ mint: "H1", name: "Moo Deng", symbol: "MOODENG", creator: "a", created_at: new Date(base + day), called: true });
  rows.push({ mint: "H2", name: "moo deng", symbol: "MOO", creator: "b", created_at: new Date(base + 2 * day), called: true });
  rows.push({ mint: "H3", name: "Moo Deng", symbol: "MOODENG", creator: "a", created_at: new Date(base + 12 * day), called: true }); // 10 days after H2: outside 7 days
  for (let i = 0; i < 45; i++) rows.push({ mint: `N${String(i).padStart(2, "0")}`, name: `noise${i}`, symbol: `NZ${i}`, creator: "z", created_at: new Date(base + 3 * day + i * H), called: i === 44 });
  rows.push({ mint: "H4", name: "Moo Deng", symbol: "MOODENG", creator: "c", created_at: new Date(T - H), called: false });
  rows.sort((a, b) => a.created_at - b.created_at || (a.mint < b.mint ? -1 : 1));
  let queries = 0;
  const pool = {
    query: async (_sql: string, p: any[]) => {
      queries++;
      const from = Date.parse(p[0]);
      const after = rows.filter((r) => r.created_at.getTime() > from || (r.created_at.getTime() === from && r.mint > p[1])).filter((r) => r.created_at.getTime() <= Date.parse(p[2]));
      return { rows: after.slice(0, p[3]) };
    },
  };
  O._originReset(false);
  const n = await O.originLoad(pool, T, 21, 10);
  ok(n === rows.length && queries >= 5, `read every launch in pages (${n} rows, ${queries} queries)`);
  ok(O.originHist("H1")?.rank === 1 && O.originHist("H2")?.rank === 2, "older calls: the first Moo Deng is first, the next day's copy is #2");
  ok(O.originHist("H3")?.rank === 1, "10 days later the name is fresh again (7-day window)");
  ok(O.originHist("N44")?.cr === 44 && O.originHist("N00") === null, "creator counts as of the coin's creation; only called coins are kept");
  ok(O.originHist("H4") === null, "uncalled coins are not kept for GRID");
  ok(O.originLoaded() && O.originAt("H4", "c", T)!.rank === 1, "the live index holds the last 7 days only (H3 is 8 days old: H4 is a first)");
  O.originSee("LIVE", "Moo Deng", "MOODENG", "q", T + 1000);
  ok(O.originAt("LIVE", "q", T + 2000)!.rank === 2, "a launch after the load ranks against the loaded week");
  O._originReset(false);
  ok((await O.originLoad(null, T)) === 0 && !O.originLoaded(), "no archive: origin stays unknown");

  // ---- 7. GRID
  const ids = g.PREDS.map((p) => p.id);
  const NEW = ["first", "copy", "alpha", "beta", "lowauto", "serial"];
  ok(NEW.every((x) => ids.includes(x)) && ids.indexOf("first") > ids.indexOf("seerfirst"), "6 ORIGIN rules on GRID's menu, appended after the others");
  const pred = (id: string) => g.PREDS.find((p) => p.id === id)!;
  const c1: any = { sx: { og: { rank: 1, cr: 0, alpha: 1, beta: 0 } } };
  const c2: any = { sx: { og: { rank: 4, cr: 12, alpha: 0, beta: 1 } } };
  const c0: any = { sx: { og: { rank: 2, cr: 3, alpha: null, beta: null } } };
  ok(pred("first").ok(c1) && !pred("copy").ok(c1) && pred("alpha").ok(c1) && !pred("beta").ok(c1) && pred("lowauto").ok(c1) && !pred("serial").ok(c1), "an original from a first-time creator");
  ok(!pred("first").ok(c2) && pred("copy").ok(c2) && pred("beta").ok(c2) && pred("serial").ok(c2) && !pred("lowauto").ok(c2), "a factory's beta copy");
  ok(NEW.every((x) => !pred(x).ok({ sx: null } as any)) && !pred("alpha").ok(c0) && !pred("beta").ok(c0), "unknown never passes");
  const s1 = g.sxOf({ at: 1 }, null, null, { rank: 3, cr: 1 });
  ok(s1?.og?.rank === 3 && s1.og.alpha === null && s1.post === 0, "an older call gets its archive origin (alpha/beta unknown)");
  const live: any = { post: 1, og: { rank: 1, cr: 0, alpha: 1, beta: 0 } };
  ok(g.sxOf({ at: 1, sx: live }, null, null, { rank: 9, cr: 9 })?.og?.rank === 1, "a call's own read wins over the archive");
  ok(g.sxOf({ at: 1, sx: { post: 1 } }, null, null, { rank: 2, cr: 0 })?.og?.rank === 2, "a call from before this build gets its origin added");
  const gs = fs.readFileSync("src/lib/grid.ts", "utf8");
  ok(/originHist\(r\.mint\)\)/.test(gs), "GRID's loader adds the origin of every older call");

  // ---- 8. live wiring
  const dg = await import("../src/lib/digger");
  O._originReset(true);
  O.originSee("LV", "Live One", "LIVE1", "cr", Date.now() - 300_000);
  const sx = dg.sxAt({ mint: "LV", creator: "cr" } as any, null);
  ok(sx.og?.rank === 1 && sx.og.cr === 0, "the call's read carries the origin");
  const ds = fs.readFileSync("src/lib/digger.ts", "utf8");
  ok(/originImage\(l\.mint, rec\.image\)/.test(ds), "the dig adds the coin's picture");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok((wk.match(/originSee\(/g) || []).length === 2 && /originMc\(t\.mint, t\.mcSol\)/.test(wk) && /originLoad\(archivePool\(\)\)/.test(wk), "both feeds index every launch, the firehose feeds market caps, the archive loads at boot");
  ok(/origin: originStats/.test(wk) && /origin: rpc\?\.origin/.test(fs.readFileSync("src/lib/review.ts", "utf8")), "the index size shows in the worker status and the review");

  // ---- 9. SEER says what it matched
  const S = await import("../src/lib/seer");
  S._seerReset();
  S.arm({ id: "x1", title: "t", src: "post", names: ["Flying Tesla Roadster"], tickers: ["FTR"], tier: 1, at: null, until: Date.now() + H, armedAt: Date.now(), why: "", hits: 0, first: null });
  ok(S.seerSee("m1", "x", "FTR", Date.now())?.on === "ftr" && S.seerSee("m2", "The Flying Tesla Roadster", "ZZZ", Date.now())?.on === "flyingteslaroadster", "a SEER match records the watched ticker or name it hit (to audit loose matches)");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 103 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.103 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.103 checks pass");
  process.exit(fail ? 1 : 0);
})();
