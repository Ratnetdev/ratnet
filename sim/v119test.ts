// v0.1.119 TREND: TikTok and Instagram through Apify; rising terms feed SEER and a rule on calls and EARLY reads.
// Run: npx tsx sim/v119test.ts
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
  const T = await import("../src/lib/trend");
  const g = await import("../src/lib/grid");
  const now = Date.now();
  const iso = (h: number) => new Date(now - h * 3600_000).toISOString();

  // ---- 1. parsing (the scrapers' item shapes)
  const v = T.ttHit({ id: "1", text: "this hippo #moodeng #fyp", hashtags: [{ name: "moodeng" }, { name: "fyp" }], playCount: 2_000_000, diggCount: 300_000, createTimeISO: iso(5), webVideoUrl: "u", musicMeta: { musicName: "original sound", musicOriginal: true } });
  ok(!!v && v.src === "tiktok" && v.tags.includes("moodeng") && v.views === 2_000_000 && v.sound === null, "a TikTok video: hashtags, views, no 'original sound'");
  const p = T.igHit({ id: "9", caption: "look #moodeng #memes", hashtags: [], likesCount: 50_000, videoViewCount: 400_000, timestamp: iso(2), url: "x" });
  ok(!!p && p.src === "instagram" && p.tags.includes("moodeng") && p.views === 400_000, "an Instagram post: hashtags from the caption when the list is empty");
  ok(T.ttHit({ isAd: true }) === null && T.ttHit({ errorCode: "x" }) === null, "ads and error rows are skipped");

  // ---- 2. terms
  const hits = [v!, p!, T.ttHit({ id: "2", text: "#moodeng again", hashtags: [{ name: "moodeng" }], playCount: 50_000, createTimeISO: iso(10) })!, T.ttHit({ id: "3", text: "#oldmeme", hashtags: [{ name: "oldmeme" }], playCount: 9_000_000, createTimeISO: iso(100) })!, T.ttHit({ id: "4", text: "#tiny", hashtags: [{ name: "tinyone" }], playCount: 3_000, createTimeISO: iso(1) })!];
  const terms = T.termsOf(hits, {}, now);
  const md = terms.find((t) => t.t === "moodeng");
  ok(!!md && md.n === 3 && md.src.includes("tiktok") && md.src.includes("instagram") && md.rising, "a term on both platforms, new today: rising");
  ok(!terms.some((t) => t.t === "fyp" || t.t === "memes"), "generic tags (fyp, memes) say nothing: left out");
  ok(!terms.some((t) => t.t === "oldmeme") && !terms.some((t) => t.t === "tinyone"), "older than 72 hours, or one small video: left out");
  const again = T.termsOf(hits, { moodeng: { first: now - 3 * 86400_000, last: now - 7200_000, score: md!.score } }, now);
  ok(!again.find((t) => t.t === "moodeng")!.rising, "seen for days and not growing: not rising");

  // ---- 3. matching launches
  T._trendReset(terms);
  ok(T.trendAt("Moo Deng", "MOODENG")?.tt === 1 && T.trendAt("Moo Deng", "MOODENG")?.ig === 1, "a launch named after it matches (TikTok and Instagram)");
  ok(T.trendAt("Baby Moodeng Coin", "BMD")?.term === "moodeng" && T.trendAt("Doge", "DOGE")?.tt === 0, "contains the term: a match; anything else: no");
  T._trendReset([]);
  ok(T.trendAt("Moo Deng", "MOODENG") === null, "no TREND data: unknown (never passes a rule)");
  const P = (id: string) => g.PREDS.find((x) => x.id === id)!;
  ok(P("tiktok").ok({ sx: { tr: { tt: 1, ig: 0, term: "x" } } } as any) && P("social").ok({ sx: { tr: { tt: 0, ig: 1, term: "x" } } } as any) && !P("insta").ok({ sx: null } as any), "GRID rules: tiktok, insta, social");

  // ---- 4. a run (Apify mocked), the cap, SEER items
  process.env.APIFY_TOKEN = "test";
  T._trendReset([]);
  const calls: string[] = [];
  const run = async (actor: string, input: any, n: number) => {
    calls.push(`${actor}:${n}`);
    if (/creative-center/.test(actor)) return [{ ok: true, hashtag: "#bigtag" }];
    if (/tiktok/.test(actor)) return input.hashtags.includes("bigtag") ? [v, { id: "5", text: "#moodeng", hashtags: [{ name: "moodeng" }], playCount: 80_000, createTimeISO: iso(3) }] : [];
    return [{ id: "9", caption: "#moodeng", likesCount: 1, videoViewCount: 300_000, timestamp: iso(1) }];
  };
  const res: any = await T.trendTick(now, run as any);
  ok(res.items === 3 && res.rising >= 1 && calls.length === 3, `a run: Creative Center top tags, TikTok videos, Instagram posts (${calls.join(", ")})`);
  ok(((await R.get<any>("rn:trend:view")) as any)?.terms?.some((t: any) => t.t === "moodeng"), "the view is stored");
  ok((await T.trendTick(now + 60_000, run as any) as any).wait, "the next run waits TREND_EVERY_MIN");
  const items = await T.fromTrend();
  ok(items.some((x) => x.id === "tr:moodeng" && /TikTok and Instagram/.test(x.title)), "rising terms are SEER items");
  delete process.env.APIFY_TOKEN;
  ok((await T.trendTick(now + 9e6, run as any) as any).off, "without APIFY_TOKEN: off");

  // ---- 5. wiring
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/trendTick\(\)/.test(wk) && /await trendLoad\(\)/.test(wk) && /tr: trendAt\(name, sym\)/.test(wk), "the worker runs TREND and the EARLY reads carry it");
  ok(/tr: trendAt\(String\(rec\.name/.test(fs.readFileSync("src/lib/digger.ts", "utf8")), "the King's calls carry it");
  ok(/fromTrend\(\)/.test(fs.readFileSync("src/lib/seer.ts", "utf8")), "SEER reads it");
  ok(/"tiktok", "insta", "social"\]/.test(fs.readFileSync("src/lib/gridlive.ts", "utf8")), "the SIGNALS family can trade the new rules once their lift shows");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 119 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.119 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.119 checks pass");
  process.exit(fail ? 1 : 0);
})();
