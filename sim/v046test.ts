// v0.1.46 (Run 12): security and the Telegram trade alerts. Run: npx tsx sim/v046test.ts
process.env.CRON_SECRET = "cron-root";
delete process.env.HELIUS_HOOK_SECRET;
delete process.env.TG_HOOK_SECRET;
delete process.env.X_HOOK_SECRET;
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};

(async () => {
  // 1. webhook secrets are never derived from CRON_SECRET
  const admin = await import("../src/lib/admin");
  ok(admin.secretFor("helius-hook") === "" && admin.secretFor("tg-hook") === "" && admin.secretFor("x-hook") === "", "no own secret set: the webhooks refuse everything (no key derived from CRON_SECRET)");
  process.env.HELIUS_HOOK_SECRET = "own-helius";
  ok(admin.secretFor("helius-hook") === "own-helius", "its own env var is used");

  // 2. the login limit fails closed when Redis is down
  const http = await import("../src/lib/http");
  const realIncr = R.incr.bind(R);
  (R as any).incr = async () => {
    throw new Error("redis down");
  };
  ok((await http.limit("t", 5, 60, true)) === false && (await http.limit("t", 5, 60)) === true, "Redis down: the login limit refuses, other limits let through");
  (R as any).incr = realIncr;

  // 3. sessions carry the epoch; revoking moves it
  process.env.ADMIN_PASSWORD = "pw";
  const t1 = await admin.newSession();
  await admin.revokeSessions();
  const t2 = await admin.newSession();
  ok(/^v2\.\d+\.[\w-]+\.0\./.test(t1) && /^v2\.\d+\.[\w-]+\.1\./.test(t2), "a session token carries the epoch; log out everywhere moves it (old tokens stop working)");

  // 4. a Jupiter quote has to match what we asked, with a sane minimum output
  const ex = await import("../src/lib/exec");
  const SOLM = "So11111111111111111111111111111111111111112";
  const M = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const q = { inputMint: SOLM, outputMint: M, inAmount: "50000000", outAmount: "1000000", otherAmountThreshold: "985000" };
  let threw = "";
  try {
    ex.vetQuote(q, SOLM, M, 50_000_000n, 1500);
  } catch (e: any) {
    threw = e.message;
  }
  ok(!threw, "a normal quote passes");
  const bad = (qq: any) => {
    try {
      ex.vetQuote(qq, SOLM, M, 50_000_000n, 1500);
      return false;
    } catch {
      return true;
    }
  };
  ok(bad({ ...q, otherAmountThreshold: "1" }), "minimum output near zero (a sandwich gift): refused before signing");
  ok(bad({ ...q, outputMint: SOLM }) && bad({ ...q, inAmount: "99" }), "wrong mint or amount: refused");

  // 5. Telegram: a long message is cut without breaking its HTML
  const { tgCut } = await import("../src/lib/tgbot");
  const long = `<b>title</b>\n<i>${"x&amp;".repeat(2000)}</i>`;
  const cut = tgCut(long, 300);
  ok(cut.length <= 300 && cut.endsWith("</i>") && !/&[a-z]*…/.test(cut), "cut at 300 characters, the open tag closed, no half entity");

  // 6. trade alerts: the three books never look alike, the close has the whole result and the links
  const ta = await import("../src/lib/tradealerts");
  const base = { mint: M, symbol: "TEST", how: "momo", sol: 0.05, mcUsd: 12_400, curve: null, ageMs: 600_000, why: "MOMO: $111K volume in 5m" };
  const g = ta.openText({ ...base, book: "ghost", blocked: "king sleeve paused by PM" });
  const p = ta.openText({ ...base, book: "paper" });
  const l = ta.openText({ ...base, book: "live", sig: "5sigxyz" });
  ok(g.startsWith("👻 <b>GHOST · BUY</b>") && p.startsWith("📄 <b>PAPER · BUY</b>") && l.startsWith("💰 <b>LIVE · BUY</b>"), "ghost, paper and live open alerts start differently");
  ok(/Not real because/.test(g) && /REAL MONEY/.test(l) && /solscan\.io\/tx\/5sigxyz/.test(l) && /\/c\/EPjF/.test(p) && /\/desk/.test(p), "ghost says why it was blocked, live says real money with Solscan, every alert links the coin and the desk");
  const c = ta.closeText({ book: "paper", mint: M, symbol: "TEST", how: "direct", costSol: 0.05, backSol: 0.0713, entryMc: 6200, exitMc: 8800, peakX: 1.61, openedAt: Date.now() - 252_000, reason: "trailing stop 16% off the peak" });
  ok(/PAPER · WIN/.test(c) && /\+42\.6%/.test(c) && /0\.0500 SOL → 0\.0713 SOL/.test(c) && /\$6\.2K → \$8\.8K/.test(c) && /Peak held<\/b>  \+61\.0%/.test(c) && /4m 12s/.test(c) && /trailing stop/.test(c), "the close alert: result in % and SOL, in and out, market caps, peak, time held, exit reason");
  const lo = ta.closeText({ book: "ghost", mint: M, symbol: "X", costSol: 0.1, backSol: 0.066, entryMc: 1, exitMc: 1, peakX: 1, openedAt: Date.now(), reason: "stop loss" });
  ok(/GHOST · LOSS/.test(lo) && /🔻/.test(lo), "a loss reads as a loss");

  const gn = ta.openText({ ...base, book: "ghost", blocked: "nano agrees WATCH 50" });
  ok(/nano did not back the King's call/.test(gn) && /nano says WATCH 50, the desk needs BOND/.test(gn), "a ghost trade from the nano rule says so in plain words (not 'blocked')");

  // 7. X webhook: field caps
  const { parseHook } = await import("../src/lib/wire");
  const tw = parseHook([{ id: "123", author: { userName: "good_one", followers: 1e12, name: "n".repeat(500) }, text: "hi" }, { id: "abc", author: { userName: "x" }, text: "bad id" }, { id: "9", author: { userName: "way_too_long_handle_here" }, text: "bad" }]);
  ok(tw.length === 1 && tw[0].f === 500_000_000 && tw[0].name!.length === 50, "bad ids and handles dropped, follower count and name capped");

  // 8. the public desk: no stalks, no exit levels, no PM pauses
  const { publicDesk } = await import("../src/lib/private");
  const pd: any = publicDesk({ cfg: {}, positions: [{ mint: "A", trail: 30, watch: [{ acc: "x" }], pn: 0.4 }], stalks: [{ mint: "B", depth: 30 }], pm: [{ sl: "king", pausedUntil: 5, n: 3 }], trades: [], events: [] });
  ok(pd.stalks.length === 0 && pd.positions[0].trail === undefined && pd.positions[0].watch === undefined && pd.pm[0].pausedUntil === undefined && pd.pm[0].n === 3, "stripped from the public copy");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.46 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
