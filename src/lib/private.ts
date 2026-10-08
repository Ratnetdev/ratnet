// Public vs admin views. The agents' knowledge base (thresholds, priors, learned stats, check values, model weights)
// is admin only. Public pages get the same data with those parts stripped; an admin adds ?full=1 and gets everything
// uncached (the CDN only ever caches the stripped copy, since admin answers are no-store).
import { isAdmin } from "./admin";
import { cached, json } from "./http";

export async function wantsFull(req: Request) {
  return new URL(req.url).searchParams.get("full") === "1" && (await isAdmin());
}

/** Serve the full data to an admin who asked for it, the stripped copy (CDN-cached) to everyone else. */
export async function serve<T>(req: Request, data: T, strip: (d: T) => unknown, seconds = 3, swr = seconds * 5) {
  return (await wantsFull(req)) ? json({ ...(data as any), full: true }) : cached(strip(data), seconds, swr);
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
    events: publicEvs(d.events),
  };
}

function stripNow(n: any) {
  if (!n || typeof n !== "object") return n;
  const out: any = { ...n };
  if (Array.isArray(out.checks)) out.checks = publicChecks(out.checks);
  if (out.vet && Array.isArray(out.vet.checks)) out.vet = { ...out.vet, checks: publicChecks(out.vet.checks) };
  return out;
}

/** VET's lines carry the measured values behind each check in parentheses: public copies keep the words only. */
export function publicEv<T extends { agent?: string; text?: string }>(e: T): T {
  if (!e || e.agent !== "VET" || typeof e.text !== "string") return e;
  return { ...e, text: e.text.replace(/\s*\([^()]*\)/g, "").replace(/\s{2,}/g, " ").trim() };
}
export const publicEvs = (a: any[] | null | undefined) => (Array.isArray(a) ? a.map(publicEv) : a);

/** A King call without the model internals (feature parts, nano contributions, raw inputs). */
export function publicCall(c: any) {
  if (!c) return c;
  const { parts, nc, x, ...rest } = c;
  return rest;
}
