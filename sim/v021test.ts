// v0.1.21 checks: launches from the stream are dug at once, the chain backfill skips what the stream brought, the
// fast lane makes the minute-1 read and minute-5 call on time, FLASH reads the first seconds, learns, earns its
// gate and signals the desk.
import { MockRedis } from "./mockredis";
import { Keypair } from "@solana/web3.js";
const R = new MockRedis();
(globalThis as any).__rnRedis = R;
let NOW = Date.UTC(2026, 9, 7, 16, 0, 0);
Date.now = () => NOW;
const addr = () => Keypair.generate().publicKey.toBase58();
let parsed = 0;
(globalThis as any).__rnConn = {
  getMultipleAccountsInfo: async (keys: any[]) => keys.map(() => null),
  getAccountInfo: async () => null,
  getSignaturesForAddress: async () => SIGS.map((s) => ({ signature: s, err: null, blockTime: Math.floor(NOW / 1000) - 60 })),
  getParsedTransaction: async () => {
    parsed++;
    return null;
  },
  getBalance: async () => 0,
};
(globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
let SIGS: string[] = [];
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};

async function main() {
  const dg = await import("../src/lib/digger");
  const { K } = await import("../src/lib/redis");
  const fl = await import("../src/lib/flash");

  // --- 1. stream intake: dug at once, checkpoints set, signature remembered
  const items = Array.from({ length: 5 }, (_, i) => ({ mint: addr(), sig: `sig${i}`, creator: addr(), name: `Coin ${i}`, symbol: `C${i}`, uri: "", devBuySol: 1, createdAt: NOW }));
  const res: any = await dg.ingestStream(items);
  const rec: any = await R.get(K.launch(items[0].mint));
  ok(res.dug === 5 && rec && rec.dugAt - rec.createdAt < 2000, `stream intake dug ${res.dug} launches, ${rec ? rec.dugAt - rec.createdAt : "?"}ms after birth`);
  const due = await R.zrange(K.due, 0, -1);
  ok(due.filter((d: string) => d.startsWith(items[0].mint)).length >= 2, "minute-1 and minute-5 checkpoints set");
  const again: any = await dg.ingestStream(items);
  ok(again.dug === 0, "the same launch is never dug twice");

  // --- 2. chain backfill skips what the stream delivered (no parse, no RPC)
  SIGS = [...items.map((x) => x.sig), "sigX"];
  parsed = 0;
  await dg.digFast();
  ok(parsed === 1, `chain backfill parsed only the 1 launch the stream missed (parsed ${parsed})`);

  // --- 3. FLASH: looks, labels, gate, signal
  const stats = (strong: boolean) => ({ age: 15, prog: strong ? 30 : 3, mcSol: strong ? 45 : 29, buys: strong ? 40 : 3, sells: strong ? 4 : 2, uniq: strong ? 35 : 3, netSol: strong ? 12 : 0.2, devSol: 1, devSold: !strong && Math.random() < 0.5, big: strong ? 2 : 0.1, first2s: strong ? 0.2 : 0.8, top3: strong ? 0.25 : 0.9, rate10: strong ? 15 : 0 });
  // 700 launches: the strong ones bond, the weak ones don't
  for (let round = 0; round < 7; round++) {
    const looks: any[] = [];
    for (let i = 0; i < 100; i++) {
      const strong = i % 10 === 0;
      const mint = addr();
      await R.set(K.launch(mint), { mint, symbol: "S", createdAt: NOW, devN: 0, devB: 0, cp: {} });
      looks.push({ mint, stage: 15, at: NOW + 15_000, createdAt: NOW, st: stats(strong), sym: "S", strong });
    }
    await fl.flashLook(looks);
    // the strong ones bond 20 minutes in
    for (const l of looks) if (l.strong) await R.set(K.launch(l.mint), { mint: l.mint, symbol: "S", createdAt: NOW, devN: 0, devB: 0, completeAt: NOW + 20 * 60_000, cp: {} });
    NOW += 61 * 60_000;
    await fl.flashFollow();
  }
  const v: any = await fl.flashView();
  const s15 = v.stages.find((x: any) => x.stage === 15);
  ok(v.model.ready && s15.n === 700, `FLASH learned from ${s15.n} labelled 15s looks (model ${v.model.n}, ${v.model.pos} bonds)`);
  ok(!!s15.cut, `the 15s look earned its gate: ${JSON.stringify(s15.cut)}`);
  const m = addr();
  await R.set(K.launch(m), { mint: m, symbol: "GO", createdAt: NOW, devN: 0, devB: 0, cp: {} });
  await fl.flashLook([{ mint: m, stage: 15, at: NOW, createdAt: NOW - 15_000, st: stats(true) as any, sym: "GO" }]);
  const q = await R.zrange(K.deskQ, 0, -1);
  ok(q.includes(`f:${m}`), "a strong 15s look goes to the desk");
  const w = addr();
  await R.set(K.launch(w), { mint: w, symbol: "NO", createdAt: NOW, devN: 0, devB: 0, cp: {} });
  await fl.flashLook([{ mint: w, stage: 15, at: NOW, createdAt: NOW - 15_000, st: { ...stats(false), devSold: true } as any, sym: "NO" }]);
  ok(!(await R.zrange(K.deskQ, 0, -1)).includes(`f:${w}`), "a weak look (dev sold) does not");

  // --- 4. stream stats: block-0 buying we never saw is counted as early buying
  const c: any = { t0: NOW, mint: m, sym: "GO", creator: "dev", devSol: 1, vSol: 30 + 1 + 6 + 2, vTok: 1_000_000_000, mcSol: 40, trades: [{ t: NOW + 5000, side: "buy", sol: 2, w: "a" }], done: [] };
  const st = fl.streamStats(c, NOW + 15_000);
  ok(st.first2s >= 0.7 && st.buys === 1 && st.prog > 9, `6 SOL bought in the launch block shows as early buying (${st.first2s}), curve ${st.prog}%`);

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.21 checks passed");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
