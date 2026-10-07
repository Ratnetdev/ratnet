// The trade feed (v0.1.32). PumpPortal now only streams trades with a paid key (0.01 SOL per 10,000 messages, about
// 1 SOL a day for what RATNET follows). Helius streams the same transactions on the plan we already pay for, billed by
// data volume (2 credits per 0.1 MB): every transaction that touches a coin we follow (its bonding curve, or its
// canonical PumpSwap pool once migrated) arrives here and is turned into the same trade message the rest of the
// worker already understands (mint, side, SOL, tokens, trader, curve reserves, market cap).
//
// One websocket, one transactionSubscribe whose accountInclude is the followed set; when the set changes, a new
// subscription is opened and the old one closed once the new one is confirmed. transactionDetails "accounts" keeps
// each message small (keys and balances only, which is all a trade needs).
import { bondingCurvePda, noteStreamBytes, shapeParsedTx } from "./solana";
import { canonicalPool } from "./pool";
import { parseTrade } from "./tape";

const WSOL = "So11111111111111111111111111111111111111112";
const K_CURVE = 30 * 1073e6; // pump curve constant: virtual SOL x virtual tokens (millions)

export type FeedTrade = { mint: string; txType: "buy" | "sell"; traderPublicKey: string; solAmount: number; tokenAmount: number; vSolInBondingCurve?: number; marketCapSol: number; pool: "pump" | "pump-amm"; signature: string };

type Watch = { mint: string; kind: "curve" | "pool" };

/** A raw transactionNotification result in web3.js's parsed shape ("accounts" details carry no message wrapper). */
function shapeNote(res: any) {
  const t = res?.transaction;
  if (!t) return null;
  const inner = t.transaction || {};
  const msg = inner.message || { accountKeys: inner.accountKeys || [], instructions: [] };
  return shapeParsedTx({ slot: res.slot, blockTime: Math.floor(Date.now() / 1000), version: t.version, meta: t.meta, transaction: { ...inner, message: msg } });
}

/** One trade on a bonding curve, priced from the curve's SOL after the trade. */
export function curveTrade(tx: any, mint: string, sig: string): FeedTrade | null {
  const curve = bondingCurvePda(mint);
  const t = parseTrade(tx, curve, mint);
  if (!t || Math.abs(t.sol) < 1e-6) return null;
  const keys = tx.transaction.message.accountKeys;
  const ci = keys.findIndex((k: any) => k.pubkey.toBase58() === curve);
  const real = Math.max(0, (tx.meta.postBalances[ci] || 0) / 1e9 - 0.0016);
  const vSol = 30 + real;
  const vTok = K_CURVE / vSol;
  return { mint, txType: t.sol > 0 ? "buy" : "sell", traderPublicKey: t.w, solAmount: Math.abs(t.sol), tokenAmount: Math.abs(t.tok), vSolInBondingCurve: vSol, marketCapSol: (vSol / vTok) * 1e9, pool: "pump", signature: sig };
}

/** One trade in the canonical PumpSwap pool, priced from the pool's two vaults after the trade. */
export function poolTrade(tx: any, mint: string, pool: string, sig: string): FeedTrade | null {
  const post = (tx.meta.postTokenBalances || []).filter((b: any) => b.owner === pool);
  const pre = (tx.meta.preTokenBalances || []).filter((b: any) => b.owner === pool);
  const q = post.find((b: any) => b.mint === WSOL);
  const bse = post.find((b: any) => b.mint === mint);
  if (!q || !bse) return null;
  const q0 = pre.find((b: any) => b.mint === WSOL);
  const quote = Number(q.uiTokenAmount?.uiAmount || 0);
  const base = Number(bse.uiTokenAmount?.uiAmount || 0);
  const dq = quote - Number(q0?.uiTokenAmount?.uiAmount || quote);
  if (!(base > 0) || Math.abs(dq) < 1e-6) return null;
  const keys = tx.transaction.message.accountKeys;
  const w = (keys.find((k: any) => k.signer) || keys[0]).pubkey.toBase58();
  const own = (tx.meta.postTokenBalances || []).find((b: any) => b.mint === mint && b.owner === w);
  const own0 = own ? (tx.meta.preTokenBalances || []).find((b: any) => b.accountIndex === own.accountIndex) : null;
  const tok = own ? Number(own.uiTokenAmount?.uiAmount || 0) - Number(own0?.uiTokenAmount?.uiAmount || 0) : 0;
  return { mint, txType: dq > 0 ? "buy" : "sell", traderPublicKey: w, solAmount: Math.abs(dq), tokenAmount: Math.abs(tok), marketCapSol: (quote / base) * 1e9, pool: "pump-amm", signature: sig };
}

export function heliusFeed(opts: { want: () => Promise<Set<string>>; onTrade: (t: FeedTrade) => void; log?: (s: string) => void }) {
  const WS: any = (globalThis as any).WebSocket;
  const http = process.env.HELIUS_RPC_URL || "";
  const url = process.env.HELIUS_WS_URL || (http.startsWith("http") ? http.replace(/^http/, "ws") : "");
  const state = { up: false, subs: 0, msgs: 0, trades: 0, lastAt: 0, addrs: 0, error: "", bytes: 0, since: Date.now(), perDay: 0 };
  if (!WS || !url) {
    state.error = !WS ? "no WebSocket in this Node version" : "HELIUS_RPC_URL not set";
    return { ...state, nudge: () => {}, view: () => ({ ...state }) };
  }
  let ws: any = null;
  let id = 1;
  let live: number | null = null; // the confirmed subscription
  const pending = new Map<number, string[]>(); // request id -> addresses asked for
  let watch = new Map<string, Watch>();
  let asked = "";
  let backoff = 2000;

  const subscribe = (addrs: string[]) => {
    const rid = id++;
    pending.set(rid, addrs);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: rid, method: "transactionSubscribe", params: [{ accountInclude: addrs, failed: false, vote: false }, { commitment: "confirmed", encoding: "jsonParsed", transactionDetails: "accounts", showRewards: false, maxSupportedTransactionVersion: 1 }] }));
  };
  const resync = async () => {
    if (!state.up) return;
    const mints = Array.from(await opts.want().catch(() => new Set<string>())).slice(0, 4000);
    const next = new Map<string, Watch>();
    for (const m of mints) {
      try {
        next.set(bondingCurvePda(m), { mint: m, kind: "curve" });
        next.set(canonicalPool(m), { mint: m, kind: "pool" });
      } catch {}
    }
    const addrs = Array.from(next.keys()).sort();
    const sig = addrs.join(",");
    if (sig === asked || !addrs.length) return;
    asked = sig;
    watch = next; // trades for the new set are matched at once; the old subscription is closed when the new one is up
    state.addrs = addrs.length;
    subscribe(addrs);
  };

  const open = () => {
    ws = new WS(url);
    ws.onopen = () => {
      state.up = true;
      state.error = "";
      backoff = 2000;
      asked = "";
      live = null;
      resync().catch(() => null);
      opts.log?.("helius feed: trades for followed coins");
    };
    ws.onmessage = (ev: any) => {
      const data = String(ev?.data || "");
      noteStreamBytes(data.length);
      state.bytes += data.length;
      // credits a day at the rate since the last reset (2 credits per 100,000 bytes), window restarted hourly
      const el = Date.now() - state.since;
      if (el > 3600_000) Object.assign(state, { bytes: data.length, since: Date.now() });
      else if (el > 30_000) state.perDay = Math.round((state.bytes / el) * 86_400_000 / 50_000);
      state.msgs++;
      let j: any = null;
      try {
        j = JSON.parse(data);
      } catch {
        return;
      }
      if (j?.id != null && pending.has(Number(j.id))) {
        pending.delete(Number(j.id));
        if (j.error) {
          state.error = String(j.error?.message || j.error).slice(0, 120);
          return;
        }
        const old = live;
        live = Number(j.result);
        state.subs++;
        if (old != null) ws.send(JSON.stringify({ jsonrpc: "2.0", id: id++, method: "transactionUnsubscribe", params: [old] }));
        return;
      }
      const res = j?.params?.result;
      if (j?.method !== "transactionNotification" || !res) return;
      const tx: any = shapeNote(res);
      if (!tx?.meta) return;
      state.lastAt = Date.now();
      const sig = String(res.signature || "");
      const seen = new Set<string>();
      for (const k of tx.transaction.message.accountKeys) {
        const a = k.pubkey.toBase58();
        const w = watch.get(a);
        if (!w || seen.has(w.mint)) continue;
        seen.add(w.mint);
        const t = w.kind === "curve" ? curveTrade(tx, w.mint, sig) : poolTrade(tx, w.mint, a, sig);
        if (t) {
          state.trades++;
          opts.onTrade(t);
        }
      }
    };
    ws.onclose = () => {
      state.up = false;
      setTimeout(open, backoff);
      backoff = Math.min(60_000, backoff * 2);
    };
    ws.onerror = (e: any) => {
      state.error = String(e?.message || "websocket error").replace(/api-key=\S+/gi, "").slice(0, 120);
    };
  };
  open();
  setInterval(() => resync().catch(() => null), 3000);
  // a quick extra resync when a new launch arrives (its first trades matter most)
  return { ...state, nudge: () => setTimeout(() => resync().catch(() => null), 300), view: () => ({ ...state }) };
}
