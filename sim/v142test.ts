// v0.1.142: a new live wallet key replaces the old one (the old key may have leaked). Run: npx tsx sim/v142test.ts
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
  const A = Keypair.generate(); // paper wallet (retired)
  const B = Keypair.generate(); // old live wallet
  const C = Keypair.generate(); // new live wallet
  const a = A.publicKey.toBase58();
  const b = B.publicKey.toBase58();
  const c = C.publicKey.toBase58();
  delete process.env.VERCEL;
  delete process.env.DESK_WALLET_SECRET;
  process.env.DESK_LIVE_WALLET_SECRET = bs58.encode(B.secretKey);
  const KK = await import("../src/lib/deskkey");
  await KK.markSwitch(a, b);
  ok((await KK.rotateLive()) === null, "same live key: nothing moves");
  ok(KK.deskKey()?.publicKey.toBase58() === b, "the desk trades the old live wallet");

  delete process.env.DESK_LIVE_WALLET_SECRET;
  ok((await KK.rotateLive()) === null && KK.deskKey() === null, "no live key: no wallet, nothing moves");

  process.env.DESK_LIVE_WALLET_SECRET = bs58.encode(C.secretKey);
  ok(KK.deskKey() === null, "before the move the new key is not used (it is not the stored wallet)");
  const m = await KK.rotateLive();
  ok(!!m && m.from === b && m.to === c, "a new live key: the desk moves from the old to the new wallet");
  ok(KK.deskKey()?.publicKey.toBase58() === c, "the desk trades the new wallet");
  ok((await KK.hiddenWallets()).has(b), "the old live wallet is hidden on the site");
  KK._resetKeys();
  await KK.loadSwitch(true);
  ok(KK.deskKey()?.publicKey.toBase58() === c, "a restarted worker stays on the new wallet");
  ok((await KK.rotateLive()) === null, "and does not move again");

  process.env.DESK_WALLET_SECRET = bs58.encode(A.secretKey);
  process.env.DESK_LIVE_WALLET_SECRET = bs58.encode(A.secretKey);
  ok((await KK.rotateLive()) === null && KK.deskKey() === null, "never moves to the paper wallet");

  const fs = await import("fs");
  const src = fs.readFileSync("src/lib/desk.ts", "utf8");
  const iRot = src.indexOf("await rotateLive()");
  const iSync = src.indexOf("state = await syncWallet(state, kp0");
  ok(iRot > 0 && iSync > iRot, "the move runs before syncWallet (which would wipe the books on a new address)");
  const blk = src.slice(iRot, iSync);
  ok(/resetDesk\("new live wallet"\)/.test(blk) && /liveFundedSol: Math\.round\(nb/.test(blk), "a new wallet starts the desk over: books wiped, record measured from the new balance");
  console.log(fail ? `${fail} FAILED` : "all ok");
  process.exit(fail ? 1 : 0);
})();
