// The Helius feed (v0.1.34: account prices of open positions; v0.1.32 streamed whole transactions). A position on the
// curve is followed through its curve account, a migrated one through its pool's two vaults.
// Run: npx tsx sim/v032test.ts
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
  const { Keypair } = await import("@solana/web3.js");
  const { bondingCurvePda } = await import("../src/lib/solana");
  const { POOLS_KEY } = await import("../src/lib/pool");
  const onCurve = Keypair.generate().publicKey.toBase58();
  const migrated = Keypair.generate().publicKey.toBase58();
  const curve = bondingCurvePda(onCurve);
  const bv = Keypair.generate().publicKey.toBase58();
  const qv = Keypair.generate().publicKey.toBase58();
  await R.hset(POOLS_KEY, { [migrated]: { pool: "P", bv, qv, vq: 0 } });

  // curve account: vTok 1,000M tokens, vSol 40 SOL, real SOL 10, supply 1B, not complete
  const cb = Buffer.alloc(150);
  cb.writeBigUInt64LE(1_000_000_000n * 1_000_000n, 8);
  cb.writeBigUInt64LE(40n * 1_000_000_000n, 16);
  cb.writeBigUInt64LE(700_000_000n * 1_000_000n, 24);
  cb.writeBigUInt64LE(10n * 1_000_000_000n, 32);
  cb.writeBigUInt64LE(1_000_000_000n * 1_000_000n, 40);
  const vaultBuf = (amt: bigint) => {
    const b = Buffer.alloc(165);
    b.writeBigUInt64LE(amt, 64);
    return b;
  };
  const note = (sub: number, slot: number, data: Buffer) => JSON.stringify({ jsonrpc: "2.0", method: "accountNotification", params: { subscription: sub, result: { context: { slot }, value: { data: [data.toString("base64"), "base64"] } } } });

  const sent: any[] = [];
  const subs = new Map<string, number>();
  let sock: any = null;
  class FakeWS {
    onopen: any;
    onmessage: any;
    onclose: any;
    onerror: any;
    constructor(public url: string) {
      sock = this;
      setTimeout(() => this.onopen?.(), 5);
    }
    send(s: string) {
      const j = JSON.parse(s);
      sent.push(j);
      if (j.method === "accountSubscribe") {
        const sid = 100 + subs.size;
        subs.set(j.params[0], sid);
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: j.id, result: sid }) }), 2);
      }
    }
  }
  (globalThis as any).WebSocket = FakeWS;
  const { heliusFeed } = await import("../src/lib/heliusfeed");
  const got: any[] = [];
  const feed = heliusFeed({ want: async () => new Set([onCurve, migrated]), onQuote: (q) => got.push(q) });
  await new Promise((r) => setTimeout(r, 100));
  const addrs = sent.filter((x) => x.method === "accountSubscribe").map((x) => x.params[0]);
  ok(addrs.includes(curve) && addrs.includes(bv) && addrs.includes(qv), "follows the curve account and the pool's two vaults");
  ok(!sent.some((x) => x.method === "transactionSubscribe"), "no transaction stream (the expensive one)");
  ok(feed.live().has(onCurve) && feed.live().has(migrated), "both positions are confirmed live");

  sock.onmessage({ data: note(subs.get(curve)!, 5, cb) });
  const c = got.find((q) => q.mint === onCurve);
  ok(!!c && c.curve && Math.abs(c.px - 40 / 1e9) < 1e-15 && c.real === 10, `curve price from the account (${c?.px} SOL per token, ${c?.real} SOL in)`);

  // a swap: both vaults change in slot 7, as two notifications. No price from a half-updated pair.
  sock.onmessage({ data: note(subs.get(bv)!, 7, vaultBuf(200_000_000n * 1_000_000n)) });
  sock.onmessage({ data: note(subs.get(qv)!, 6, vaultBuf(100n * 1_000_000_000n)) });
  ok(!got.some((q) => q.mint === migrated), "vaults from different slots: no price yet");
  sock.onmessage({ data: note(subs.get(qv)!, 7, vaultBuf(98n * 1_000_000_000n)) });
  const p = got.find((q) => q.mint === migrated);
  ok(!!p && !p.curve && Math.abs(p.px - 98 / 200_000_000) < 1e-15, "pool price once both vaults are from the same slot");

  // budget: a message is a few hundred bytes
  const bytes = note(subs.get(curve)!, 5, cb).length;
  ok(bytes < 1000, `one curve update is ${bytes} bytes (a v0.1.32 trade message was ~50 KB)`);
  const { rpcStats } = await import("../src/lib/solana");
  ok(rpcStats.byLane[1] >= 0, "websocket data is counted against the day's credits");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.32/34 feed checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
