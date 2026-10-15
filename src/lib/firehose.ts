// v0.1.81: the FIREHOSE. Every pump.fun and PumpSwap transaction, from Shyft's Yellowstone gRPC (SHYFT_GRPC_URL,
// SHYFT_GRPC_TOKEN, Railway only). Before this the rats saw a coin's curve for its first 7 minutes (plus an hour after a
// King call) and individual trades only for a shortlist. Now every trade on every coin, for its whole life:
//   - curve updates for every coin (GRID LIVE's every-launch books see coins at any age)
//   - pool prices for every migrated coin (not only 6 hours after the migration)
//   - every buyer and seller (WALLETS, TAPE ALL)
// One connection, reconnects by itself with backoff; nothing here can block the desk.
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, WSOL_MINT, curveOf, eventsOf, isSolQuote, type PumpEv, type SwapEv, type TradeEv } from "./pumpevents";

export type FireTrade = { mint: string; user: string; isBuy: boolean; sol: number; tokens: number; at: number; venue: "curve" | "pool"; creator?: string; sig?: string; prog?: number };
export type FireCurve = { progress: number; mcapSol: number; realSol: number; complete: boolean; priceSol: number; supply: number };
export type FireHandlers = {
  trade?: (t: FireTrade) => void;
  curve?: (mint: string, v: FireCurve) => void;
  pool?: (mint: string, q: { mcSol: number; real: number; pool: string }) => void;
  create?: (c: { mint: string; symbol: string; name: string; creator: string; at: number }) => void;
  complete?: (mint: string, at: number) => void;
};

export const fireStats = { up: false, since: 0, msgs: 0, trades: 0, curveTrades: 0, poolTrades: 0, creates: 0, completes: 0, errors: 0, reconnects: 0, lastAt: 0, lastErr: "" };
const POOL_MINT = new Map<string, string>(); // PumpSwap pool -> base mint
export const poolMintOf = (pool: string) => POOL_MINT.get(pool) || null;

/** One transaction's events, turned into what the handlers want. Pure apart from the pool map (tests use it directly). */
export function handleTx(evs: PumpEv[], tokenMints: string[], h: FireHandlers, sig?: string, now = Date.now()) {
  // a PumpSwap trade names its pool, not its coin: the coin is the one non-SOL mint in the transaction's balances
  const others = [...new Set(tokenMints.filter((m) => m && m !== WSOL_MINT))];
  for (const ev of evs) {
    if (ev.kind === "createPool") {
      if (isSolQuote(ev.quoteMint)) POOL_MINT.set(ev.pool, ev.baseMint);
      continue;
    }
    if (ev.kind === "create") {
      fireStats.creates++;
      h.create?.({ mint: ev.mint, symbol: ev.symbol, name: ev.name, creator: ev.creator, at: ev.ts ? ev.ts * 1000 : now });
      continue;
    }
    if (ev.kind === "complete") {
      fireStats.completes++;
      h.complete?.(ev.mint, ev.ts ? ev.ts * 1000 : now);
      continue;
    }
    if (ev.kind === "trade") {
      const t = ev as TradeEv;
      if (!isSolQuote(t.quoteMint)) continue; // curves quoted in another token: no SOL price
      fireStats.trades++;
      fireStats.curveTrades++;
      const cv = curveOf(t);
      h.trade?.({ mint: t.mint, user: t.user, isBuy: t.isBuy, sol: Number(t.sol) / 1e9, tokens: Number(t.tokens) / 1e6, at: t.ts ? t.ts * 1000 : now, venue: "curve", creator: t.creator, sig, prog: cv.progress });
      h.curve?.(t.mint, cv);
      continue;
    }
    if (ev.kind === "swap") {
      const s = ev as SwapEv;
      let mint = POOL_MINT.get(s.pool);
      if (!mint && others.length === 1) {
        mint = others[0];
        POOL_MINT.set(s.pool, mint);
        if (POOL_MINT.size > 200_000) POOL_MINT.delete(POOL_MINT.keys().next().value as string);
      }
      if (!mint) continue;
      fireStats.trades++;
      fireStats.poolTrades++;
      h.trade?.({ mint, user: s.user, isBuy: s.isBuy, sol: Number(s.quote) / 1e9, tokens: Number(s.base) / 1e6, at: s.ts ? s.ts * 1000 : now, venue: "pool", creator: s.creator, sig });
      const base = Number(s.poolBase) / 1e6;
      const quote = Number(s.poolQuote) / 1e9;
      if (base > 0 && quote > 0) h.pool?.(mint, { mcSol: Math.round((quote / base) * 1e9 * 100) / 100, real: Math.round(quote * 100) / 100, pool: s.pool });
    }
  }
}

let STOP = false;
/** Start the firehose (worker). Returns false when it is not configured. */
export async function startFirehose(h: FireHandlers): Promise<boolean> {
  const url = (process.env.SHYFT_GRPC_URL || "").trim();
  const token = (process.env.SHYFT_GRPC_TOKEN || "").trim();
  if (!url || !token) return false;
  const mod: any = await import("@triton-one/yellowstone-grpc");
  const Client = mod.default;
  const Commitment = mod.CommitmentLevel;
  STOP = false;
  let wait = 2_000;
  const run = async () => {
    while (!STOP) {
      try {
        const client = new Client(url, token, { "grpc.max_receive_message_length": 64 * 1024 * 1024 });
        await client.connect();
        const stream = await client.subscribe();
        const done = new Promise<void>((resolve) => {
          stream.on("error", (e: any) => {
            fireStats.errors++;
            fireStats.lastErr = String(e?.message || e).slice(0, 160);
            resolve();
          });
          stream.on("end", () => resolve());
          stream.on("close", () => resolve());
        });
        stream.on("data", (u: any) => {
          fireStats.msgs++;
          fireStats.lastAt = Date.now();
          const tx = u?.transaction?.transaction;
          if (!tx?.meta || tx.meta.err) return;
          try {
            const inner = (tx.meta.innerInstructions || []).flatMap((x: any) => x.instructions || []);
            const evs = eventsOf(tx.meta.logMessages, inner);
            if (!evs.length) return;
            const mints = [...(tx.meta.postTokenBalances || []), ...(tx.meta.preTokenBalances || [])].map((b: any) => String(b.mint || ""));
            handleTx(evs, mints, h, undefined);
          } catch (e: any) {
            fireStats.errors++;
            fireStats.lastErr = String(e?.message || e).slice(0, 160);
          }
        });
        await new Promise<void>((resolve, reject) =>
          stream.write(
            {
              accounts: {},
              slots: {},
              transactions: { pump: { vote: false, failed: false, accountInclude: [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID], accountExclude: [], accountRequired: [] } },
              transactionsStatus: {},
              blocks: {},
              blocksMeta: {},
              entry: {},
              accountsDataSlice: [],
              commitment: Commitment.PROCESSED,
            },
            (e: any) => (e ? reject(e) : resolve()),
          ),
        );
        fireStats.up = true;
        fireStats.since = Date.now();
        wait = 2_000;
        // keep-alive: Shyft (like most Yellowstone hosts) closes idle streams; a ping every 15s keeps it open
        const ping = setInterval(() => stream.write({ ping: { id: 1 }, accounts: {}, slots: {}, transactions: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [] } as any, () => {}), 15_000);
        // a stream that goes silent for 60s is dead even if it never says so
        const watch = setInterval(() => {
          if (Date.now() - fireStats.lastAt > 60_000) stream.destroy?.();
        }, 15_000);
        await done;
        clearInterval(ping);
        clearInterval(watch);
        stream.destroy?.();
      } catch (e: any) {
        fireStats.errors++;
        fireStats.lastErr = String(e?.message || e).slice(0, 160);
      }
      fireStats.up = false;
      if (STOP) break;
      fireStats.reconnects++;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(60_000, wait * 2);
    }
  };
  void run();
  return true;
}
export const stopFirehose = () => (STOP = true);
/** Is the firehose live right now (a message in the last 30s)? */
export const fireLive = () => fireStats.up && Date.now() - fireStats.lastAt < 30_000;
