// v0.1.79: the desk's keys. Paper runs on the desk wallet (DESK_WALLET_SECRET). When a separate live wallet is set
// (DESK_LIVE_WALLET_SECRET, Railway only), the desk switches to it by itself the moment the exam passes and goes live
// there, and never uses the paper wallet again: the switch is stored (rn:desk:livewallet and the desk state), and the
// old address is hidden everywhere on the site (receipts it signed, log lines that name it).
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { redis } from "./redis";

export const SWITCH_KEY = "rn:desk:livewallet";
export const HIDDEN_KEY = "rn:desk:hiddenwallets";
export type Switch = { from: string; to: string; at: number };

const parse = (sec?: string) => {
  if (!sec || !sec.trim()) return null;
  try {
    return Keypair.fromSecretKey(sec.trim().startsWith("[") ? Uint8Array.from(JSON.parse(sec)) : bs58.decode(sec.trim()));
  } catch {
    return null;
  }
};
// the keys are used only in the worker (Railway); on Vercel they are never loaded (v0.1.33)
const offVercel = () => !(process.env.VERCEL && process.env.DESK_ON_VERCEL !== "1");
export const paperKey = () => (offVercel() ? parse(process.env.DESK_WALLET_SECRET) : null);
export const liveKey = () => (offVercel() ? parse(process.env.DESK_LIVE_WALLET_SECRET) : null);

let SW: Switch | null = null;
let swAt = 0;
/** The stored switch (cached 30s). A failed read keeps what was known. */
export async function loadSwitch(force = false) {
  if (!force && swAt && Date.now() - swAt < 30_000) return SW;
  swAt = Date.now();
  try {
    const v = await redis().get<Switch>(SWITCH_KEY);
    if (v && typeof v === "object" && v.to) SW = v;
  } catch {}
  return SW;
}
export const switched = () => SW;
/** The desk state remembers the switch too (a fresh process whose first Redis read failed still never goes back). */
export function restoreSwitch(liveWallet?: string | null, from?: string | null) {
  if (!SW && liveWallet) SW = { from: from || "", to: liveWallet, at: 0 };
}

/** The key the desk trades (and signs receipts) with. After the switch only the live wallet, never the paper one. */
export function deskKey(): Keypair | null {
  if (SW) {
    const k = liveKey();
    return k && k.publicKey.toBase58() === SW.to ? k : null;
  }
  return paperKey();
}

/** The wallet live money will trade from: the separate live wallet when it is set (and not the paper wallet). */
export function nextLiveKey(): Keypair | null {
  if (SW) return deskKey();
  const k = liveKey();
  const p = paperKey();
  return k && !(p && k.publicKey.equals(p.publicKey)) ? k : null;
}
/** A separate live wallet waits for the exam (the exam's wallet check reads it, not the paper wallet). */
export const switchPending = () => !SW && !!nextLiveKey();

export async function markSwitch(from: string, to: string) {
  SW = { from, to, at: Date.now() };
  swAt = Date.now();
  const r = redis();
  await r.set(SWITCH_KEY, SW);
  if (from) await r.sadd(HIDDEN_KEY, from);
}

let HID: { at: number; v: Set<string> } | null = null;
/** Wallets that must not appear on the site any more (cached 60s). */
export async function hiddenWallets(): Promise<Set<string>> {
  if (HID && Date.now() - HID.at < 60_000) return HID.v;
  const v = new Set(((await redis().smembers(HIDDEN_KEY).catch(() => [])) || []).map(String));
  HID = { at: Date.now(), v };
  return v;
}
/** Tests: forget the cached switch. */
export function _resetKeys() {
  SW = null;
  swAt = 0;
  HID = null;
}
