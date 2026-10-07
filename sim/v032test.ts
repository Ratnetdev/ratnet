// v0.1.32 checks: the Helius trade feed. Trades for followed coins arrive as transactions (curve or canonical pool)
// and come out as the same trade messages PumpPortal used to send. Run: npx tsx sim/v032test.ts
process.env.HELIUS_RPC_URL = "https://rpc.example/?api-key=x";
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const { Keypair } = await import("@solana/web3.js");
  const { bondingCurvePda } = await import("../src/lib/solana");
  const { canonicalPool } = await import("../src/lib/pool");
  const mint = Keypair.generate().publicKey.toBase58();
  const trader = Keypair.generate().publicKey.toBase58();
  const curve = bondingCurvePda(mint);
  const pool = canonicalPool(mint);
  const WSOL = "So11111111111111111111111111111111111111112";
  // a curve buy: 1 SOL into the curve, 30M tokens to the trader ("accounts" details: no message wrapper)
  const curveNote = {
    slot: 9,
    signature: "s1",
    transaction: {
      version: 0,
      transaction: { signatures: ["s1"], accountKeys: [{ pubkey: trader, signer: true, writable: true }, { pubkey: curve, signer: false, writable: true }] },
      meta: { err: null, preBalances: [5e9, 10.0016e9], postBalances: [4e9, 11.0016e9], preTokenBalances: [{ accountIndex: 0, mint, owner: trader, uiTokenAmount: { uiAmount: 0 } }], postTokenBalances: [{ accountIndex: 0, mint, owner: trader, uiTokenAmount: { uiAmount: 30_000_000 } }] },
    },
  };
  // a pool sell: 2 SOL out of the pool's WSOL vault
  const poolNote = {
    slot: 10,
    signature: "s2",
    transaction: {
      version: 1,
      transaction: { signatures: ["s2"], accountKeys: [{ pubkey: trader, signer: true, writable: true }, { pubkey: pool, signer: false, writable: true }] },
      meta: {
        err: null,
        preBalances: [1, 1],
        postBalances: [1, 1],
        preTokenBalances: [{ accountIndex: 2, mint: WSOL, owner: pool, uiTokenAmount: { uiAmount: 100 } }, { accountIndex: 3, mint, owner: pool, uiTokenAmount: { uiAmount: 200_000_000 } }, { accountIndex: 4, mint, owner: trader, uiTokenAmount: { uiAmount: 5_000_000 } }],
        postTokenBalances: [{ accountIndex: 2, mint: WSOL, owner: pool, uiTokenAmount: { uiAmount: 98 } }, { accountIndex: 3, mint, owner: pool, uiTokenAmount: { uiAmount: 205_000_000 } }, { accountIndex: 4, mint, owner: trader, uiTokenAmount: { uiAmount: 0 } }],
      },
    },
  };
  // a fake websocket: confirms every subscription, then plays the two notifications
  const sent: any[] = [];
  class FakeWS {
    onopen: any;
    onmessage: any;
    onclose: any;
    onerror: any;
    constructor(public url: string) {
      setTimeout(() => this.onopen?.(), 5);
    }
    send(s: string) {
      const j = JSON.parse(s);
      sent.push(j);
      if (j.method === "transactionSubscribe") {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: j.id, result: 77 }) }), 5);
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "transactionNotification", params: { subscription: 77, result: curveNote } }) }), 10);
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "transactionNotification", params: { subscription: 77, result: poolNote } }) }), 15);
      }
    }
  }
  (globalThis as any).WebSocket = FakeWS;
  const { heliusFeed } = await import("../src/lib/heliusfeed");
  const got: any[] = [];
  const feed = heliusFeed({ want: async () => new Set([mint]), onTrade: (t) => got.push(t) });
  await new Promise((r) => setTimeout(r, 200));
  const sub = sent.find((x) => x.method === "transactionSubscribe");
  ok(!!sub && sub.params[0].accountInclude.includes(curve) && sub.params[0].accountInclude.includes(pool), "one subscription covers the coin's curve and its canonical pool");
  ok(sub?.params[1].transactionDetails === "accounts" && sub?.params[1].maxSupportedTransactionVersion === 1, "small messages (keys and balances), version 1 transactions included");
  const b = got.find((t) => t.pool === "pump");
  ok(!!b && b.txType === "buy" && Math.abs(b.solAmount - 1) < 1e-9 && b.traderPublicKey === trader && Math.abs(b.tokenAmount - 30_000_000) < 1, "a curve buy: side, SOL, trader and tokens");
  ok(!!b && Math.abs(b.vSolInBondingCurve - 41) < 1e-6 && b.marketCapSol > 27.96, `curve reserves and market cap after the trade (${b?.marketCapSol?.toFixed(1)} SOL)`);
  const s = got.find((t) => t.pool === "pump-amm");
  ok(!!s && s.txType === "sell" && Math.abs(s.solAmount - 2) < 1e-9 && Math.abs(s.marketCapSol - (98 / 205_000_000) * 1e9) < 1e-6, "a pool sell: side, SOL out of the vault, price from the vaults");
  ok(feed.view().trades === 2 && feed.view().up, "the feed counts its trades");
  const { rpcStats } = await import("../src/lib/solana");
  ok(rpcStats.byLane[1] >= 0, "websocket data is counted against the day's credits");

  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.32 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
