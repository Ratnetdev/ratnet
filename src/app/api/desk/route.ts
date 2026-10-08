import { getDesk } from "@/lib/desk";
import { memo } from "@/lib/memo";
import { readSite } from "@/lib/site";
import { fail } from "@/lib/http";
import { publicDesk, serve, wantsFull } from "@/lib/private";

export const dynamic = "force-dynamic";

// The desk. Public: without its playbook, from the copy the worker builds every ~6s (lib/site.ts). Admin with
// ?full=1: everything, built here (at most every 5s per server instance).
export async function GET(req: Request) {
  try {
    const full = await wantsFull(req);
    const d = full ? await memo("desk:full", 5_000, getDesk) : await readSite("desk", 5_000, 45_000, getDesk);
    return serve(req, d, publicDesk, 5, 10);
  } catch (e) {
    return fail(e, 500);
  }
}
