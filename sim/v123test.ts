// v0.1.123 AUDIT FIXES (19 Oct): a passed strategy always gets a book, cold books keep a short record, every grid trip
// goes to Postgres, a part that fails on time alerts, TREND reports per source, HOUND paces FOMO, live fills are
// checked, trade alerts are counted, and RUNNER HOLD. Run: npx tsx sim/v123test.ts
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
// the hold rule as v0.1.123 had it (v0.1.124 adds a floor on the record without the 2 best, see v124test)
process.env.HOLD_FLOOR = "1";
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const g = await import("../src/lib/grid");
  const L = await import("../src/lib/gridlive");
  const ex = { initials: 2, trail: 0.25, stop: 0.25, timeMin: 15, mig: "sell" as const };
  const now = Date.now();
  const trip = (k: string, pnl: number, i: number) => ({ k, mint: `${k}${i}`, symbol: "T", openedAt: now - 1e6 + i, closedAt: now - 1e6 + i, pnl, pnlPct: pnl * 2000 }) as any;

  // ---- 1. a passed EARLY row with every slot taken still gets a book; the weakest non-passed book goes cold
  L.gridLiveReset();
  const rowOf = (f: string, pass: boolean, avg = 5) => ({ key: g.keyOf(f, "now", ex), filter: f, filterLabel: f, mode: "now", modeLabel: "x", exit: ex, exitLabel: "", train: {}, test: { n: 30, avgPct: avg }, pass, senders: 0 }) as any;
  const held = ["r5", "r15", "bs70"].map((f, i) => ({ key: `early60:${g.keyOf(f, "now", ex)}`, label: f, filter: f, mode: "now", exit: ex, since: now - 3600_000, grid: { testN: 20, testAvg: 3, pass: false, explore: false }, by: "early", early: true, earlySec: 60 }) as any);
  L._setBooks(held);
  L._setTrips([...[0, 1, 2].map((i) => trip(held[0].key, 0.01, i)), ...[0, 1, 2].map((i) => trip(held[1].key, -0.02, i)), ...[0, 1, 2].map((i) => trip(held[2].key, 0.002, i))]);
  const added = await L.gridLiveEarlyBooks([rowOf("lowauto+score20", true, 20)], [], now, 60);
  const bs = L.gridLiveBooks();
  ok(added.length === 1 && added[0].key === `early60:${g.keyOf("lowauto+score20", "now", ex)}`, "the 60-second pass gets its book although the 3 slots were full");
  const benched = bs.filter((b) => b.cold?.room);
  ok(benched.length === 1 && benched[0].key === held[1].key, "the weakest book (lowest total) is benched: cold, still on paper, not deleted");
  await L.gridLiveTend(undefined, now + 1000).catch(() => null);
  ok(L.gridLiveBooks().find((b) => b.key === held[1].key)?.cold?.room === true, "a benched book does not turn warm on the next pass (it would take the slot back)");
  const notPassed = await L.gridLiveEarlyBooks([rowOf("r30", false, 9)], [], now, 60);
  ok(!notPassed.length && !L.gridLiveBooks().some((b) => b.cold?.room && b.key !== held[1].key), "a row that did not pass benches nobody");

  // ---- 2. GRID: same rule
  L.gridLiveReset();
  const sixteen = Array.from({ length: L.LIVE_MAX_BOOKS }, (_, i) => ({ key: g.keyOf("sm", "now", { ...ex, timeMin: 20 + i }), label: "b", filter: "sm", mode: "now", exit: { ...ex, timeMin: 20 + i }, since: now, grid: { testN: 30, testAvg: 2, pass: false, explore: true } }) as any);
  L._setBooks(sixteen);
  L._setTrips([]);
  const after = await L.gridLiveSetBooks([{ ...rowOf("p4+post", true, 12) }], now);
  ok(after.some((b: any) => b.key === g.keyOf("p4+post", "now", ex) && !b.cold) && after.filter((b: any) => b.cold?.room).length === 1, "GRID: a passed row with 16 full slots gets in, one explore book is benched");

  // ---- 3. RUNNER HOLD
  L.gridLiveReset();
  const rx = g.RUNNER_EXITS[0];
  const RB = { key: g.keyOf("pw1+bs70", "now", rx), exit: rx, grid: { testN: 0, testAvg: 0, pass: false, explore: true } };
  // 90 trips: +0.55 SOL in total, -0.2 without the 2 best (19 Oct)
  const rec = [trip(RB.key, 0.4, 0), trip(RB.key, 0.35, 1), ...Array.from({ length: 88 }, (_, i) => trip(RB.key, -0.2 / 88, i + 2))];
  ok(!L.bookStat(RB, rec).passed, "never passed before: the runner exam fails without its 2 best");
  L._setEver([RB.key]);
  const h = L.bookStat(RB, rec);
  ok(h.passed && !!h.probation && !!h.hold, "it passed once: held, followed at the minimum size while the whole record is in profit");
  const under = [...rec, ...Array.from({ length: 30 }, (_, i) => trip(RB.key, -0.02, 200 + i))];
  ok(!L.bookStat(RB, under).passed, "its whole record goes negative: dropped");
  const gs = fs.readFileSync("src/lib/gridlive.ts", "utf8");
  ok(/r\.hgetall<Record<string, unknown>>\(PASSED_KEY\)/.test(gs) && /if \(!b\.live\.probation\) EVER\.add\(b\.key\)/.test(gs), "past full passes are read at boot and remembered on each new pass");

  // ---- 4. trip record
  L.gridLiveReset();
  L._setBooks([{ key: "warm", cold: null } as any, { key: "cold", cold: { at: 0, why: "x" } } as any]);
  const ts = [...Array.from({ length: 500 }, (_, i) => ({ k: "cold", mint: `c${i}` }) as any), ...Array.from({ length: 500 }, (_, i) => ({ k: "warm", mint: `w${i}` }) as any), ...Array.from({ length: 500 }, (_, i) => ({ k: "gone", mint: `g${i}` }) as any)];
  const kept = L.keepTrips(ts);
  ok(kept.filter((t) => t.k === "cold").length === L.TRIPS_PER_COLD && kept.filter((t) => t.k === "warm").length === L.TRIPS_PER_BOOK && kept.filter((t) => t.k === "gone").length === L.TRIPS_PER_COLD, `cold and unlisted books keep ${L.TRIPS_PER_COLD}, active books ${L.TRIPS_PER_BOOK}; ${L.TRIPS_MAX} in total`);
  ok(/archiveTrip\(\{ book: `grid:\$\{pos\.key\}`/.test(gs), "every paper trip also goes to Postgres (book grid:<key>)");

  // ---- 5. a part that fails on time alerts once, and once when fixed
  const A = await import("../src/lib/alive");
  const sent: string[] = [];
  const send = async (_c: string, t: string) => sent.push(t);
  const esc = (x: string) => x;
  const j7 = [{ name: "j7", ok: false, stalled: false, note: "on:true,got:0,error:Invalid token" }];
  await A.errorAlerts(j7, "c", send, esc, now);
  await A.errorAlerts(j7, "c", send, esc, now + 5 * 60_000);
  ok(sent.length === 0, "under 10 minutes: no alert yet (one bad pass is not an incident)");
  await A.errorAlerts(j7, "c", send, esc, now + 11 * 60_000);
  await A.errorAlerts(j7, "c", send, esc, now + 12 * 60_000);
  ok(sent.length === 1 && /j7.*Invalid token/.test(sent[0]), "after 10 minutes: one alert with the error");
  await A.errorAlerts([{ ...j7[0], ok: true, note: "on:true,got:12" }], "c", send, esc, now + 13 * 60_000);
  ok(sent.length === 2 && /works again/.test(sent[1]), "fixed: one line");
  ok(!A.isError({ ok: false, stalled: false, note: "pass still running after 90s" }), "a long pass is not an error");

  // ---- 6. TREND per source
  const T = await import("../src/lib/trend");
  process.env.APIFY_TOKEN = "test";
  T._trendReset([]);
  const deny = async () => {
    throw new Error("apify tiktok-hashtag-scraper answered 403");
  };
  const r1: any = await T.trendTick(now, deny as any);
  ok(!!r1.error && /every source failed/.test(r1.error) && Object.keys(r1.src).length >= 2, `every source down: TREND reports an error (${r1.error?.slice(0, 60)})`);
  T._trendReset([]);
  const half = async (actor: string) => {
    if (/instagram/.test(actor)) return [{ id: "1", caption: "#moodeng", likesCount: 1, videoViewCount: 300_000, timestamp: new Date(now).toISOString() }];
    throw new Error("403");
  };
  const r2: any = await T.trendTick(now, half as any);
  ok(!r2.error && r2.src.instagram === 1 && /error/.test(String(r2.src.tiktok)), "TikTok down, Instagram up: TREND runs on Instagram and names the failing source");
  delete process.env.APIFY_TOKEN;

  // ---- 7. HOUND, live fills, trade alerts
  const hs = fs.readFileSync("src/lib/hound.ts", "utf8");
  ok(/if \(res == null\) \{/.test(hs) && /fomoStatus === 429/.test(hs) && /!p\.n && Date\.now\(\) - p\.at > 86400_000/.test(hs), "HOUND: an error is never saved as an empty profile, a 429 retries in 15 minutes, empty profiles are redone");
  const Rv = await import("../src/lib/review");
  const lt = (side: string, v: number) => ({ live: true, side, par: side === "sell" ? { out: v } : { tok: v } });
  const good = Rv.liveGap([...Array.from({ length: 12 }, () => lt("sell", 9.8)), ...Array.from({ length: 12 }, () => lt("buy", 1.3))]);
  ok(good.sell === 9.8 && good.buy === 1.3, "19 Oct: live sells +9.8% vs paper (better, not worse)");
  await R.lpush("rn:desk:trades", ...Array.from({ length: 12 }, () => lt("sell", -14)));
  const msgs: string[] = [];
  const res = await Rv.liveGapAlert(async (t) => msgs.push(t), -10);
  ok(res.bad && msgs.length === 1 && /worse than paper/.test(msgs[0]), "live sells 14% under paper on 12 trades: alert");
  const ta = fs.readFileSync("src/lib/tradealerts.ts", "utf8");
  const dk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/grid: "GRID LIVE"/.test(ta) && /alertStats\.sent\+\+/.test(ta) && /how: \(GRID_BUYING \|\| !rec\.call\) && how === "direct" \? "grid" : how/.test(dk) && /how: p\.gk \? "grid" : p\.how/.test(dk), "trade alerts: counted on /status, a GRID follow says GRID LIVE (was King)");
  ok(/liveGapAlert\(/.test(fs.readFileSync("worker/index.ts", "utf8")), "the worker checks live fills every 5 minutes");

  // ---- 8. J7: the status shows how long the token has left, and warns an hour before it runs out
  const J = await import("../src/lib/j7");
  const mk = (expMs: number) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: Math.round(expMs / 1000) })).toString("base64url")}.sig`;
  process.env.J7_JWT = mk(now + 10 * 3600_000);
  ok(Math.abs(J.j7Left(now)! - 600) <= 1, "a fresh token: about 600 minutes left on the status");
  process.env.J7_JWT = mk(now + 30 * 60_000);
  ok(J.j7Left(now)! < 60 && /runs out in/.test(fs.readFileSync("src/lib/j7.ts", "utf8")), "30 minutes left: the part reports an error, the alert comes before the feed stops");
  delete process.env.J7_JWT;

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 123 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.123 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.123 checks pass");
  process.exit(fail ? 1 : 0);
})();
