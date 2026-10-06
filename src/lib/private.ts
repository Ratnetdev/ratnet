// Public vs admin views. The agents' knowledge base (thresholds, priors, learned stats, check values, model weights)
// is admin only. Public pages get the same data with those parts stripped; an admin adds ?full=1 and gets everything
// uncached (the CDN only ever caches the stripped copy, since admin answers are no-store).
import { isAdmin } from "./admin";
import { cached, json } from "./http";

export function wantsFull(req: Request) {
  return new URL(req.url).searchParams.get("full") === "1" && isAdmin();
}

/** Serve the full data to an admin who asked for it, the stripped copy (CDN-cached) to everyone else. */
export function serve<T>(req: Request, data: T, strip: (d: T) => unknown, seconds = 3) {
  return wantsFull(req) ? json({ ...(data as any), full: true }) : cached(strip(data), seconds);
}

type Check = { rule: string; ok: boolean; v?: string };

/** Checks on a public trade: how many passed, and the failing one by name only. */
export function publicChecks(checks: Check[] | undefined | null) {
  if (!checks) return checks;
  return checks.map((c) => ({ rule: c.rule, ok: c.ok }));
}

export function publicCtx(ctx: any) {
  if (!ctx) return ctx;
  const { checks, card, ...rest } = ctx;
  return { ...rest, checks: publicChecks(checks), card: card ? { plus: card.plus, minus: card.minus } : undefined };
}

export function publicTrip(t: any) {
  return t ? { ...t, ctx: publicCtx(t.ctx) } : t;
}

/** The desk without its playbook: no config thresholds, no learned stats, no rule verdicts. */
export function publicDesk(d: any) {
  const cfg = d.cfg || {};
  return {
    ...d,
    cfg: { dailyLoss: cfg.dailyLoss, maxOpen: cfg.maxOpen, mode: cfg.mode },
    learn: d.learn ? { shadows: d.learn.shadows, reviewing: d.learn.reviewing, reviews: d.learn.reviews, xConnected: d.learn.xConnected } : null,
    film: d.film ? { ...d.film, rules: [], against: [], forR: [] } : null,
    positions: (d.positions || []).map((x: any) => ({ ...x, ctx: publicCtx(x.ctx) })),
    trades: (d.trades || []).map((x: any) => ({ ...x, ctx: publicCtx(x.ctx) })),
    vet: d.vet ? { ...d.vet, checks: publicChecks(d.vet.checks) } : null,
    now: d.now ? stripNow(d.now) : null,
  };
}

function stripNow(n: any) {
  if (!n || typeof n !== "object") return n;
  const out: any = { ...n };
  if (Array.isArray(out.checks)) out.checks = publicChecks(out.checks);
  if (out.vet && Array.isArray(out.vet.checks)) out.vet = { ...out.vet, checks: publicChecks(out.vet.checks) };
  return out;
}
