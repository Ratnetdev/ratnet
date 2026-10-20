// v0.1.133 RAT KING CHECK: who bought a coin since launch, the worker's live read, one check for Sniff, /api/check, MCP
// and the Telegram bot, Ask the Rat King, and who-is-in lines on Telegram calls.
// Run: npx tsx sim/v133test.ts
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
  const now = Date.now();
  const S = await import("../src/lib/smartbuy");
  const E = await import("../src/lib/earners");
  S._smartReset();
  E._earnReset();

  // ---- 1. the tally: every buy, bots apart
  const M = "MintCheck1111111111111111111111111111111111";
  // make a bot: 31 closed round trips in one UTC day
  const BOT = "Bot1111111111111111111111111111111111111111";
  const day0 = Math.floor(now / 86_400_000) * 86_400_000 + 1000;
  for (let i = 0; i < 31; i++) {
    E.earnTrade({ mint: `b${i}`, user: BOT, isBuy: true, sol: 0.1, tokens: 100, at: day0 + i * 10 });
    E.earnTrade({ mint: `b${i}`, user: BOT, isBuy: false, sol: 0.1, tokens: 100, at: day0 + i * 10 + 5 });
  }
  ok(E.isBot(BOT), "31 round trips in a day make a bot");
  for (let i = 0; i < 12; i++) S.smartTrade({ mint: M, user: `user${i}`, isBuy: true, at: now - 60_000 + i, sol: 0.2 });
  S.smartTrade({ mint: M, user: BOT, isBuy: true, at: now - 30_000, sol: 1 });
  S.smartTrade({ mint: M, user: "user0", isBuy: false, at: now - 20_000, sol: 0.1 });
  const r = S.smartRead(M, now)!;
  ok(r.buys === 13 && r.buyers === 13, `every buy is tallied, sells are not (${r.buys} buys, ${r.buyers} buyers)`);
  ok(r.bots === 1 && r.fomo === 0 && r.earners === 0, "the bot is counted as a bot, nothing else");
  ok(Math.abs(r.sol - 3.4) < 1e-9, `SOL in is summed (${r.sol})`);
  ok(S.smartRead("nothing", now) === null, "a coin with no buys reads null");

  // ---- 2. the live read
  const L = await import("../src/lib/ratlive");
  for (let i = 0; i < 3; i++) S.smartTrade({ mint: M, user: BOT, isBuy: true, at: now - 10_000 + i, sol: 0.5 });
  const lr = L.liveRead(M, now);
  ok(!!lr.who && lr.who.bots === 1, "the live read carries who bought");
  ok(lr.bad.length === 0 && lr.info.some((x) => /1 bot bought it/.test(x)), "one bot is a note, not a red flag");
  const BOT2 = "Bot2222222222222222222222222222222222222222", BOT3 = "Bot3333333333333333333333333333333333333333";
  for (const b of [BOT2, BOT3]) for (let i = 0; i < 31; i++) {
    E.earnTrade({ mint: `x${i}`, user: b, isBuy: true, sol: 0.1, tokens: 100, at: day0 + i * 10 });
    E.earnTrade({ mint: `x${i}`, user: b, isBuy: false, sol: 0.1, tokens: 100, at: day0 + i * 10 + 5 });
  }
  S.smartTrade({ mint: M, user: BOT2, isBuy: true, at: now, sol: 0.5 });
  S.smartTrade({ mint: M, user: BOT3, isBuy: true, at: now, sol: 0.5 });
  const lr2 = L.liveRead(M, now);
  ok(lr2.bad.some((x) => /3 bots bought it/.test(x) && /48%/.test(x)), "3 bots is a red flag with the measured rug rate");
  ok(L.callLines(M).some((x) => /Who is in: 3 bots/.test(x)), "Telegram calls get a who-is-in line");

  // ---- 3. the site half
  const C = await import("../src/lib/ratcheck");
  const base: any = { id: "x", ca: M, symbol: "TST", name: "Test", image: "", score: 62, verdict: "BOND", progress: 40, mcapSol: 50, complete: false, plus: ["fresh dev"], minus: [], note: "n", wallet: "", sig: "", free: true, at: now, version: "v1", dev: { n: 0, b: 0 }, nano: null };
  ok(C.readOf(base, { ...lr2, good: [], bad: ["a", "b"] }) === "Careful: more red flags than good signs", "two red flags and no good signs read Careful");
  ok(C.readOf(base, { ...lr2, good: ["g"], bad: [] }) === "Smart money is in and nothing is wrong yet", "BOND plus a good sign and no red flag reads well");
  const txt = C.checkText({ ...base, live: lr2, read: "x" });
  ok(/Who bought since the rats first saw it: 15 buyers/.test(txt) && /bots 3/.test(txt) && /King score: 62 \(BOND\)/.test(txt), "the plain-text check carries the score and who bought");
  const html = C.checkHtml({ ...base, live: lr2, read: "x" });
  ok(/<b>\$TST<\/b>/.test(html) && /⚠️ 3 bots/.test(html) && !/[—]/.test(html + txt), "Telegram HTML has the flags and no em dashes");
  // the worker answers the queue
  await R.lpush(C.CHECK_Q, { m: M, at: Date.now() });
  const n = await L.serveChecks();
  const got: any = await R.get(C.CHECK_R(M));
  ok(n === 1 && got?.who?.bots === 3, "the worker answers a queued check in Redis");
  const w = await C.askWorker(M, 500);
  ok(!!w && w.who?.bots === 3, "the site reads a fresh answer without asking again");

  // ---- 4. MCP
  const mcp = await import("../src/app/api/mcp/route");
  const post = async (b: any) => {
    const res = await mcp.POST(new Request("http://x/api/mcp", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "9.9.9.9" }, body: JSON.stringify(b) }));
    return { status: res.status, j: res.status === 202 ? null : await res.json() };
  };
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  ok(init.j.result?.protocolVersion === "2025-03-26" && init.j.result?.capabilities?.tools && init.j.result?.serverInfo?.name === "ratnet", "MCP initialize answers with tools and the client's protocol version");
  ok((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status === 202, "notifications get 202");
  const tl = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  ok(JSON.stringify(tl.j.result.tools.map((t: any) => t.name)) === JSON.stringify(["rat_check", "king_calls", "rat_desk"]), "tools: rat_check, king_calls, rat_desk");
  const bad = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rat_check", arguments: { ca: "nope" } } });
  ok(bad.j.result?.isError === true, "a bad CA is a tool error, not a crash");
  ok((await post({ jsonrpc: "2.0", id: 4, method: "nope" })).j.error?.code === -32601, "unknown methods get -32601");
  const batch = await post([{ jsonrpc: "2.0", id: 5, method: "ping" }, { jsonrpc: "2.0", id: 6, method: "tools/list" }]);
  ok(Array.isArray(batch.j) && batch.j.length === 2, "batches are answered");

  // ---- 5. wiring
  const bot = fs.readFileSync("src/lib/tgbot.ts", "utf8");
  ok(/cmd === "\/check" \|\| cmd === "\/rat" \|\| bare/.test(bot) && bot.indexOf('cmd === "/check"') < bot.indexOf("if (!allowed(m))"), "anyone can /check in Telegram (before the admin gate)");
  ok(/checkGate\(`tg:/.test(bot) && /cmd === "\/calls"/.test(bot), "Telegram checks are rate limited per user; /calls is public");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/serveChecks\(\)/.test(wk) && /setCallExtra\(\(mint\) => callLines\(mint\)\)/.test(wk), "the worker serves checks and adds who-is-in to calls");
  const sn = fs.readFileSync("src/app/api/sniff/route.ts", "utf8");
  ok((sn.match(/kingCheck\(/g) || []).length === 2 && !/await sniff\(/.test(sn), "both sniff paths (free and burn) run the full check");
  const ask = fs.readFileSync("src/app/api/check/ask/route.ts", "utf8");
  ok(/using ONLY the check/.test(ask) && /Never tell anyone to buy or sell/.test(ask) && /limit\(`ask:/.test(ask), "Ask the Rat King answers only from the check, never buy/sell, rate limited");
  const gate = fs.readFileSync("src/lib/ratcheck.ts", "utf8");
  ok(/if \(s\.mint \|\| !s\.freeSniff\) return `Checks are sniff orders now/.test(gate), "after launch free checks stop: a check is a sniff order (burn)");
  ok(JSON.parse(fs.readFileSync("package.json", "utf8")).version >= "0.1.133", "v0.1.133 or later");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.133 checks pass");
  process.exit(fail ? 1 : 0);
})();
