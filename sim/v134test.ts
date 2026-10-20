// v0.1.134: the Chrome extension, king_calls reads far enough back, the buyer tally survives a restart, dash cleanup.
// Run: npx tsx sim/v134test.ts
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const now = Date.now();
  const S = await import("../src/lib/smartbuy");
  S._smartReset();
  const M = "MintTally111111111111111111111111111111pump";
  for (let i = 0; i < 20; i++) S.smartTrade({ mint: M, user: `u${i}`, isBuy: true, at: now - 1000 + i, sol: 0.5 });
  S.smartTrade({ mint: "old", user: "x", isBuy: true, at: now - 4 * 3600_000, sol: 1 });
  const d = S.tallyDump(now);
  ok(!!d[M] && !d.old, "the dump keeps coins traded in the last 3 hours");
  S._smartReset();
  ok(S.smartRead(M, now) === null, "a restart empties the tally");
  ok(S.tallyLoad(JSON.parse(JSON.stringify(d))) === 1, "the dump loads back");
  S.smartTrade({ mint: M, user: "new1", isBuy: true, at: now, sol: 1 });
  const r = S.smartRead(M, now)!;
  ok(r.buyers === 21 && r.buys === 21 && Math.abs(r.sol - 11) < 1e-9, `counts carry across the restart (${r.buyers} buyers, ${r.buys} buys, ${r.sol} SOL)`);

  const rc = fs.readFileSync("src/lib/ratcheck.ts", "utf8");
  ok(/getCalls\(300\)/.test(rc) && /c\.nano\?\.verdict === "BOND"/.test(rc), "king_calls reads the last 300 calls (BOND is rare), v1 verdicts count");
  const ask = fs.readFileSync("src/app/api/check/ask/route.ts", "utf8");
  ok(/replace\(\/\\s\*\\u2014\\s\*\/g, ", "\)/.test(ask), "an em dash becomes a comma with a space");
  const api = fs.readFileSync("src/app/api/check/route.ts", "utf8");
  ok(/x-ratnet-client/.test(api) && /ext \? 60 : 10/.test(api), "the extension gets 60 checks an hour");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/tallyLoad\(d\)/.test(wk) && /"rn:tally", tallyDump\(\)/.test(wk), "the worker saves and loads the tally");

  // the extension
  const man = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
  ok(man.manifest_version === 3 && man.background?.service_worker === "bg.js", "Manifest V3 with a service worker");
  ok(JSON.stringify(man.host_permissions) === JSON.stringify(["https://www.ratnet.network/*"]), "it can only talk to ratnet.network");
  ok(!man.permissions.some((p: string) => ["tabs", "cookies", "webRequest", "scripting", "<all_urls>", "history"].includes(p)), "no wide permissions (no tabs, cookies, history, scripting)");
  ok(["pump.fun", "gmgn.ai", "axiom.trade", "photon-sol.tinyastro.io", "dexscreener.com"].every((h) => man.content_scripts[0].matches.some((m: string) => m.includes(h))), "runs on pump.fun, GMGN, Axiom, Photon, DexScreener");
  for (const f of ["bg.js", "content.js", "render.js", "popup.html", "popup.js", "icons/16.png", "icons/48.png", "icons/128.png"]) ok(fs.existsSync(`extension/${f}`), `extension/${f}`);
  const js = ["bg.js", "content.js", "render.js", "popup.js"].map((f) => fs.readFileSync(`extension/${f}`, "utf8")).join("\n");
  ok(!/innerHTML|eval\(|new Function/.test(js), "no innerHTML or eval: network text is only ever set as text");
  ok(/attachShadow/.test(js), "the page panel lives in a shadow root");
  ok(!/—/.test(js + fs.readFileSync("extension/popup.html", "utf8") + fs.readFileSync("src/app/extension/page.tsx", "utf8")), "no em dashes in the extension or its page");
  ok(fs.existsSync("public/ratnet-extension.zip") && fs.statSync("public/ratnet-extension.zip").size > 5000, "the zip is on the site");
  const sb = fs.readFileSync("src/components/SniffBoard.tsx", "utf8");
  ok(/sp\.get\("go"\) === "1"/.test(sb), "Ask the Rat King from the extension opens Sniff and runs the check");
  ok(JSON.parse(fs.readFileSync("package.json", "utf8")).version >= "0.1.134", "v0.1.134 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.134 checks pass");
  process.exit(fail ? 1 : 0);
})();
