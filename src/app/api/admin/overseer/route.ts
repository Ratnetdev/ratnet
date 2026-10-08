import { decide, overseerView, think } from "@/lib/overseer";
import { isAdmin } from "@/lib/admin";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Admin: OVERSEER's trail, findings and ideas; approve, reject or park an idea; ask for ideas now.
export async function GET() {
  if (!(await isAdmin())) return fail("unauthorized", 401);
  return json(await overseerView());
}

export async function POST(req: Request) {
  if (!(await isAdmin())) return fail("unauthorized", 401);
  try {
    const b = await req.json();
    if (b.action === "think") return json(await think(true));
    if (b.action === "decide") {
      const i = await decide(Number(b.id), b.status, b.note);
      return i ? json({ ok: true, idea: i }) : fail("no such idea");
    }
    return fail("unknown action");
  } catch (e) {
    return fail(e);
  }
}
