"use client";
// Admin > Setup: every env var and whether it is set, the live status of each integration, and one-click setup
// actions (Telegram webhook, X watchlist sync, Helius wallet webhook). No secret is ever shown here.
import { useCallback, useEffect, useState } from "react";

type Env = { k: string; need: string; what: string; set: boolean };
type S = {
  env: Env[];
  site: string;
  status: { worker: { at: number; fresh: boolean } | null; rpcPlan: string; heliusHook: { n: number; at: number } | null; xRules: { at: number; n: number; accounts: number; interval?: number; removed?: number } | null; hound?: { wallets: number; fomo: any; kol: any }; telegram: { url: string; pending: number; lastError: string | null; ok: boolean } | null };
  xHookUrl: string | null;
  cron: { url: string; header: string };
};
const NEED: Record<string, string> = { core: "Core", trade: "Trading", agent: "Agents", optional: "Optional" };
const ago = (t?: number | null) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 60000))}m ago` : "never");

export default function Setup() {
  const [s, setS] = useState<S | null>(null);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => fetch("/api/admin/setup", { cache: "no-store" }).then((r) => r.json()).then(setS).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (action: string, label: string) => {
    if (busy) return;
    setBusy(action);
    setMsg(`${label}…`);
    try {
      const res = await fetch("/api/admin/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const text = await res.text();
      let j: any = null;
      try {
        j = JSON.parse(text);
      } catch {}
      if (!res.ok || !j) setMsg(`${label}: ${j?.error || `server answered ${res.status}${res.status === 504 ? " (timed out, the job may still have finished: check the row above)" : ""}`}`);
      else if (j.error) setMsg(`${label}: failed (${j.error})`);
      else setMsg(`${label}: ${j.note || "done"}`);
      // background jobs: refresh the rows a few times while they run
      if (j?.started) for (const t of [8000, 20000, 40000, 70000]) setTimeout(load, t);
    } catch {
      setMsg(`${label}: no answer (network). check the row above in a minute`);
    } finally {
      setBusy(null);
      load();
    }
  };
  if (!s) return <p className="muted">Loading…</p>;
  const st = s.status;
  const missing = s.env.filter((e) => !e.set && e.need !== "optional");
  return (
    <div className="grid" style={{ gap: 16 }}>
      <section className="panel">
        <div className="ph"><span><b>Status</b></span><span className="tiny muted">{missing.length ? `${missing.length} required env vars missing` : "all required env vars set"}</span></div>
        <table className="tbl setup-tbl">
          <tbody>
            <tr><td>Worker (always-on)</td><td className={st.worker?.fresh ? "green" : "muted"}>{st.worker ? (st.worker.fresh ? `running · beat ${ago(st.worker.at)}` : `stopped · last beat ${ago(st.worker.at)}`) : "not deployed (Vercel minute ping runs the desk)"}</td><td /></tr>
            <tr><td>RPC plan</td><td className={/paid/.test(st.rpcPlan) ? "green" : "red"}>{st.rpcPlan}</td><td /></tr>
            <tr>
              <td>Telegram webhook</td>
              <td className={st.telegram?.ok ? "green" : "red"}>{!st.telegram ? "no bot token" : st.telegram.ok ? `connected${st.telegram.pending ? ` · ${st.telegram.pending} pending` : ""}` : st.telegram.url ? `points elsewhere: ${st.telegram.url}` : "not set"}{st.telegram?.lastError ? ` · last error: ${st.telegram.lastError}` : ""}</td>
              <td><button className="btn sm" disabled={!!busy} onClick={() => act("tg", "Telegram webhook")}>connect</button></td>
            </tr>
            <tr><td>X watchlist (twitterapi.io rules)</td><td className={st.xRules ? "green" : "muted"}>{st.xRules ? `${st.xRules.n} rules · ${st.xRules.accounts} accounts · every ${st.xRules.interval || 20}s${st.xRules.removed ? ` · ${st.xRules.removed} old rules removed` : ""} · ${ago(st.xRules.at)}` : "never synced"}</td><td><button className="btn sm" disabled={!!busy} onClick={() => act("xsync", "X sync")}>sync now</button></td></tr>
            <tr>
              <td>HOUND wallet book</td>
              <td className={st.hound?.wallets ? "green" : "red"}>
                {st.hound?.wallets || 0} wallets
                {st.hound?.fomo ? ` · FOMO: ${st.hound.fomo.ok ? `${st.hound.fomo.traders} traders read, ${st.hound.fomo.added} added` : st.hound.fomo.error} (${ago(st.hound.fomo.at)})` : " · FOMO: not run yet"}
                {st.hound?.kol ? ` · KOL rosters: ${st.hound.kol.ok ? `${st.hound.kol.rosterWallets} listed, ${st.hound.kol.added} added` : st.hound.kol.error} (${ago(st.hound.kol.at)})` : " · KOL: not run yet"}
              </td>
              <td><button className="btn sm" disabled={!!busy} onClick={() => act("houndfill", "HOUND fill")}>fill now</button></td>
            </tr>
            <tr><td>Helius wallet webhook (HOUND)</td><td className={st.heliusHook ? "green" : "muted"}>{st.heliusHook ? `${st.heliusHook.n} wallets · ${ago(st.heliusHook.at)}` : "not created"}</td><td><button className="btn sm" disabled={!!busy} onClick={() => act("hound", "Helius webhook")}>sync now</button></td></tr>
          </tbody>
        </table>
        {msg ? <div className="tiny mt" style={{ wordBreak: "break-all" }}>{msg}</div> : null}
      </section>

      <section className="panel">
        <div className="ph"><span><b>Webhooks and pings</b></span></div>
        <div className="pb small" style={{ lineHeight: 1.7 }}>
          <div><span className="muted">twitterapi.io webhook URL</span> (Dashboard → Tweet filter → Webhook):</div>
          {s.xHookUrl ? (
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <code className="setup-code">{s.xHookUrl.replace(/key=.*/, "key=••••••••")}</code>
              <button className="btn sm" onClick={() => { navigator.clipboard.writeText(s.xHookUrl!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "copied" : "copy"}</button>
            </div>
          ) : <div className="red">Set CRON_SECRET first.</div>}
          <div className="mt"><span className="muted">cron-job.org (every minute):</span> <code className="setup-code">GET {s.cron.url}</code> with header <code className="setup-code">{s.cron.header}</code></div>
          <div className="tiny muted mt">The header keeps the secret out of URL logs. Once the job sends the header, set CRON_HEADER_ONLY=1 in Vercel.</div>
        </div>
      </section>

      <section className="panel">
        <div className="ph"><span><b>Environment</b></span><span className="tiny muted">values are never shown</span></div>
        <table className="tbl">
          <thead><tr><th>Variable</th><th>For</th><th>Group</th><th>Set</th></tr></thead>
          <tbody>
            {s.env.map((e) => (
              <tr key={e.k}>
                <td><code>{e.k}</code></td>
                <td className="small muted">{e.what}</td>
                <td className="tiny muted">{NEED[e.need]}</td>
                <td className={e.set ? "green" : e.need === "optional" ? "muted" : "red"}>{e.set ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
