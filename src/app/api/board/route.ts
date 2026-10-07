import { board, confluence, recentCoins } from "@/lib/board";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// The BOARD on /desk: coins where several agent families agree right now, with each agent's stance.
export async function GET() {
  try {
    const mints = await recentCoins(30 * 60_000, 50);
    const now = Date.now();
    const rows = await Promise.all(
      mints.map(async (m) => {
        const posts = await board(m);
        const cf = confluence(posts, now);
        const sym = posts.find((x) => x.sym)?.sym || "";
        return { mint: m, sym, score: cf.score, pos: cf.pos, neg: cf.neg, posts: posts.filter((x) => now - x.at < 45 * 60_000).sort((a, b) => b.at - a.at).map((x) => ({ a: x.a, s: Math.round(x.s * 100) / 100, at: x.at, t: x.t })) };
      })
    );
    const top = rows.filter((x) => x.posts.length >= 2).sort((a, b) => b.pos - a.pos || b.score - a.score).slice(0, 12);
    return cached({ at: now, coins: top }, 4);
  } catch (e) {
    return fail(e, 500);
  }
}
