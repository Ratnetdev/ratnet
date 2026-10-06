import { buildBurnTx, BurnKind } from "@/lib/burns";
import { getSettings } from "@/lib/settings";
import { isPubkey } from "@/lib/solana";
import { fail, json } from "@/lib/http";
import { redis } from "@/lib/redis";
import { allRats, isActive, PUPS_KEY } from "@/lib/rats";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { wallet, kind, ca } = await req.json();
    if (!isPubkey(wallet)) return fail("Connect a wallet first");
    if (kind !== "spawn" && kind !== "sniff" && kind !== "pup") return fail("Unknown burn");
    const s = await getSettings();
    if (kind === "spawn" && !s.litter.open) return fail(`Litter ${s.litter.n} is closed. Next litter opens soon.`);
    if (kind === "pup") {
      const [n, rats] = await Promise.all([redis().hlen(PUPS_KEY), allRats()]);
      if (Number(n || 0) >= s.pupMax) return fail(`All ${s.pupMax.toLocaleString()} pups are taken`);
      if (!rats.some((r) => isActive(r, s))) return fail("Pups ride with adult rats: the first rats are not born yet");
    }
    if (kind === "sniff" && !isPubkey(ca)) return fail("Paste a valid CA");
    const tx = await buildBurnTx(wallet, kind as BurnKind, s, kind === "sniff" ? String(ca).slice(0, 8) : "");
    return json({ tx });
  } catch (e) {
    return fail(e);
  }
}
