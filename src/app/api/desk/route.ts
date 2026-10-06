import { getDesk } from "@/lib/desk";
import { fail } from "@/lib/http";
import { publicDesk, serve } from "@/lib/private";

export const dynamic = "force-dynamic";

// The desk. Public: without its playbook. Admin with ?full=1: everything.
export async function GET(req: Request) {
  try {
    return serve(req, await getDesk(), publicDesk, 3);
  } catch (e) {
    return fail(e, 500);
  }
}
