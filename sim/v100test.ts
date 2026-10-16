// v0.1.100: the audit's fixes. Run: npx tsx sim/v100test.ts
process.env.RATNET_WORKER = "1"; // the worker's launch cache on (the late-batch bug only showed with it)
process.env.HELIUS_RPC_URL = "https://rpc.example/?api-key=x";
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
  const { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram } = await import("@solana/web3.js");
  const T = await import("@solana/spl-token");
  const E = await import("../src/lib/exec");
  const kp = Keypair.generate();
  const me = kp.publicKey;
  const WSOL = "So11111111111111111111111111111111111111112";
  const mint = Keypair.generate().publicKey.toBase58();
  const stranger = Keypair.generate().publicKey;
  const ata = new PublicKey([...E.ownAtas(me, mint)][0]);
  const wata = new PublicKey([...E.ownAtas(me, WSOL)][0]);
  const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  const route = (dest: any) => new TransactionInstruction({ programId: JUP, keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }], data: Buffer.from([1]) });
  const build = (ixs: any[]) => new VersionedTransaction(new TransactionMessage({ payerKey: me, recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", instructions: ixs }).compileToV0Message());
  const amountIn = 50_000_000n; // 0.05 SOL buy
  const tip = (sol: number) => SystemProgram.transfer({ fromPubkey: me, toPubkey: new PublicKey(E.TIP[0]), lamports: Math.round(sol * 1e9) });
  const tries = (ixs: any[]) => {
    try {
      E.vetTx(build(ixs), me, [], mint, { inputMint: WSOL, amountIn, tipMaxSol: 0.002 });
      return "";
    } catch (e: any) {
      return String(e.message);
    }
  };
  const normal = [T.createAssociatedTokenAccountIdempotentInstruction(me, wata, me, new PublicKey(WSOL)), SystemProgram.transfer({ fromPubkey: me, toPubkey: wata, lamports: Number(amountIn) }), T.createSyncNativeInstruction(wata), T.createAssociatedTokenAccountIdempotentInstruction(me, ata, me, new PublicKey(mint)), route(ata), tip(0.0002)];
  ok(tries(normal) === "", "a normal 0.05 SOL buy (wrap, own accounts, tip) is signed");
  // the audit's drain: an account made with a seed, funded with the wallet, handed to a stranger as a wSOL account
  const seedAcc = await PublicKey.createWithSeed(me, "x", T.TOKEN_PROGRAM_ID);
  const seedIx = (sol: number) => SystemProgram.createAccountWithSeed({ fromPubkey: me, basePubkey: me, seed: "x", newAccountPubkey: seedAcc, lamports: Math.round(sol * 1e9), space: 165, programId: T.TOKEN_PROGRAM_ID });
  ok(/someone other than the desk wallet/.test(tries([seedIx(0.0021), T.createInitializeAccount3Instruction(seedAcc, new PublicKey(WSOL), stranger), route(ata)])), "a seeded account handed to a stranger is refused");
  ok(/into wSOL\/new accounts refused/.test(tries([seedIx(1.5), T.createInitializeAccount3Instruction(seedAcc, new PublicKey(WSOL), me), route(ata)])), "1.5 SOL into a new account on a 0.05 SOL buy is refused");
  ok(/tip of/.test(tries([...normal.slice(0, 5), tip(1)])), "a 1 SOL tip is refused");
  ok(/into wSOL/.test(tries([SystemProgram.transfer({ fromPubkey: me, toPubkey: wata, lamports: 1e9 }), route(ata)])), "1 SOL into the wallet's own wSOL on a 0.05 buy is refused");
  ok(/refused/.test(tries([SystemProgram.createAccount({ fromPubkey: me, newAccountPubkey: stranger, lamports: 1e6, space: 0, programId: T.TOKEN_PROGRAM_ID }), route(ata)])), "plain account creation is refused");
  ok(/someone other/.test(tries([T.createInitializeAccountInstruction(wata, new PublicKey(WSOL), stranger), route(ata)])), "InitializeAccount with a stranger as owner is refused");

  // simulation: the wallet must end up as the quote says
  const acct = (lamports: number, tok: bigint) => {
    const d = Buffer.alloc(165);
    d.writeBigUInt64LE(tok, 64);
    return { lamports, data: d };
  };
  const simWith = (post: { lam: number; tok: bigint }, err: any = null) =>
    ((globalThis as any).__rnConn = {
      getMultipleAccountsInfo: async (keys: any[]) => [{ lamports: 1e9, data: Buffer.alloc(0) }, ...keys.slice(1).map(() => null)],
      simulateTransaction: async (_tx: any, cfg: any) => ({ value: { err, accounts: cfg.accounts.addresses.map((_: any, i: number) => (i === 0 ? { lamports: post.lam, data: ["", "base64"] } : i === 1 ? { lamports: 2e6, data: [acct(0, post.tok).data.toString("base64"), "base64"] } : null)) } }),
    });
  const tx = build(normal);
  simWith({ lam: 1e9 - 53_000_000, tok: 1_000_000n });
  ok((await E.simCheck(tx, me, WSOL, mint, amountIn, 900_000n)).checked === true, "simulation: a buy that spends 0.053 and lands 1M tokens (min 900K) passes");
  simWith({ lam: 1e9 - 53_000_000, tok: 100n });
  ok(/minimum/.test(await E.simCheck(tx, me, WSOL, mint, amountIn, 900_000n).then(() => "", (e) => e.message)), "simulation: tokens going elsewhere (100 land, min 900K) refused");
  simWith({ lam: 1e8, tok: 1_000_000n });
  ok(/would lose/.test(await E.simCheck(tx, me, WSOL, mint, amountIn, 900_000n).then(() => "", (e) => e.message)), "simulation: a buy that drains 0.9 SOL refused");
  simWith({ lam: 1e9, tok: 0n }, { InstructionError: [4, "Custom"] });
  ok(/fails/.test(await E.simCheck(tx, me, WSOL, mint, amountIn, 900_000n).then(() => "", (e) => e.message)), "simulation: a swap that fails is not sent");
  (globalThis as any).__rnConn = { getMultipleAccountsInfo: async () => { throw new Error("rpc down"); }, simulateTransaction: async () => ({}) };
  ok((await E.simCheck(tx, me, WSOL, mint, amountIn, 900_000n)).checked === false, "simulation: an RPC failure never blocks a trade (a stop must go out)");
  const ex = fs.readFileSync("src/lib/exec.ts", "utf8");
  ok((ex.match(/await simCheck\(tx, kp\.publicKey/g) || []).length === 2, "both swap paths simulate before signing");

  // Redis REST: server commands refused
  const RR = await import("../src/lib/redisrest");
  const fake: any = { call: async () => "OK", pipeline: () => ({ call() {}, exec: async () => [] }), multi: () => ({ call() {}, exec: async () => [] }) };
  ok((await RR.answer(fake, "/", JSON.stringify(["CONFIG", "SET", "dir", "/tmp"]))).status === 400, "REST: CONFIG refused");
  ok((await RR.answer(fake, "/pipeline", JSON.stringify([["GET", "a"], ["flushall"]]))).status === 400, "REST: FLUSHALL inside a pipeline refused");
  ok((await RR.answer(fake, "/", JSON.stringify(["GET", "a"]))).status === 200, "REST: normal commands pass");

  // settings: bounds enforced on read
  const DB = await import("../src/lib/deskbounds");
  const c: any = DB.clampDesk({ maxSol: 1000, slippageBps: 10000, sizePct: "x" } as any, { sizePct: 5 });
  ok(c.maxSol === 5 && c.slippageBps === 3000 && c.sizePct === 5, "settings read: maxSol 1000 -> 5, slippage 100% -> 30%, junk -> default");

  // a coin never dug costs no chain read
  let chainReads = 0;
  (globalThis as any).__rnConn = { getMultipleAccountsInfo: async (k: any[]) => (chainReads++, k.map(() => null)) };
  (globalThis as any).fetch = async () => ((chainReads++), new Response("{}"));
  const S = await import("../src/lib/stats");
  const got = await S.getCoin(Keypair.generate().publicKey.toBase58());
  ok(!got.launch && !got.call && chainReads === 0, "an address the rats never dug: no chain or DexScreener read");

  // the late intake batch no longer loses its launch (worker cache on)
  let NOW = Date.UTC(2026, 9, 16, 22, 0, 0);
  const realNow = Date.now;
  Date.now = () => NOW;
  (globalThis as any).__rnConn = { getMultipleAccountsInfo: async (k: any[]) => k.map(() => null), getAccountInfo: async () => null, getSignaturesForAddress: async () => [], getParsedTransaction: async () => null, getBalance: async () => 0 };
  (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
  const dg = await import("../src/lib/digger");
  const { K } = await import("../src/lib/redis");
  const item = { mint: Keypair.generate().publicKey.toBase58(), sig: "sigLate", creator: Keypair.generate().publicKey.toBase58(), name: "Late", symbol: "LATE", uri: "", devBuySol: 1, createdAt: NOW };
  const hmget = R.hmget.bind(R);
  const held: (() => void)[] = [];
  (R as any).hmget = (...a: any[]) => new Promise((go) => held.push(() => go(hmget(...(a as [any, any])))));
  let done: any = null;
  dg.ingestStream([item]).then((x) => (done = x));
  await new Promise((r) => setTimeout(r, 40));
  NOW += 16_000;
  held.splice(0).forEach((f) => f());
  for (let i = 0; i < 30 && !done; i++) await new Promise((r) => setTimeout(r, 20));
  (R as any).hmget = hmget;
  const L = await import("../src/lib/launches");
  ok(done?.late === 1 && !(await L.getLaunch(item.mint)), "a late batch leaves nothing behind, not even in the worker's cache");
  NOW += 10_000;
  const again: any = await dg.ingestStream([item]);
  ok(again.dug === 1 && !!(await R.get(K.launch(item.mint))), "so the next dig stores it");
  Date.now = realNow;

  // LIVE BENCH: the trip that benches still counts in the record
  const pm = await import("../src/lib/pm");
  for (let i = 0; i < 10; i++) await pm.onClose("wire", Math.log(0.7), true, 0);
  const wv: any = (await pm.pmView()).find((x: any) => x.sleeve === "wire");
  ok(wv.trades === 10 && !!wv.bench, `the benching trip is in the record (${wv.trades} trades)`);

  // review: marked sent only after the send
  const rv = await import("../src/lib/review");
  const t = Date.UTC(2026, 9, 18, 7, 0);
  await rv.dailyReview(async () => { throw new Error("telegram down"); }, t).catch(() => null);
  const sent: string[] = [];
  await rv.dailyReview(async (x) => sent.push(x), t + 600_000);
  ok(sent.length === 1, "a failed send is retried 10 minutes later");

  // files: worker handover, runner paths kept, solUsd timeout, flow kept, sells wait for a pending one
  const w = fs.readFileSync("worker/index.ts", "utf8");
  const desk = fs.readFileSync("src/lib/desk.ts", "utf8");
  ok(/rn:worker:gen/.test(w) && /releaseDeskLock/.test(w), "a newer worker makes the old one hand over");
  ok(/loadRunTrack\(\)/.test(w) && /rn:archive:runtrack/.test(fs.readFileSync("src/lib/archive.ts", "utf8")), "runner paths survive a restart");
  ok(/AbortSignal\.timeout\(3000\) \}\);\n\s*const j: any = await r\.json\(\);\n\s*const p = Number\(j\?\.So111/.test(fs.readFileSync("src/lib/solana.ts", "utf8")), "the SOL price read gives up after 3s");
  ok(/state\.liveFlow = FLOW_RESTORED/.test(desk) && /pendSell\?\.side === "sell"/.test(desk), "trade flow survives a restart; a sell waits for a pending one");
  ok(/evictLast\(now\)/.test(fs.readFileSync("src/lib/gridlive.ts", "utf8")), "GRID LIVE trims its price map on a timer");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(pkg.version === "0.1.100" && fs.readFileSync("src/config/build.ts", "utf8").includes('"0.1.100"'), "v0.1.100");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.100 checks pass");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
