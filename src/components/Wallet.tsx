"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Transaction } from "@solana/web3.js";
import { short } from "./fmt";

type Provider = {
  publicKey?: { toString(): string } | null;
  connect: (o?: { onlyIfTrusted?: boolean }) => Promise<unknown>;
  disconnect?: () => Promise<void>;
  signAndSendTransaction: (tx: Transaction) => Promise<unknown>;
};
type WalletName = "Phantom" | "Solflare" | "Backpack";

function providers(): { name: WalletName; p: Provider }[] {
  if (typeof window === "undefined") return [];
  const w = window as any;
  const out: { name: WalletName; p: Provider }[] = [];
  if (w.phantom?.solana?.isPhantom) out.push({ name: "Phantom", p: w.phantom.solana });
  if (w.solflare?.isSolflare) out.push({ name: "Solflare", p: w.solflare });
  if (w.backpack?.isBackpack || w.backpack?.solana) out.push({ name: "Backpack", p: w.backpack.solana || w.backpack });
  return out;
}

type Ctx = {
  address: string;
  walletName: WalletName | "";
  connect: (name?: WalletName) => Promise<void>;
  disconnect: () => void;
  signAndSend: (b64: string) => Promise<string>;
  available: WalletName[];
};
const WalletCtx = createContext<Ctx | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState("");
  const [walletName, setWalletName] = useState<WalletName | "">("");
  const [available, setAvailable] = useState<WalletName[]>([]);

  useEffect(() => {
    const t = setTimeout(() => {
      const list = providers();
      setAvailable(list.map((x) => x.name));
      let last = "";
      try {
        last = localStorage.getItem("rn_wallet") || "";
      } catch {}
      const prev = list.find((x) => x.name === last);
      if (prev) {
        prev.p
          .connect({ onlyIfTrusted: true })
          .then(() => {
            const pk = prev.p.publicKey?.toString();
            if (pk) {
              setAddress(pk);
              setWalletName(prev.name);
            }
          })
          .catch(() => {});
      }
    }, 400);
    return () => clearTimeout(t);
  }, []);

  const connect = useCallback(async (name?: WalletName) => {
    const list = providers();
    const pick = list.find((x) => x.name === name) || list[0];
    if (!pick) {
      window.open("https://phantom.app/", "_blank");
      throw new Error("No Solana wallet found. Install Phantom, Solflare or Backpack.");
    }
    await pick.p.connect();
    const pk = pick.p.publicKey?.toString();
    if (!pk) throw new Error("Wallet did not return an address");
    setAddress(pk);
    setWalletName(pick.name);
    try {
      localStorage.setItem("rn_wallet", pick.name);
    } catch {}
  }, []);

  const disconnect = useCallback(() => {
    const pick = providers().find((x) => x.name === walletName);
    pick?.p.disconnect?.().catch(() => {});
    setAddress("");
    setWalletName("");
    try {
      localStorage.removeItem("rn_wallet");
    } catch {}
  }, [walletName]);

  const signAndSend = useCallback(
    async (b64: string) => {
      const pick = providers().find((x) => x.name === walletName);
      if (!pick) throw new Error("Connect a wallet first");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const tx = Transaction.from(bytes);
      const res: any = await pick.p.signAndSendTransaction(tx);
      const sig = typeof res === "string" ? res : res?.signature;
      if (!sig) throw new Error("Wallet did not return a signature");
      return String(sig);
    },
    [walletName]
  );

  return <WalletCtx.Provider value={{ address, walletName, connect, disconnect, signAndSend, available }}>{children}</WalletCtx.Provider>;
}

export function useWallet() {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("useWallet outside provider");
  return c;
}

export function WalletButton() {
  const { address, connect, disconnect, available } = useWallet();
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!err) return;
    const t = setTimeout(() => setErr(""), 6000);
    return () => clearTimeout(t);
  }, [err]);
  const [open, setOpen] = useState(false);
  if (address)
    return (
      <button className="btn dim" onClick={disconnect} title="Disconnect">
        {short(address)}
      </button>
    );
  return (
    <span style={{ position: "relative" }}>
      <button
        className="btn ghost"
        onClick={async () => {
          setErr("");
          if (available.length > 1) return setOpen(!open);
          try {
            await connect();
          } catch (e: any) {
            setErr(e.message);
          }
        }}
      >
        Connect
      </button>
      {open && (
        <span className="panel" style={{ position: "absolute", right: 0, top: "110%", zIndex: 60, display: "grid", minWidth: 150 }}>
          {available.map((n) => (
            <button
              key={n}
              className="btn dim"
              style={{ border: 0, justifyContent: "flex-start" }}
              onClick={async () => {
                setOpen(false);
                try {
                  await connect(n);
                } catch (e: any) {
                  setErr(e.message);
                }
              }}
            >
              {n}
            </button>
          ))}
        </span>
      )}
      {/* v0.1.47: a readable popover (the bare red text floated over the page on phones); tap to close, gone after 6s */}
      {err && <span className="err wal-err" role="alert" onClick={() => setErr("")}>{err}<em>tap to close</em></span>}
    </span>
  );
}

/** Build a burn tx on the server, sign + send in the wallet, then poll `verifyUrl` until the server accepts it. */
export async function burnFlow(opts: {
  wallet: string;
  kind: "spawn" | "sniff" | "pup";
  ca?: string;
  signAndSend: (b64: string) => Promise<string>;
  verifyUrl: string;
  verifyBody: Record<string, unknown>;
  onStep?: (s: string) => void;
}) {
  const step = opts.onStep || (() => {});
  step("building burn…");
  const b = await fetch("/api/tx/burn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: opts.wallet, kind: opts.kind, ca: opts.ca }),
  });
  const bj = await b.json();
  if (!b.ok) throw new Error(bj.error || "Could not build the burn");
  step("approve in your wallet…");
  const signature = await opts.signAndSend(bj.tx);
  step("burn sent, waiting for the chain…");
  for (let i = 0; i < 30; i++) {
    const r = await fetch(opts.verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...opts.verifyBody, wallet: opts.wallet, signature }),
    });
    const j = await r.json();
    if (r.status === 202) {
      await new Promise((res) => setTimeout(res, 2500));
      continue;
    }
    if (!r.ok) throw new Error(`${j.error || "Rejected"} (tx ${signature.slice(0, 8)}…)`);
    return { ...j, signature };
  }
  throw new Error(`Burn not confirmed yet. Keep this tx: ${signature}`);
}
