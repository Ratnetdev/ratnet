// Rat King v0: a transparent baseline scorer. Every weight is public on /king.
// v1 replaces this with a model trained from scratch on the dug dataset.

export const KING_VERSION = "v0.3"; // v0.1: farm penalty. v0.2: bot coins (few wallets, wash loops, micro-buys) count as farms. v0.3: +8 when the coin was born from a post by a tracked X account (WIRE), +5 when named after a narrative rising on X (PULSE)

export type ScoreInput = {
  progress: number | null; // bonding curve % at call time
  progress0: number | null; // bonding curve % when first dug
  twitter: boolean;
  telegram: boolean;
  website: boolean;
  description: string;
  symbol: string;
  name: string;
  devBuySol: number | null;
  farm?: boolean; // block-0 farm pattern from the tape (see tape.ts farmCheck)
  wire?: boolean; // born from a post by a tracked X account (see wire.ts)
  pulse?: boolean; // named after a narrative rising on X right now (see pulse.ts)
};

export const WEIGHTS = [
  { key: "curve", label: "Curve filled at call (full points at 30%)", max: 45 },
  { key: "momentum", label: "Curve growth since first dig (full points at +15%)", max: 15 },
  { key: "x", label: "X link present", max: 8 },
  { key: "website", label: "Website present", max: 6 },
  { key: "tg", label: "Telegram present", max: 4 },
  { key: "desc", label: "Description of 40+ characters", max: 5 },
  { key: "dev", label: "Dev buy between 0.5 and 5 SOL (over 5 SOL: 2 pts)", max: 5 },
  { key: "ticker", label: "Clean ticker (2 to 8 letters or digits)", max: 4 },
  { key: "name", label: "Name of 24 characters or less, not a test", max: 3 },
  { key: "wire", label: "Born from a post by a tracked X account (bonus on top)", max: 8 },
  { key: "pulse", label: "Named after a narrative rising on X right now (bonus on top)", max: 5 },
  { key: "farm", label: "Farm or bot coin: curve pumped in block 0-2 with no organic buyers, bundle-run, volume bots, 3 or fewer wallets trading, wash loops or micro-buys (penalty)", max: -45 },
] as const;

const MAX_RAW = WEIGHTS.reduce((a, w) => a + (w.key === "wire" || w.key === "pulse" ? 0 : Math.max(0, w.max)), 0); // 95: the WIRE bonus sits on top

export const VERDICTS = { bond: 60, watch: 30 }; // >=60 BOND, 30..59 WATCH, <30 DUST
export type Verdict = "BOND" | "WATCH" | "DUST";

export function verdictOf(score: number): Verdict {
  if (score >= VERDICTS.bond) return "BOND";
  if (score >= VERDICTS.watch) return "WATCH";
  return "DUST";
}

export function score(i: ScoreInput) {
  const parts: Record<string, number> = {};
  const p = i.progress ?? 0;
  const p0 = i.progress0 ?? p;
  parts.curve = 45 * Math.min(1, Math.max(0, p) / 30);
  parts.momentum = 15 * Math.min(1, Math.max(0, p - p0) / 15);
  parts.x = i.twitter ? 8 : 0;
  parts.website = i.website ? 6 : 0;
  parts.tg = i.telegram ? 4 : 0;
  parts.desc = (i.description || "").trim().length >= 40 ? 5 : 0;
  const d = i.devBuySol ?? 0;
  parts.dev = d >= 0.5 && d <= 5 ? 5 : d > 5 ? 2 : 0;
  parts.ticker = /^[A-Za-z0-9]{2,8}$/.test(i.symbol || "") ? 4 : 0;
  parts.name = i.name && i.name.length <= 24 && !/test/i.test(i.name) ? 3 : 0;
  parts.wire = i.wire ? 8 : 0;
  parts.pulse = i.pulse && !i.wire ? 5 : 0;
  parts.farm = i.farm ? -45 : 0;
  const raw = Object.values(parts).reduce((a, b) => a + b, 0);
  const s = Math.min(100, Math.max(0, Math.round((raw / MAX_RAW) * 100)));
  return { score: s, verdict: verdictOf(s), parts };
}

/** Short report lines for a sniff or a call card. */
export function reportLines(i: ScoreInput, s: ReturnType<typeof score>, extra: { mcapSol?: number | null; complete?: boolean }) {
  const plus: string[] = [];
  const minus: string[] = [];
  if (extra.complete) plus.push("already bonded, the curve is done");
  if ((i.progress ?? 0) >= 20) plus.push(`curve at ${i.progress}%`);
  else minus.push(`curve only at ${i.progress ?? 0}%`);
  if ((i.progress ?? 0) - (i.progress0 ?? i.progress ?? 0) >= 5) plus.push("curve climbing since first dig");
  i.twitter ? plus.push("X linked") : minus.push("no X");
  i.website ? plus.push("has a website") : minus.push("no website");
  if (!i.telegram) minus.push("no Telegram");
  if ((i.description || "").trim().length < 40) minus.push("thin description");
  if ((i.devBuySol ?? 0) > 5) minus.push(`heavy dev buy (${i.devBuySol} SOL)`);
  if (!/^[A-Za-z0-9]{2,8}$/.test(i.symbol || "")) minus.push("messy ticker");
  return { plus: plus.slice(0, 4), minus: minus.slice(0, 4) };
}
