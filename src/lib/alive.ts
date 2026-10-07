// Every loop and agent reports when it last finished a pass and whether it went well, so a stalled part shows up on
// /desk within minutes instead of being noticed by hand. Only counts and short notes, never secrets.
import { redis } from "./redis";

const KEY = "rn:alive";
// how often each part should report at the latest (seconds); past 3x this it shows as stalled
export const EXPECT: Record<string, number> = {
  desk: 20, rats_fast: 15, rats_slow: 40, stream: 30, flash: 120, historian: 400,
  catch: 180, momo: 180, hound: 180, mind: 180, lens: 180, overseer: 300, wire: 180, j7: 180, receipts: 300, telegram: 300,
};

const note = (r: any): { ok: boolean; note: string } => {
  if (r == null) return { ok: true, note: "" };
  const err = r?.error || r?.timeout || (typeof r === "object" && Object.values(r).some((v) => v === "error"));
  const text = JSON.stringify(r).replace(/https?:\/\/\S+/g, "[url]").replace(/api-key=\S+/gi, "").replace(/[{}"]/g, "").slice(0, 120);
  // a lane paused by the daily chain budget is working as designed, not failing
  return { ok: !err || /budget/i.test(text), note: text };
};

export async function markAlive(name: string, result?: unknown) {
  const n = note(result);
  await redis().hset(KEY, { [name]: { at: Date.now(), ok: n.ok, note: n.note } }).catch(() => {});
}

/** A pass that is taking long: say so, but keep the time it last finished (so a stuck part still shows as stalled). */
export async function markBusy(name: string, secs: number) {
  const r = redis();
  const cur = await r.hget<{ at: number; ok: boolean; note: string }>(KEY, name).catch(() => null);
  await r.hset(KEY, { [name]: { at: cur?.at ?? 0, ok: false, note: `pass still running after ${secs}s` } }).catch(() => {});
}

/** Wrap a part: when it settles, it reports. */
export function alive<T>(name: string, p: Promise<T>): Promise<T> {
  return p.then(
    (r) => (markAlive(name, r).catch(() => {}), r),
    (e) => (markAlive(name, { error: String(e?.message || e) }).catch(() => {}), Promise.reject(e)),
  );
}

/** The worker's RPC limiter over the last minute (written by the worker every 20s). */
export async function rpcLive() {
  return redis().get<any>("rn:rpc").catch(() => null);
}

export async function aliveView() {
  const r = redis();
  const [raw0, beat] = await Promise.all([r.hgetall<Record<string, { at: number; ok: boolean; note: string }>>(KEY), r.get<number>("rn:desk:beat")]);
  const raw = (raw0 || {}) as Record<string, { at: number; ok: boolean; note: string }>;
  // the desk reports every beat through its heartbeat (its session report comes only every 5 minutes)
  if (beat) raw.desk = { at: Number(beat), ok: true, note: raw.desk?.note || "beating" };
  const now = Date.now();
  return Object.keys(EXPECT).map((k) => {
    const x = raw[k];
    const age = x ? Math.round((now - x.at) / 1000) : null;
    return { name: k, age, ok: !!x && x.ok, stalled: age == null || age > EXPECT[k] * 3, note: x?.note || "" };
  });
}

/**
 * Telegram alert (the private ideas chat, never the public channel) when a part stalls, once per incident, and one
 * line when it is back. Called by the worker every 20s.
 */
export async function stallAlerts() {
  const { tgSend, ideasChat, esc } = await import("./tgbot");
  const chat = ideasChat();
  if (!chat || !process.env.TELEGRAM_BOT_TOKEN) return;
  const r = redis();
  const parts = await aliveView();
  const open = ((await r.hgetall<Record<string, number>>("rn:alert:stall")) || {}) as Record<string, number>;
  for (const p of parts) {
    // a minute of grace after a worker boot: everything reports late once
    if (p.stalled && !open[p.name] && (p.age == null || p.age > EXPECT[p.name] * 4)) {
      await r.hset("rn:alert:stall", { [p.name]: Date.now() });
      await tgSend(chat, `⚠️ <b>${esc(p.name)}</b> is stalled: last finished pass ${p.age == null ? "never" : `${Math.round(p.age / 60)}m ago`}. ${esc(p.note).slice(0, 120)}`).catch(() => null);
    } else if (!p.stalled && open[p.name]) {
      await r.hdel("rn:alert:stall", p.name);
      await tgSend(chat, `✅ <b>${esc(p.name)}</b> is running again (down ${Math.round((Date.now() - Number(open[p.name])) / 60_000)}m)`).catch(() => null);
    }
  }
}
