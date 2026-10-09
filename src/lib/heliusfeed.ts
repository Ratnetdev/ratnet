// The price feed (v0.1.34). History: PumpPortal now streams trades only with a paid key (about 1 SOL a day for what
// RATNET follows). v0.1.32 streamed whole transactions from Helius instead: that worked, but each message was ~50 KB
// and following launches cost ~1.3M credits a day, four times the plan's daily share.
//
// What the worker really needs live is the price of what it holds. So the feed now follows only open positions (real
// and ghost), through accountSubscribe: the bonding curve account of a coin on the curve, or the two vault accounts of
// its canonical PumpSwap pool once it migrated. Each update is a few hundred bytes (billed at 2 credits per 0.1 MB).
// The desk prices positions from it between its 10-second chain checks. Launch tapes come from the chain again, for
// the coins that pass the curve minimum (see processDue).
import { bondingCurvePda, noteStreamBytes, parseCurve, viewCurve, type CurveView } from "./solana";
import { redis } from "./redis";
import { POOLS_KEY } from "./pool";

export type FeedQuote = { mint: string; px: number; real: number; mcSol: number; curve: boolean };
type Sub = { mint: string; kind: "curve" | "base" | "quote"; addr: string };

const amountOf = (b: Buffer) => (b.length >= 72 ? Number(b.readBigUInt64LE(64)) : null);

// v0.1.53: onCurve gets every curve update (migrations included), max caps the followed coins, label names the feed
export function heliusFeed(opts: { want: () => Promise<Set<string>>; onQuote: (q: FeedQuote) => void; onCurve?: (mint: string, v: CurveView) => void; max?: number; label?: string; log?: (s: string) => void }) {
  const WS: any = (globalThis as any).WebSocket;
  const http = process.env.HELIUS_RPC_URL || "";
  const url = process.env.HELIUS_WS_URL || (http.startsWith("http") ? http.replace(/^http/, "ws") : "");
  const state = { up: false, subs: 0, msgs: 0, quotes: 0, lastAt: 0, addrs: 0, error: "", bytes: 0, since: Date.now(), perDay: 0 };
  const api = { nudge: () => {}, view: () => ({ ...state }), live: () => new Set<string>() };
  if (!WS || !url) {
    state.error = !WS ? "no WebSocket in this Node version" : "HELIUS_RPC_URL not set";
    return api;
  }
  let ws: any = null;
  let id = 1;
  const byAddr = new Map<string, Sub>(); // address -> what it is
  const subOf = new Map<string, number>(); // address -> subscription id
  const addrOfSub = new Map<number, string>();
  const pending = new Map<number, string>(); // request id -> address
  const vault = new Map<string, { base?: number; quote?: number; bs?: number; qs?: number; vq: number }>(); // pool coins: last vault amounts and their slots

  const send = (method: string, params: unknown[], addr?: string) => {
    const rid = id++;
    if (addr) pending.set(rid, addr);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }));
  };
  const resync = async () => {
    if (!state.up) return;
    const mints = Array.from(await opts.want().catch(() => new Set<string>())).slice(0, opts.max ?? 200);
    const r = redis();
    const vaults = mints.length ? (((await r.hmget<Record<string, { bv: string; qv: string; vq?: number } | null>>(POOLS_KEY, ...mints).catch(() => null)) || {}) as Record<string, { bv: string; qv: string; vq?: number } | null>) : {};
    const next = new Map<string, Sub>();
    for (const m of mints) {
      try {
        next.set(bondingCurvePda(m), { mint: m, kind: "curve", addr: bondingCurvePda(m) });
        const v = vaults[m];
        if (v?.bv && v?.qv) {
          if (!vault.has(m)) vault.set(m, { vq: Number(v.vq) || 0 });
          next.set(v.bv, { mint: m, kind: "base", addr: v.bv });
          next.set(v.qv, { mint: m, kind: "quote", addr: v.qv });
        }
      } catch {}
    }
    for (const [a, s] of next) {
      if (byAddr.has(a)) continue;
      byAddr.set(a, s);
      send("accountSubscribe", [a, { encoding: "base64", commitment: "confirmed" }], a);
    }
    for (const a of Array.from(byAddr.keys())) {
      if (next.has(a)) continue;
      const gone = byAddr.get(a)!;
      byAddr.delete(a);
      if (!mints.includes(gone.mint)) vault.delete(gone.mint);
      const sid = subOf.get(a);
      if (sid != null) {
        send("accountUnsubscribe", [sid]);
        subOf.delete(a);
        addrOfSub.delete(sid);
      }
    }
    state.addrs = byAddr.size;
  };

  const open = () => {
    ws = new WS(url);
    ws.onopen = () => {
      state.up = true;
      state.error = "";
      byAddr.clear();
      subOf.clear();
      addrOfSub.clear();
      resync().catch(() => null);
      opts.log?.(`helius feed: ${opts.label || "live prices of open positions"}`);
    };
    ws.onmessage = (ev: any) => {
      const data = String(ev?.data || "");
      noteStreamBytes(data.length);
      state.bytes += data.length;
      state.msgs++;
      const el = Date.now() - state.since;
      if (el > 3600_000) Object.assign(state, { bytes: data.length, since: Date.now() });
      else if (el > 30_000) state.perDay = Math.round(((state.bytes / el) * 86_400_000) / 50_000);
      let j: any = null;
      try {
        j = JSON.parse(data);
      } catch {
        return;
      }
      if (j?.id != null && pending.has(Number(j.id))) {
        const a = pending.get(Number(j.id))!;
        pending.delete(Number(j.id));
        if (j.error) state.error = String(j.error?.message || j.error).slice(0, 120);
        else {
          subOf.set(a, Number(j.result));
          addrOfSub.set(Number(j.result), a);
          state.subs++;
        }
        return;
      }
      if (j?.method !== "accountNotification") return;
      const a = addrOfSub.get(Number(j?.params?.subscription));
      const s = a ? byAddr.get(a) : null;
      const raw = j?.params?.result?.value?.data;
      if (!s || !Array.isArray(raw) || !raw[0]) return;
      const buf = Buffer.from(String(raw[0]), "base64");
      const slot = Number(j?.params?.result?.context?.slot) || 0;
      state.lastAt = Date.now();
      if (s.kind === "curve") {
        const c = parseCurve(buf);
        if (!c) return;
        const v = viewCurve(c);
        opts.onCurve?.(s.mint, v);
        if (v.complete || !(v.priceSol > 0)) return; // migrated: the pool vaults take over
        state.quotes++;
        opts.onQuote({ mint: s.mint, px: v.priceSol, real: v.realSol, mcSol: v.mcapSol, curve: true });
        return;
      }
      const amt = amountOf(buf);
      if (amt == null) return;
      const vv = vault.get(s.mint) || { vq: 0 };
      if (s.kind === "base") (vv.base = amt / 1e6), (vv.bs = slot);
      else (vv.quote = amt / 1e9), (vv.qs = slot);
      vault.set(s.mint, vv);
      // a swap moves both vaults in one slot, as two notifications: price only once both sides are from the same slot
      if (vv.base && vv.quote && vv.bs === vv.qs) {
        const px = (vv.quote + vv.vq) / vv.base;
        state.quotes++;
        opts.onQuote({ mint: s.mint, px, real: vv.quote, mcSol: px * 1e9, curve: false });
      }
    };
    ws.onclose = () => {
      state.up = false;
      setTimeout(open, 3000);
    };
    ws.onerror = (e: any) => {
      state.error = String(e?.message || "websocket error").replace(/api-key=\S+/gi, "").slice(0, 120);
    };
  };
  // the mints whose accounts are confirmed subscribed while the socket is up: no notification on them means no change
  api.live = () => {
    const out = new Set<string>();
    if (!state.up) return out;
    for (const [a, sub] of byAddr) if (subOf.has(a)) out.add(sub.mint);
    return out;
  };
  open();
  setInterval(() => resync().catch(() => null), 5000);
  api.nudge = () => setTimeout(() => resync().catch(() => null), 300);
  return api;
}
