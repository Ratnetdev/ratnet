"use client";
// Real-time prices in the browser. Every pump.fun trade (bonding curve and PumpSwap after migration) for the coins on
// screen streams straight from PumpPortal's public websocket, so a market cap moves the moment a trade lands instead
// of waiting for the next poll. One shared connection per tab, subscriptions ref-counted by the components that ask.
import { useEffect, useSyncExternalStore } from "react";

export type LivePx = { mcSol: number; at: number; side: "buy" | "sell"; sol: number; trader: string };

const URL = "wss://pumpportal.fun/api/data";
const data = new Map<string, LivePx>();
const refs = new Map<string, number>();
const listeners = new Set<() => void>();
let ws: WebSocket | null = null;
let open = false;
let retry = 0;
let pending = new Set<string>();
let flushT: ReturnType<typeof setTimeout> | null = null;

const notify = () => listeners.forEach((f) => f());

function send(msg: unknown) {
  if (ws && open) ws.send(JSON.stringify(msg));
}

function connect() {
  if (typeof window === "undefined" || ws) return;
  try {
    ws = new WebSocket(URL);
  } catch {
    ws = null;
    return;
  }
  ws.onopen = () => {
    open = true;
    retry = 0;
    const keys = Array.from(refs.keys());
    if (keys.length) send({ method: "subscribeTokenTrade", keys });
  };
  ws.onmessage = (ev) => {
    let m: any;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const mint = m?.mint;
    const mc = Number(m?.marketCapSol);
    if (!mint || !refs.has(mint) || !(mc > 0)) return;
    data.set(mint, { mcSol: mc, at: Date.now(), side: m.txType === "sell" ? "sell" : "buy", sol: Number(m.solAmount) || 0, trader: String(m.traderPublicKey || "") });
    notify();
  };
  ws.onclose = () => {
    open = false;
    ws = null;
    if (!refs.size) return;
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * 2 ** retry); // 1s, 2s, 4s ... 32s
  };
  ws.onerror = () => {};
}

// subscribe changes are batched (a page mounting 40 rows sends one message)
function flush() {
  flushT = null;
  const add = Array.from(pending).filter((k) => refs.has(k));
  pending = new Set();
  if (!refs.size) {
    ws?.close();
    return;
  }
  if (!ws) connect();
  else if (add.length) send({ method: "subscribeTokenTrade", keys: add });
}

function want(mint: string) {
  const n = refs.get(mint) || 0;
  refs.set(mint, n + 1);
  if (!n) {
    pending.add(mint);
    if (!flushT) flushT = setTimeout(flush, 120);
  }
}
function release(mint: string) {
  const n = (refs.get(mint) || 1) - 1;
  if (n > 0) return void refs.set(mint, n);
  refs.delete(mint);
  setTimeout(() => {
    if (refs.has(mint)) return;
    data.delete(mint);
    send({ method: "unsubscribeTokenTrade", keys: [mint] });
    if (!refs.size) ws?.close();
  }, 3000);
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** The latest trade's market cap (SOL) for a coin, live. Null until the first trade after mounting. */
export function useLivePx(mint?: string | null): LivePx | null {
  useEffect(() => {
    if (!mint) return;
    want(mint);
    return () => release(mint);
  }, [mint]);
  return useSyncExternalStore(
    subscribe,
    () => (mint ? data.get(mint) || null : null),
    () => null
  );
}
