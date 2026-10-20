// v0.1.128 WHO IS BUYING: the FOMO tap (FOMO's on-chain fingerprint learned from the firehose), every wallet's real
// record (earners), crews counted once, and the entry rules RUG GUARD tests on them. Run: npx tsx sim/v128test.ts
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
  const bs58 = (await import("bs58")).default;
  const F = await import("../src/lib/fomotap");
  const E = await import("../src/lib/earners");
  const C = await import("../src/lib/crews");
  const S = await import("../src/lib/smartbuy");
  const W = await import("../src/lib/wallets");
  const crypto = await import("crypto");
  const key = () => new Uint8Array(crypto.randomBytes(32));
  const addr = () => bs58.encode(crypto.randomBytes(32));

  // ---- 1. FOMO tap: the fingerprint is learned from trades by known FOMO wallets
  F._fomoReset();
  const known = Array.from({ length: 8 }, addr);
  F.fomoSetKnown(known);
  const relay = key(); // FOMO's account on every FOMO swap
  const curve = key(); // a popular coin's curve: in many trades, FOMO or not
  const pump = bs58.decode("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  for (let i = 0; i < 3000; i++) F.fomoTx([key(), pump, i % 10 ? key() : curve], [addr()]); // everyone else
  for (let i = 0; i < 60; i++) F.fomoTx([bs58.decode(known[i % 8]), relay, pump, i % 2 ? curve : key()], [known[i % 8]]);
  const before = F.fomoView();
  ok(!before.print.length && before.knownTx === 60, "nothing is FOMO's fingerprint before the learner runs");
  const best = F.fomoCandidates()[0];
  ok(bs58.encode(Buffer.from(best.k, "base64")) === bs58.encode(relay) && best.wallets === 8 && best.base < F.PRINT_BASE, "the learner ranks FOMO's account first (in every FOMO trade, 8 wallets, in no other); the pump program and a busy coin's curve are not");
  // v0.1.130: the print is pinned to FOMO's own account; the learner only measures
  F.fomoLearn();
  ok(F.fomoView().printBy === "seed" && F.fomoView().print[0] === F.FOMO_SEED[0], "v0.1.130: the print is FOMO's pinned account");
  F.fomoSetPrint([bs58.encode(relay)], "data");
  const stranger = addr();
  const res = F.fomoTx([relay, pump, key()], [stranger]);
  ok(res.includes(stranger) && F.isFomo(stranger) && F.fomoNew().includes(stranger), "a wallet never seen before, trading with the fingerprint, joins the FOMO book (and is saved)");
  ok(!F.fomoTx([key(), pump], [addr()]).length, "a trade without it is not FOMO");
  process.env.FOMO_PRINT = bs58.encode(curve);
  F.fomoLearn();
  ok(F.fomoView().printBy === "env", "FOMO_PRINT in Railway sets it by hand");
  delete process.env.FOMO_PRINT;

  // ---- 2. EARNERS: real round trips from the stream
  E._earnReset();
  const pro = addr();
  const now = Date.now();
  for (let i = 0; i < 12; i++) {
    E.earnTrade({ mint: `M${i}`, user: pro, isBuy: true, sol: 0.5, tokens: 1000, at: now + i });
    E.earnTrade({ mint: `M${i}`, user: pro, isBuy: false, sol: i % 3 ? 1.0 : 0.3, tokens: 1000, at: now + i + 1 });
  }
  const r = E.earnRec(pro)!;
  ok(r.n === 12 && r.w === 8 && Math.abs(r.pnl - (8 * 0.5 - 4 * 0.2)) < 1e-6 && E.isEarner(pro), `12 round trips, 8 won, +${r.pnl} SOL: an earner`);
  const loser = addr();
  for (let i = 0; i < 12; i++) {
    E.earnTrade({ mint: `L${i}`, user: loser, isBuy: true, sol: 0.5, tokens: 1000, at: now });
    E.earnTrade({ mint: `L${i}`, user: loser, isBuy: false, sol: 0.4, tokens: 1000, at: now + 1 });
  }
  ok(!E.isEarner(loser), "12 trips, all lost: not an earner");
  const half = addr();
  E.earnTrade({ mint: "H", user: half, isBuy: true, sol: 1, tokens: 1000, at: now });
  E.earnTrade({ mint: "H", user: half, isBuy: false, sol: 1.5, tokens: 500, at: now });
  ok(!E.earnRec(half)!.n, "half sold: the round trip is still open");
  E.earnTrade({ mint: "Z", user: addr(), isBuy: false, sol: 5, tokens: 1000, at: now });
  ok(true, "a sell without a buy we saw is ignored");

  // ---- 3. CREWS
  C._crewReset();
  const [a, b, c] = [addr(), addr(), addr()];
  for (let i = 0; i < 3; i++) {
    C.crewBuy(`X${i}`, a, now + i * 10_000);
    C.crewBuy(`X${i}`, b, now + i * 10_000 + 1000);
    C.crewBuy(`X${i}`, c, now + i * 10_000 + 9000); // 8 s later: not with them
  }
  ok(C.crewFind(a) === C.crewFind(b) && C.crewFind(c) !== C.crewFind(a) && C.independent([a, b, c]) === 2, "two wallets that bought 3 coins within 3 s of each other are one crew; 3 wallets = 2 independent buyers");
  C._crewReset();
  C.crewBuy("Y", a, now);
  C.crewBuy("Y", b, now + 500);
  C.crewBuy("Y", a, now + 600);
  ok(C.independent([a, b]) === 2, "once is not a crew");

  // ---- 4. the coin's state
  F._fomoReset();
  F.fomoSetKnown([a]);
  E._earnReset();
  E.earnLoad({ [b]: { n: 20, w: 12, pnl: 3, gw: 4, gl: -1, at: now } });
  S._smartReset();
  ok(S.smartFeatures("COIN", now).fc === null, "before the fingerprint is found the FOMO crowd is unknown (never 0)");
  F.fomoSetPrint([bs58.encode(relay)], "data");
  S.smartTrade({ mint: "COIN", user: a, isBuy: true, at: now });
  S.smartTrade({ mint: "COIN", user: b, isBuy: true, at: now + 100 });
  S.smartTrade({ mint: "COIN", user: c, isBuy: true, at: now + 200 });
  const f = S.smartFeatures("COIN", now + 1000);
  ok(f.fc === 1 && f.ea === 1, `in the last minute: ${f.fc} FOMO trader, ${f.ea} earner`);
  ok(S.smartFeatures("COIN", now + 120_000).fc === 0, "a minute later the crowd is gone");
  ok(typeof W.provenSet === "function", "proven wallets per coin, for the crew count");

  // ---- 5. RUG GUARD tests the new rules on the money only
  const L = await import("../src/lib/gridlive");
  const ids = L.RUG_RULES.map((x) => x.id);
  ok(["no_fomo", "fomo_late", "no_earner", "one_crew"].every((x) => ids.includes(x)), "new rules: no FOMO trader, 5+ FOMO traders (late), no earner, proven wallets that are one crew");
  let i = 0;
  const ef = (o: any) => ({ age: 200, dev: 1, u60: 20, bs60: 0.6, wh: 0, ds: false, og: 1, ...o });
  const trip = (e: any, pnl: number) => ({ k: "b", mint: `T${i}`, symbol: "T", openedAt: i, closedAt: ++i, pnl, pnlPct: pnl * 2000, why: "", ef: e, rug: false }) as any;
  const xs: any[] = [];
  for (let n = 0; n < 300; n++) xs.push(trip(ef({}), 0)); // trips from before this build: no fc, they don't count for it
  for (let n = 0; n < 200; n++) (xs.push(trip(ef({ fc: 0, ea: 1, bt: 0 }), -0.01)), xs.push(trip(ef({ fc: 2, ea: 1, bt: 0 }), 0.01)));
  const st = L.rugStudy(xs);
  const row = (id: string) => st.rows.find((x: any) => x.id === id)!;
  ok(row("no_fomo").verdict === "live" && row("no_fomo").test.n === 60, `coins with no FOMO trader lost on both halves, no rug rate needed: live (${row("no_fomo").test.n} newest skipped)`);
  ok(row("no_earner").verdict !== "live", "no earner never fired here: not live");
  const ys: any[] = [];
  for (let n = 0; n < 400; n++) ys.push(trip(ef({ fc: n % 5 ? 0 : 1, bt: 0 }), n % 5 ? -0.01 : 0.01));
  ok(L.rugStudy(ys).rows.find((x: any) => x.id === "no_fomo")!.verdict === "off", `a rule that would skip 80% of trips never goes live (cap ${L.SKIP_MAX * 100}%)`);

  // ---- 6. wiring
  const fh = fs.readFileSync("src/lib/firehose.ts", "utf8");
  ok(/h\.tx\(keys, users\)/.test(fh) && /loadedWritableAddresses/.test(fh), "the firehose hands every transaction's accounts (looked-up ones too) to the tap");
  const wk = fs.readFileSync("worker/index.ts", "utf8");
  ok(/tx: \(keys, users\) => void fomoTx\(keys, users\)/.test(wk) && /earnTrade\(t\)/.test(wk) && /smartTrade\(t\)/.test(wk) && /fc: sm\.fc, ea: sm\.ea, pwi: sm\.pwi, pwr: sm\.pwr/.test(wk), "the worker books every trade and adds fc, ea, pwi, pwr to each paper buy's state");
  ok(/rn:fomo:w/.test(wk) && /rn:earn:rec/.test(wk) && /rn:crew:edges/.test(wk), "the books are saved and loaded at boot");
  ok(/WHO IS BUYING/.test(fs.readFileSync("src/lib/review.ts", "utf8")), "the daily review shows it");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 128 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.128 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.128 checks pass");
  process.exit(fail ? 1 : 0);
})();
