// v0.1.79: the desk switches to a separate live wallet by itself when it goes live; the paper wallet is retired and
// hidden on the site. Run: npx tsx sim/v079test.ts
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { MockRedis } from "./mockredis";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const A = Keypair.generate(); // paper wallet
  const B = Keypair.generate(); // live wallet
  const a = A.publicKey.toBase58();
  const bAddr = B.publicKey.toBase58();
  process.env.DESK_WALLET_SECRET = bs58.encode(A.secretKey);
  process.env.DESK_LIVE_WALLET_SECRET = JSON.stringify(Array.from(B.secretKey)); // either format works
  delete process.env.VERCEL;
  const KK = await import("../src/lib/deskkey");
  const D = await import("../src/lib/desk");
  const RC = await import("../src/lib/receipts");
  const { K } = await import("../src/lib/redis");
  const fs = await import("fs");

  // ---- before the exam passes: paper on the paper wallet, the live wallet waits
  await KK.loadSwitch(true);
  ok(KK.deskKey()?.publicKey.toBase58() === a, "paper trades on the paper wallet");
  ok(KK.switchPending() && KK.nextLiveKey()?.publicKey.toBase58() === bAddr, "a separate live wallet is waiting for the exam");
  ok(D.deskWalletAddress() === a, "the site shows the paper wallet until the switch");

  // ---- the switch (what the promotion does)
  await KK.markSwitch(a, bAddr);
  ok(KK.deskKey()?.publicKey.toBase58() === bAddr && !KK.switchPending(), "after the switch the desk trades on the live wallet");
  ok((await KK.hiddenWallets()).has(a), "the paper wallet is on the hidden list");
  KK._resetKeys();
  await KK.loadSwitch(true);
  ok(KK.deskKey()?.publicKey.toBase58() === bAddr, "a restarted worker stays on the live wallet (stored switch)");
  // a fresh process whose Redis read of the switch failed: the desk state still knows
  KK._resetKeys();
  await R.del(KK.SWITCH_KEY);
  KK.restoreSwitch(bAddr, a);
  ok(KK.deskKey()?.publicKey.toBase58() === bAddr, "the desk state alone also keeps it on the live wallet");
  // the live key removed after the switch: never back to the paper wallet
  const keep = process.env.DESK_LIVE_WALLET_SECRET;
  delete process.env.DESK_LIVE_WALLET_SECRET;
  ok(KK.deskKey() === null, "live key missing after the switch: no wallet at all, never the paper one");
  process.env.DESK_LIVE_WALLET_SECRET = keep;
  // the same key in both: nothing to switch
  KK._resetKeys();
  process.env.DESK_LIVE_WALLET_SECRET = process.env.DESK_WALLET_SECRET;
  ok(!KK.switchPending(), "the same key twice is not a switch");
  process.env.DESK_LIVE_WALLET_SECRET = keep;
  // on Vercel no key is ever loaded
  process.env.VERCEL = "1";
  ok(KK.paperKey() === null && KK.liveKey() === null, "Vercel never loads either key");
  delete process.env.VERCEL;
  await KK.markSwitch(a, bAddr);

  // ---- no trace of the paper wallet on the site
  const shortA = `${a.slice(0, 4)}…${a.slice(-4)}`;
  await R.lpush(K.deskEv, { agent: "LEDGER", at: 1, text: `desk wallet ${shortA} holds 0.6251 SOL. paper desk restarted from that real balance`, tone: "win" }, { agent: "EXEC", at: 2, text: "bought $X", tone: "ok" });
  await R.lpush("rn:ag:ev:LEDGER", { agent: "LEDGER", at: 1, text: `desk wallet ${shortA} found`, tone: "info" });
  await R.lpush(K.feed, { kind: "desk", rat: "DESK·LEDGER", text: `desk wallet ${shortA} holds 0.6 SOL`, at: 1 }, { kind: "rat", text: "dug $Y", at: 2 });
  await R.hset(K.deskAgent, { LEDGER: { agent: "LEDGER", text: `wallet ${a}`, at: 3 } });
  await R.set(K.deskExam, { wallet: a });
  const n = await D.scrubWallet(a);
  const ev = await R.lrange(K.deskEv, 0, -1);
  const feed = await R.lrange(K.feed, 0, -1);
  ok(n === 4 && ev.length === 1 && feed.length === 1 && !JSON.stringify([ev, feed]).includes(shortA), "log lines naming the paper wallet are removed, the rest kept");
  ok(!(await R.hget(K.deskAgent, "LEDGER")) && !(await R.get(K.deskExam)), "the agent's last line and the cached exam (both name the wallet) are cleared");
  // receipts: hours sealed by the paper wallet are hidden; the live wallet signs from now on
  const h = "2026-10-15T12";
  const h2 = "2026-10-15T13";
  await R.set(`rn:rc:s:${h}`, { hour: h, n: 3, sha: "x", memo: "m", sig: "s", at: 1, wallet: a });
  await R.set(`rn:rc:s:${h2}`, { hour: h2, n: 3, sha: "y", memo: "m", sig: "t", at: 2, wallet: bAddr });
  await R.zadd("rn:rc:idx", { score: 1, member: h }, { score: 2, member: h2 });
  ok((await RC.getHour(h)).seal === null && (await RC.getHour(h2)).seal?.wallet === bAddr, "an hour sealed by the paper wallet shows no seal; the live wallet's does");
  const list = await RC.getSeals(10);
  ok(list.length === 1 && list[0].wallet === bAddr, "the seal list leaves out the paper wallet's hours");
  const src = fs.readFileSync(new URL("../src/lib/receipts.ts", import.meta.url), "utf8");
  ok(/if \(!sec\) return deskKey\(\);/.test(src) && /await loadSwitch\(\);\n\s+const kp = signer\(\);/.test(src), "receipts are signed with the desk's current key (the live wallet after the switch)");
  ok(/hid\.has\(x\.wallet\)/.test(src) && /sealFor/.test(src), "seal lists, hour pages and coin pages hide retired wallets");

  // ---- the promotion: exam reads the live wallet, switches first, then goes live on it
  const dk = fs.readFileSync(new URL("../src/lib/desk.ts", import.meta.url), "utf8");
  ok(/switchPending\(\) \? "funded live wallet" : "funded wallet"/.test(dk), "exam row: funded live wallet while the switch waits");
  ok(/const examWallet = \(walletSol: number \| null\) => \(switchPending\(\) \? NEXT_BAL : walletSol\);/.test(dk) && (dk.match(/exam\(state, examWallet\(walletSol\)\)/g) || []).length >= 4, "every exam check reads the live wallet's balance until the switch");
  const promo = dk.slice(dk.indexOf("v0.1.79: switch to the separate live wallet first"), dk.indexOf("// close-all stays on"));
  ok(promo.indexOf("await markSwitch(from, to)") > 0 && promo.indexOf("await markSwitch(from, to)") < promo.indexOf("state.live = true"), "the switch happens before live trading starts");
  ok(/nb < EXAM\.minWallet\) \{\n\s+go = false;/.test(promo), "not funded (under 0.5 SOL): no switch, no live, a log line instead");
  ok(/kp = nk;[\s\S]{0,200}state\.wallet = to;\n\s+state\.liveWallet = to;\n\s+state\.funded = nb;/.test(promo), "the desk's key, balance and books move to the live wallet in the same beat");
  ok(/await scrubWallet\(from\)/.test(promo), "the paper wallet is scrubbed from the logs at the switch");
  ok(/const addr = addr0 && !hid\.has\(addr0\) \? addr0 : null;/.test(dk), "the desk page never shows a hidden wallet");
  ok(/restoreSwitch\(state\.liveWallet\)/.test(dk), "every desk session restores the switch from its own state");

  const { BUILD } = await import("../src/config/build");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  ok(BUILD === pkg.version, `build tag ${BUILD}`);
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
