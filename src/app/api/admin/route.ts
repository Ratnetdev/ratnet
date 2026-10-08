import { isAdmin } from "@/lib/admin";
import { DEFAULT_SETTINGS } from "@/config/site";
import { fail, json } from "@/lib/http";
import { getSettings, saveSettings } from "@/lib/settings";
import { computeRound, getRounds, payRound } from "@/lib/rounds";
import { exportDay } from "@/lib/exporter";
import { dig } from "@/lib/digger";
import { isPubkey } from "@/lib/solana";
import { K, redis } from "@/lib/redis";
import { roundOf } from "@/lib/rats";
import { resetDesk } from "@/lib/desk";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  if (!(await isAdmin())) return fail("unauthorized", 401);
  const [settings, rounds, sniffers] = await Promise.all([getSettings(), getRounds(), redis().smembers(K.sniffers)]);
  return json({ settings, rounds, currentRound: roundOf(), sniffers: sniffers.length });
}

export async function POST(req: Request) {
  if (!(await isAdmin())) return fail("unauthorized", 401);
  try {
    const body = await req.json();
    switch (body.action) {
      case "settings": {
        const p = body.settings || {};
        if (p.mint && !isPubkey(p.mint)) return fail("Mint is not a valid address");
        const clean: Record<string, unknown> = {};
        if (typeof p.mint === "string") clean.mint = p.mint.trim();
        for (const k of ["decimals", "spawnCost", "sniffCost", "minWork"]) if (p[k] !== undefined) clean[k] = Math.max(0, Number(p[k]));
        if (p.freeSniff !== undefined) clean.freeSniff = !!p.freeSniff;
        if (p.litter) clean.litter = { n: Math.max(1, Number(p.litter.n)), size: Math.max(1, Number(p.litter.size)), open: !!p.litter.open };
        if (p.links && typeof p.links === "object") clean.links = Object.fromEntries(Object.entries(p.links).filter(([, v]) => v === "" || (typeof v === "string" && /^https:\/\/[^\s"<>]+$/.test(v))).map(([k, v]) => [k, String(v).slice(0, 300)]));
        if (p.refs && typeof p.refs === "object") clean.refs = Object.fromEntries(Object.entries(p.refs).map(([k, v]) => [k, String(v || "").trim().replace(/[^A-Za-z0-9_\-.]/g, "")]));
        if (p.venueTpl && typeof p.venueTpl === "object") clean.venueTpl = Object.fromEntries(Object.entries(p.venueTpl).filter(([, v]: any) => v && /^https:\/\//.test(v.plain || "") && /^https:\/\//.test(v.ref || "")).map(([k, v]: any) => [k, { ref: String(v.ref).trim(), plain: String(v.plain).trim() }]));
        if (p.desk && typeof p.desk === "object") {
          const d = cleanDesk(p.desk);
          if (typeof d === "string") return fail(d);
          clean.desk = d;
        }
        if (p.history && typeof p.history === "object") {
          const h: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(p.history)) {
            if (!(k in DEFAULT_SETTINGS.history)) continue;
            const n = Number(v);
            h[k] = typeof v === "boolean" ? v : Number.isFinite(n) ? Math.min(1e6, Math.max(0, n)) : (DEFAULT_SETTINGS.history as any)[k];
          }
          clean.history = h;
        }
        if (clean.mint !== (await getSettings()).mint) await redis().del(K.ratPrice);
        return json({ settings: await saveSettings(clean) });
      }
      case "compute":
        return json({ round: await computeRound(Number(body.round), Number(body.feesSol)) });
      case "pay":
        return json({ round: await payRound(Number(body.round)) });
      case "export":
        return json({ export: await exportDay(String(body.day)) });
      case "dig":
        return json(await dig());
      case "desk-reset":
        await resetDesk();
        return json({ ok: true });
      case "desk-closeall":
        await redis().set("rn:desk:closeall", 1, { ex: 300 });
        return json({ ok: true });
      case "airdrop": {
        const [sniffers, rats] = await Promise.all([redis().smembers(K.sniffers), redis().hgetall<Record<string, { owner: string }>>(K.rats)]);
        const owners = Object.values(rats || {}).map((r) => r.owner);
        return json({ wallets: Array.from(new Set([...owners, ...sniffers])) });
      }
      default:
        return fail("Unknown action");
    }
  } catch (e) {
    return fail(e);
  }
}


// Desk settings are the trading wallet's controls, so every write is checked against the defaults' shape: only known
// keys, the same type, enums from their list, finite numbers, and hard bounds on anything that moves money. A typo
// (or a stolen session) can't set maxSol 1000 or 100% slippage.
const ENUMS: Record<string, string[]> = { mode: ["off", "paper", "auto", "live"], momoMode: ["on", "off"], mindMode: ["auto", "on", "off"], catchMode: ["auto", "on", "off"], flashMode: ["auto", "on", "off"] };
const BOUNDS: Record<string, [number, number]> = {
  start: [0.01, 1000], sizePct: [0.1, 25], minSol: [0.001, 5], maxSol: [0.001, 5], maxImpact: [0.1, 20], maxOpen: [0, 20],
  slippageBps: [50, 3000], maxPriorityLamports: [0, 20_000_000], jitoTipMinSol: [0, 0.01], jitoTipMaxSol: [0, 0.02],
  dailyLoss: [1, 60], sl: [-90, -1], momoSl: [-90, -1], ghostSol: [0, 1], flowWaitMs: [0, 10_000], catchFirstFrac: [0.05, 1], catchSendFrac: [0, 1], catchSl: [-90, -1], flashSl: [-90, -1], flashMaxOpen: [0, 10], flashFreshMs: [1000, 60_000], flashMaxCurve: [5, 95], flashMaxChase: [0, 300],
};

function cleanDesk(raw: Record<string, unknown>): Record<string, unknown> | string {
  const def = DEFAULT_SETTINGS.desk as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in def)) continue; // unknown keys are dropped
    const d0 = def[k];
    if (ENUMS[k]) {
      if (!ENUMS[k].includes(String(v))) return `Bad value for ${k}`;
      out[k] = String(v);
    } else if (typeof d0 === "boolean") out[k] = v === true || v === "true";
    else if (Array.isArray(d0)) {
      const a = (Array.isArray(v) ? v : []).map(Number);
      if (!a.length || a.some((x) => !Number.isFinite(x))) return `Bad list for ${k}`;
      out[k] = a.slice(0, 12);
    } else if (typeof d0 === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) return `${k} must be a number`;
      const [lo, hi] = BOUNDS[k] || [-1e9, 1e9];
      if (n < lo || n > hi) return `${k} must be between ${lo} and ${hi}`;
      out[k] = n;
    }
  }
  return out;
}
