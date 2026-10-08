// Every agent board on /desk in one answer (see lib/boards.ts). v0.1.40: read from the summary the worker writes
// every ~20s; built here only when the worker is down. Cached 8s on the CDN, so all viewers share it.
import { buildBoards } from "@/lib/boards";
import { cached, fail } from "@/lib/http";
import { readSite } from "@/lib/site";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return cached(await readSite("boards", 8_000, 90_000, buildBoards), 8);
  } catch (e) {
    return fail(e, 500);
  }
}
