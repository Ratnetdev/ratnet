// v0.1.40: Upstash bandwidth meter (worker only). Upstash bills and caps the bytes sent to it and received from it.
// Twice (7 and 8 Oct) the plan's monthly bandwidth ran out and every page and loop went down, and both times the
// cause had to be found by reading code. This counts the bytes of every Redis call by command and key family, keeps
// the hourly totals in memory, logs them, stores a small summary in Redis (rn:bw) and reports to the private
// Telegram chat: every 6 hours, and at once when one hour uses more than BW_ALERT_MB_HOUR (default 150MB, which is
// about 4.5GB a day).
import { installRedisWire, onWire, wireTotals } from "./rediswire";
import { bwView } from "./bwgov";
const ALERT_MB_HOUR = Number(process.env.BW_ALERT_MB_HOUR || 150);
const REPORT_EVERY_MS = 6 * 3600_000;

type Row = { n: number; tx: number; rx: number };
let hour: Map<string, Row> = new Map();
let hourStart = Date.now();
let day = { tx: 0, rx: 0, since: Date.now() };
let lastReport = 0;
let lastHour: { at: number; mb: number; top: [string, number][] } | null = null;

// ids, mints, wallets, dates and numbers are folded so one key family is one row
const family = (k: unknown) =>
  String(k ?? "")
    .replace(/[1-9A-HJ-NP-Za-km-z]{25,}/g, "*")
    .replace(/\d{4}-\d{2}-\d{2}(T\d{2})?/g, "#")
    .replace(/\d+/g, "#")
    .slice(0, 48);
const label = (cmd: unknown) => (Array.isArray(cmd) ? `${String(cmd[0] || "?").toLowerCase()} ${family(cmd[1])}` : "?");

function add(lbl: string, tx: number, rx: number) {
  const r = hour.get(lbl) || { n: 0, tx: 0, rx: 0 };
  r.n++;
  r.tx += tx;
  r.rx += rx;
  hour.set(lbl, r);
  day.tx += tx;
  day.rx += rx;
}

const mb = (b: number) => Math.round((b / 1e6) * 10) / 10;

export function installBwMeter() {
  const g = globalThis as any;
  if (g.__rnBwMeter) return;
  g.__rnBwMeter = true;
  // v0.1.40: the wire layer (lib/rediswire.ts) owns the fetch wrapper; the meter only listens to it
  onWire((cmds, tx, rx) => cmds.forEach((c, i) => add(label(c), tx[i] || 0, rx[i] || 0)));
  installRedisWire();
}

/** Called by the worker every 20s: rolls the hour over, logs, stores the summary and sends Telegram reports. */
let govWriteAt = 0;
export async function bwTick() {
  const now = Date.now();
  // the day's total and saving mode for /status, every 2 minutes (the hourly breakdown below stays hourly)
  if (now - govWriteAt > 120_000) {
    govWriteAt = now;
    const { redis } = await import("./redis");
    await redis().set("rn:bw", { at: now, hourMB: lastHour?.mb ?? null, top: lastHour?.top ?? [], gov: bwView(now) }, { ex: 7 * 86400 }).catch(() => null);
  }
  if (now - hourStart < 3600_000) return;
  const rows = Array.from(hour.entries()).map(([k, r]) => [k, r.tx + r.rx, r.n] as [string, number, number]).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, r) => a + r[1], 0);
  const top = rows.slice(0, 15).map((r) => [r[0], mb(r[1])] as [string, number]); // v0.1.62: 15 (was 8)
  lastHour = { at: now, mb: mb(total), top };
  hour = new Map();
  hourStart = now;
  console.log(`[bw] last hour ${mb(total)}MB to/from Upstash. top: ${top.map(([k, v]) => `${k} ${v}MB`).join(" | ")}`);
  const days = Math.max(1 / 24, (now - day.since) / 86400_000);
  const perDay = mb((day.tx + day.rx) / days);
  const { redis } = await import("./redis");
  await redis().set("rn:bw", { at: now, hourMB: mb(total), perDayMB: perDay, top, gov: bwView(now) }, { ex: 7 * 86400 }).catch(() => null);
  // v0.1.64: on Railway's own Redis bytes cost nothing: no alerts, no reports
  const { bwLimited } = await import("./bwgov");
  if (!bwLimited()) return;
  const alert = mb(total) > ALERT_MB_HOUR;
  if (!alert && now - lastReport < REPORT_EVERY_MS) return;
  lastReport = now;
  const { tgSend, ideasChat, esc } = await import("./tgbot");
  const chat = ideasChat();
  if (!chat || !process.env.TELEGRAM_BOT_TOKEN) return;
  const gv = bwView();
  const { bwSrcKey } = await import("./bwgov");
  const src = ((await redis().hgetall<Record<string, number>>(bwSrcKey(now)).catch(() => null)) || {}) as Record<string, number>;
  const srcLine = `Today by source: worker ${(Number(src.worker || 0) / 1e9).toFixed(2)}GB, site ${(Number(src.site || 0) / 1e9).toFixed(2)}GB.`;
  const lines = top.slice(0, 5).map(([k, v]) => `• ${esc(k)}: ${v}MB`).join("\n");
  await tgSend(
    chat,
    `${alert ? "⚠️" : "📊"} <b>Redis bandwidth</b>: worker ${mb(total)}MB last hour (~${(perDay / 1000).toFixed(1)}GB a day). Today, worker and site together: ${(gv.dayMB / 1000).toFixed(2)}GB of ${(gv.allowMB / 1000).toFixed(1)}GB (pace now ${(gv.paceMB / 1000).toFixed(2)}GB)${gv.level ? `, <b>saving mode ${gv.level}</b>` : ""}. This hour ${gv.hourMB}MB (${gv.hourRate}x the hourly allowance). ${srcLine} Compression saved ${mb(wireTotals.saved)}MB of writes so far.\n${lines}`,
  ).catch(() => null);
}

export const bwLast = () => lastHour;
