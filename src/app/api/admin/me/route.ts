import { isAdmin } from "@/lib/admin";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Is this browser signed in to admin? Lets public pages ask for the full, unstripped data.
export async function GET() {
  return json({ admin: isAdmin() });
}
