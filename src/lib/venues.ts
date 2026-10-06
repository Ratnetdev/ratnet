// Trade buttons: one link per venue, with the referral code filled in on the server so every click is a referral.
import type { Settings } from "@/config/site";

export const VENUES = ["pump", "dex", "gmgn", "axiom", "fomo"] as const;
export type Venue = (typeof VENUES)[number];

/** {ca} stays a placeholder; the client fills in the coin. */
export function venueTemplates(s: Settings): Record<Venue, string> {
  const out = {} as Record<Venue, string>;
  for (const v of VENUES) {
    const t = (s.venueTpl as any)[v] || { ref: "", plain: "" };
    const ref = (s.refs as any)[v] || "";
    out[v] = ref && t.ref ? t.ref.replace(/\{ref\}/g, encodeURIComponent(ref)) : t.plain;
  }
  return out;
}
