import { addWallet, setWallet } from "@/lib/hound";
import { isAdmin } from "@/lib/admin";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Admin: add a wallet to HOUND's book (checked for proof), switch one off, rename it.
export async function POST(req: Request) {
  if (!isAdmin()) return fail("unauthorized", 401);
  try {
    const b = await req.json();
    if (b.action === "add") return json({ ok: true, wallet: await addWallet(String(b.w || "").trim(), String(b.name || "wallet"), b.handle ? String(b.handle).replace(/^@/, "") : null, b.proof ? String(b.proof) : null, b.cls === "admin" ? "admin" : "kol") });
    if (b.action === "set") {
      const x = await setWallet(String(b.w || ""), { off: b.off, name: b.name, handle: b.handle });
      return x ? json({ ok: true, wallet: x }) : fail("no such wallet");
    }
    return fail("unknown action");
  } catch (e) {
    return fail(e);
  }
}
