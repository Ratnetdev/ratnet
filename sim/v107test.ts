// v0.1.107 EVENT: the post a coin was born from, ranked: the first coin for the post or a copy, the author's size, an
// image or video on the post, and repeated posts by the author. GRID rules firstpost, bigfirst, mediapost, repeatpost;
// older calls get their post rank from the archive. Run: npx tsx sim/v107test.ts
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
  const W = await import("../src/lib/wire");
  const g = await import("../src/lib/grid");

  // ---- 1. media on the post
  ok(W.mediaOf({ extendedEntities: { media: [{ type: "photo" }] } }) === "photo" && W.mediaOf({ extended_entities: { media: [{ type: "video" }] } }) === "video" && W.mediaOf({ entities: { media: [{ type: "animated_gif" }] } }) === "video", "an image, a video or a gif, from either payload shape");
  ok(W.mediaOf({ text: "no media" }) === null && W.mediaOf({ extendedEntities: { media: [] } }) === null, "a text post has none");
  const now = Date.now();
  const tw = W.parseHook({ tweets: [{ id: "1978", text: "Buckle up. Roadster is launching tomorrow.", createdAt: new Date(now - 135_000).toISOString(), author: { userName: "niccruzpatane", followers: 130148 }, extendedEntities: { media: [{ type: "video" }] } }] });
  ok(tw[0]?.md === "video", "the parsed post keeps its media");

  // ---- 2. a match carries the post's media; first coin for the post or a copy; repeated posts
  const posts = [
    { ...tw[0], terms: ["roadster", "flying"] },
    { id: "1979", h: "niccruzpatane", f: 130148, at: now - 60_000, text: "The flying Roadster is real", terms: ["roadster", "flying"], url: "", kind: "post" as const, md: null },
    { id: "1980", h: "someoneelse", f: 500, at: now - 30_000, text: "roadster", terms: ["roadster"], url: "", kind: "post" as const, md: null },
  ];
  const l = { mint: "FTR", name: "Roadster", symbol: "ROADSTER", description: "", twitter: "", createdAt: now };
  const m = W.matchOne(l, posts as any);
  ok(!!m && m.tid === "1978" && m.md === "video", "the match keeps the post's media");
  const ds = fs.readFileSync("src/lib/digger.ts", "utf8");
  ok(/wm\.rank = seen\.findIndex\(\(x\) => x\.m === l\.mint\) \+ 1;/.test(ds) && /if \(!seen\.some\(\(x\) => x\.m === l\.mint\)\) seen\.push\(\{ m: l\.mint, t: l\.createdAt \}\), seen\.sort/.test(ds), "the dig ranks each coin among the coins matched to the same post, in creation order");
  ok(/wm\.rep = posts\.filter\(\(t\) => t\.h === wm\.h && matchOne\(/.test(ds), "and counts the author's posts in the last hour that match the coin");
  const rep = posts.filter((t) => t.h === m!.h && W.matchOne(l, [t as any])).length;
  ok(rep === 2, `@niccruzpatane posted about it twice: rep 2 (the other account does not count) (${rep})`);

  // ---- 3. the call's read
  const dg = await import("../src/lib/digger");
  const sx = dg.sxAt({ mint: "FTR", creator: "c", wire: { ...m, rank: 1, rep: 2 } } as any, null);
  ok(sx.ev?.rank === 1 && sx.ev.md === 1 && sx.ev.rep === 2 && sx.ev.f === 130148, "the call carries rank, media, repeats and the author's size");
  ok(dg.sxAt({ mint: "X", creator: "c" } as any, null).ev === null, "no post: no event read");

  // ---- 4. GRID
  const ids = g.PREDS.map((p) => p.id);
  const NEW = ["firstpost", "bigfirst", "mediapost", "repeatpost"];
  ok(NEW.every((x) => ids.includes(x)) && ids.indexOf("firstpost") > ids.indexOf("exit20"), "4 EVENT rules on GRID's menu, appended");
  const pred = (id: string) => g.PREDS.find((p) => p.id === id)!;
  const ftr: any = { sx: { ev: { rank: 1, md: 1, rep: 2, f: 130148 } } };
  const copy: any = { sx: { ev: { rank: 7, md: 0, rep: 1, f: 2000 } } };
  ok(pred("firstpost").ok(ftr) && pred("bigfirst").ok(ftr) && pred("mediapost").ok(ftr) && pred("repeatpost").ok(ftr), "FTR passes all four");
  ok(NEW.every((x) => !pred(x).ok(copy)), "the 7th coin for a small account's text post passes none");
  ok(NEW.every((x) => !pred(x).ok({ sx: null } as any)) && !pred("mediapost").ok({ sx: { ev: { rank: 1, md: null, rep: null, f: 0 } } } as any), "unknown never passes");
  // older calls: rank from the archive, media and repeats unknown; a CA post is never counted (it can come later)
  const s1 = g.sxOf({ at: 1 }, { tid: "9", h: "a", how: "links the post", f: 200_000 }, null, null, null, 1);
  ok(s1?.ev?.rank === 1 && s1.ev.md === null && s1.ev.rep === null && s1.ev.f === 200_000, "an older call: its post rank from the archive");
  ok(g.sxOf({ at: 1 }, { tid: "9", h: "a", how: "posted the CA", f: 1 }, null, null, null, 1)?.ev === null, "an older call whose post was a CA post: no event read (no look ahead)");
  ok(g.sxOf({ at: 1, sx: { post: 1 } }, { tid: "9", h: "a", how: "named \"x\"", f: 5 }, null, null, null, 3)?.ev?.rank === 3, "calls from v0.1.101 to v0.1.106 get it added");
  ok(g.sxOf({ at: 1, sx: { post: 1, ev: { rank: 1, md: 1, rep: 1, f: 9 } } }, { tid: "9", how: "x" }, null, null, null, 5)?.ev?.rank === 1, "a call's own read wins");
  const gs = fs.readFileSync("src/lib/grid.ts", "utf8");
  ok(/data->'wire'->>'tid' as tid from launches/.test(gs) && /postRank\.get\(r\.mint\)/.test(gs), "GRID ranks archived coins per post, in creation order");

  // ---- 5. the review checks the media read live
  await R.lpush("rn:x:tw", { id: "1", md: "video" }, { id: "2", md: null }, { id: "3" });
  const rv = await import("../src/lib/review");
  const v: any = await rv.reviewView(Date.now());
  ok(v.xMedia.posts === 2 && v.xMedia.video === 1, "the review counts media on WIRE's latest posts (posts from before this build are left out)");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 107 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.107 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.107 checks pass");
  process.exit(fail ? 1 : 0);
})();
