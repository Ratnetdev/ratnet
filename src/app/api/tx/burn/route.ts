import { buildBurnTx, BurnKind } from "@/lib/burns";
import { getSettings } from "@/lib/settings";
import { isPubkey } from "@/lib/solana";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { wallet, kind, ca } = await req.json();
    if (!isPubkey(wallet)) return fail("Connect a wallet first");
    if (kind !== "spawn" && kind !== "sniff") return fail("Unknown burn");
    const s = await getSettings();
    if (kind === "spawn" && !s.litter.open) return fail(`Litter ${s.litter.n} is closed. Next litter opens soon.`);
    if (kind === "sniff" && !isPubkey(ca)) return fail("Paste a valid CA");
    const tx = await buildBurnTx(wallet, kind as BurnKind, s, kind === "sniff" ? String(ca).slice(0, 8) : "");
    return json({ tx });
  } catch (e) {
    return fail(e);
  }
}
