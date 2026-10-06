import { isAdmin } from "@/lib/admin";
import { fail, json } from "@/lib/http";
import { getSettings, saveSettings } from "@/lib/settings";
import { computeRound, getRounds, payRound } from "@/lib/rounds";
import { exportDay } from "@/lib/exporter";
import { dig } from "@/lib/digger";
import { isPubkey } from "@/lib/solana";
import { K, redis } from "@/lib/redis";
import { roundOf } from "@/lib/rats";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  if (!isAdmin()) return fail("unauthorized", 401);
  const [settings, rounds, sniffers] = await Promise.all([getSettings(), getRounds(), redis().smembers(K.sniffers)]);
  return json({ settings, rounds, currentRound: roundOf(), sniffers: sniffers.length });
}

export async function POST(req: Request) {
  if (!isAdmin()) return fail("unauthorized", 401);
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
        if (p.links) clean.links = p.links;
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
