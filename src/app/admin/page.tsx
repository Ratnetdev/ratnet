"use client";
import { useCallback, useEffect, useState } from "react";
import Strategy from "@/components/admin/Strategy";
import Wallets from "@/components/admin/Wallets";
import Overseer from "@/components/admin/Overseer";
import Setup from "@/components/admin/Setup";

type Settings = {
  mint: string;
  decimals: number;
  litter: { n: number; size: number; open: boolean };
  spawnCost: number;
  sniffCost: number;
  minWork: number;
  freeSniff: boolean;
  links: { x: string; tg: string; pump: string; dex: string };
  refs: Record<"pump" | "gmgn" | "axiom" | "fomo", string>;
  venueTpl: Record<string, { ref: string; plain: string }>;
  desk: Record<string, any>;
  history: Record<string, any>;
};
type Round = { id: number; feesSol: number; ownersSol: number; computeSol: number; cappedSol: number; eligible: number; status: string; payouts: { owner: string; sol: number; sig?: string; error?: string }[] };

async function call(body: Record<string, unknown>) {
  const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "failed");
  return j;
}

export default function Admin() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [pw, setPw] = useState("");
  const [s, setS] = useState<Settings | null>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [cur, setCur] = useState(0);
  const [sniffers, setSniffers] = useState(0);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [roundId, setRoundId] = useState("");
  const [fees, setFees] = useState("");
  const [day, setDay] = useState("");
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [deskJson, setDeskJson] = useState("");
  const [histJson, setHistJson] = useState("");
  const [tab, setTab] = useState<"settings" | "setup" | "strategy" | "wallets" | "overseer">("settings");

  const load = useCallback(async () => {
    const r = await fetch("/api/admin", { cache: "no-store" });
    if (r.status === 401) return setAuthed(false);
    const j = await r.json();
    setAuthed(true);
    setS(j.settings);
    setDeskJson(JSON.stringify(j.settings.desk, null, 2));
    setHistJson(JSON.stringify(j.settings.history, null, 2));
    setRounds(j.rounds);
    setCur(j.currentRound);
    setSniffers(j.sniffers);
    setRoundId(String(j.currentRound - 1));
    fetch("/api/health?full=1").then((x) => x.json()).then(setHealth).catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setErr("");
    setMsg(`${label}…`);
    try {
      await fn();
      setMsg(`${label}: done`);
      await load();
    } catch (e: any) {
      setErr(e.message);
      setMsg("");
    }
  };

  if (authed === null) return <p className="muted">Loading…</p>;
  if (!authed)
    return (
      <div className="panel" style={{ maxWidth: 420 }}>
        <div className="ph"><span><b>admin</b></span></div>
        <div className="pb">
          <input className="input" type="password" placeholder="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <button
            className="btn mt"
            onClick={async () => {
              const r = await fetch("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
              if (r.ok) load();
              else setErr((await r.json().catch(() => ({}))).error || "Wrong password");
            }}
          >
            Enter
          </button>
          {err && <div className="err">{err}</div>}
        </div>
      </div>
    );
  if (!s) return null;

  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });

  return (
    <div className="grid admin" style={{ gap: 16 }}>
      <div className="row between wrapx">
        <h2 className="crt green" style={{ fontSize: 34 }}>ADMIN</h2>
        <span className="strat-tabs">
          {(["settings", "setup", "strategy", "wallets", "overseer"] as const).map((k) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{k}</button>)}
        </span>
        <span className="small">{msg && <span className="green">{msg}</span>} {err && <span style={{ color: "var(--dust)" }}>{err}</span>} <button className="btn sm ghost" onClick={async () => { await fetch("/api/admin/login", { method: "DELETE" }); setAuthed(false); }}>log out</button> <button className="btn sm ghost" title="Ends every admin session on every device" onClick={async () => { if (!confirm("Log out every admin session on every device?")) return; await fetch("/api/admin/login?all=1", { method: "DELETE" }); setAuthed(false); }}>log out everywhere</button></span>
      </div>

      {tab === "setup" ? <Setup /> : tab === "strategy" ? <Strategy /> : tab === "wallets" ? <Wallets /> : tab === "overseer" ? <Overseer /> : <>

      <div className="panel">
        <div className="ph"><span><b>health</b></span></div>
        <div className="pb small muted" style={{ wordBreak: "break-all" }}>{health ? JSON.stringify(health) : "…"}</div>
      </div>

      <div className="grid g2">
        <div className="panel">
          <div className="ph"><span><b>token</b> · goes live without redeploy</span></div>
          <div className="pb">
            <label className="l">$RAT CA (mint)</label>
            <input className="input" value={s.mint} onChange={(e) => set({ mint: e.target.value.trim() })} placeholder="empty = pre-launch" />
            <div className="grid g3" style={{ gap: 10 }}>
              <div><label className="l">Decimals</label><input className="input" type="number" value={s.decimals} onChange={(e) => set({ decimals: Number(e.target.value) })} /></div>
              <div><label className="l">Spawn cost</label><input className="input" type="number" value={s.spawnCost} onChange={(e) => set({ spawnCost: Number(e.target.value) })} /></div>
              <div><label className="l">Sniff cost</label><input className="input" type="number" value={s.sniffCost} onChange={(e) => set({ sniffCost: Number(e.target.value) })} /></div>
            </div>
            <div className="grid g3" style={{ gap: 10 }}>
              <div><label className="l">Min digs / round</label><input className="input" type="number" value={s.minWork} onChange={(e) => set({ minWork: Number(e.target.value) })} /></div>
              <div><label className="l">Litter #</label><input className="input" type="number" value={s.litter.n} onChange={(e) => set({ litter: { ...s.litter, n: Number(e.target.value) } })} /></div>
              <div><label className="l">Litter size</label><input className="input" type="number" value={s.litter.size} onChange={(e) => set({ litter: { ...s.litter, size: Number(e.target.value) } })} /></div>
            </div>
            <label className="l row" style={{ gap: 8 }}>
              <input type="checkbox" checked={s.litter.open} onChange={(e) => set({ litter: { ...s.litter, open: e.target.checked } })} /> Litter open for spawning
            </label>
            <label className="l row" style={{ gap: 8 }}>
              <input type="checkbox" checked={s.freeSniff} onChange={(e) => set({ freeSniff: e.target.checked })} /> Free sniff preview while no CA is set
            </label>
            {(["x", "tg", "pump", "dex"] as const).map((k) => (
              <div key={k}>
                <label className="l">Link: {k}</label>
                <input className="input" value={s.links[k]} onChange={(e) => set({ links: { ...s.links, [k]: e.target.value.trim() } })} />
              </div>
            ))}
            <button className="btn mt" onClick={() => run("Save", () => call({ action: "settings", settings: s }))}>Save settings</button>
          </div>
        </div>

        <div className="grid" style={{ alignContent: "start" }}>
          <div className="panel">
            <div className="ph"><span><b>trade buttons</b> · referral codes</span></div>
            <div className="pb">
              <p className="muted small" style={{ marginTop: 0 }}>Every coin on the site shows GMGN, Axiom, FOMO, pump.fun and DexScreener buttons. Enter your referral code per venue (letters and numbers only). Empty = plain link. {"{ca}"} is the coin, {"{ref}"} your code. Click-test each venue once after saving.</p>
              {(["gmgn", "axiom", "fomo", "pump"] as const).map((k) => (
                <div key={k} className="grid g2" style={{ gap: 10 }}>
                  <div><label className="l">{k} code</label><input className="input" value={s.refs?.[k] || ""} onChange={(e) => set({ refs: { ...s.refs, [k]: e.target.value.trim() } })} /></div>
                  <div><label className="l">{k} link with code</label><input className="input" style={{ fontSize: 11 }} value={s.venueTpl?.[k]?.ref || ""} onChange={(e) => set({ venueTpl: { ...s.venueTpl, [k]: { ...s.venueTpl[k], ref: e.target.value.trim() } } })} /></div>
                </div>
              ))}
              <button className="btn mt" onClick={() => run("Save codes", () => call({ action: "settings", settings: { refs: s.refs, venueTpl: s.venueTpl } }))}>Save codes</button>
            </div>
          </div>

          <div className="panel">
            <div className="ph"><span><b>close a round</b> · current #{cur}</span></div>
            <div className="pb">
              <p className="muted small" style={{ marginTop: 0 }}>Claim the creator fees, then enter the SOL collected for a finished round. The site splits 60/40, applies min work, bag multipliers and caps.</p>
              <div className="grid g2" style={{ gap: 10 }}>
                <div><label className="l">Round #</label><input className="input" value={roundId} onChange={(e) => setRoundId(e.target.value)} /></div>
                <div><label className="l">Fees (SOL)</label><input className="input" value={fees} onChange={(e) => setFees(e.target.value)} /></div>
              </div>
              <div className="row mt">
                <button className="btn" onClick={() => run("Compute", () => call({ action: "compute", round: roundId, feesSol: fees }))}>Compute</button>
                <button className="btn ghost" onClick={() => run("Pay", () => call({ action: "pay", round: roundId }))}>Pay from payout wallet</button>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="ph"><span><b>tools</b></span></div>
            <div className="pb">
              <div className="row wrapx">
                <button className="btn dim" onClick={() => run("Dig now", () => call({ action: "dig" }))}>Dig now</button>
                <button
                  className="btn dim"
                  onClick={() =>
                    run("Airdrop list", async () => {
                      const j = await call({ action: "airdrop" });
                      const blob = new Blob([j.wallets.join("\n")], { type: "text/plain" });
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(blob);
                      a.download = "ratnet-airdrop-wallets.txt";
                      a.click();
                    })
                  }
                >
                  Airdrop list ({sniffers} sniffers + rat owners)
                </button>
              </div>
              <label className="l">Export dataset day (YYYY-MM-DD)</label>
              <div className="row">
                <input className="input" value={day} onChange={(e) => setDay(e.target.value)} placeholder="2026-10-07" />
                <button className="btn dim" onClick={() => run("Export", () => call({ action: "export", day }))}>Export</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="ph"><span><b>desk</b> · mode off | paper | auto | live</span></div>
        <div className="pb">
          <p className="muted small" style={{ marginTop: 0 }}>paper = never real money (the default since v0.1.43). auto = paper until the exam passes and DESK_WALLET_SECRET holds 0.5+ SOL, then it goes live on its own. live = skip the exam (only if you are sure).</p>
          <textarea className="input" style={{ minHeight: 260, fontSize: 12 }} value={deskJson} onChange={(e) => setDeskJson(e.target.value)} spellCheck={false} />
          <div className="row wrapx mt">
            <button className="btn" onClick={() => run("Save desk", () => call({ action: "settings", settings: { desk: JSON.parse(deskJson) } }))}>Save desk</button>
            <button className="btn dim" onClick={() => run("Close all", () => call({ action: "desk-closeall" }))}>Close all positions</button>
            <button className="btn dim" onClick={() => confirm("Reset the paper desk and its history?") && run("Reset desk", () => call({ action: "desk-reset" }))}>Reset desk</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="ph"><span><b>historian</b> · replays past launches to train the models</span></div>
        <div className="pb">
          <p className="muted small" style={{ marginTop: 0 }}>Runs next to the desk on the same cron. Each step costs RPC credits: scanPerRun at ~1 credit each, deepPerRun at ~50 each. Lower them if your Helius plan runs hot.</p>
          <textarea className="input" style={{ minHeight: 160, fontSize: 12 }} value={histJson} onChange={(e) => setHistJson(e.target.value)} spellCheck={false} />
          <div className="row wrapx mt">
            <button className="btn" onClick={() => run("Save historian", () => call({ action: "settings", settings: { history: JSON.parse(histJson) } }))}>Save historian</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="ph"><span><b>rounds</b></span></div>
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>#</th><th>Fees</th><th>Owners</th><th>Capped</th><th>Eligible</th><th>Status</th><th>Errors</th></tr></thead>
            <tbody>
              {rounds.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.feesSol}</td>
                  <td>{r.ownersSol}</td>
                  <td>{r.cappedSol}</td>
                  <td>{r.eligible}</td>
                  <td>{r.status}</td>
                  <td className="small" style={{ color: "var(--dust)" }}>{r.payouts.find((p) => p.error)?.error || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </>}
    </div>
  );
}
