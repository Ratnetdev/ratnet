import { K, redis } from "./redis";
import { dasAsset, fetchOffchain, getCurves } from "./solana";
import { reportLines, score, KING_VERSION } from "./king";
import { loadModel, type Launch } from "./digger";
import { features, nanoScore, NANO_MIN } from "./nano";
import { verdictOf } from "./king";

export type SniffReport = {
  id: string;
  ca: string;
  symbol: string;
  name: string;
  image: string;
  score: number | null;
  verdict: string;
  progress: number | null;
  mcapSol: number | null;
  complete: boolean;
  plus: string[];
  minus: string[];
  note: string;
  wallet: string;
  sig: string;
  free: boolean;
  at: number;
  version: string;
  dev: { n: number; b: number } | null;
  nano: { score: number; verdict: string } | null;
};

export async function sniff(ca: string, wallet: string, sig: string, free: boolean): Promise<SniffReport> {
  const r = redis();
  const [dug, curves] = await Promise.all([r.get<Launch>(K.launch(ca)), getCurves([ca])]);
  const c = curves[ca];

  let name = dug?.name || "";
  let symbol = dug?.symbol || "";
  let image = dug?.image || "";
  let off = dug
    ? { description: dug.description, twitter: dug.twitter, telegram: dug.telegram, website: dug.website }
    : null;
  if (!dug) {
    const a = await dasAsset(ca);
    if (a) {
      name = a.name;
      symbol = a.symbol;
      const o = await fetchOffchain(a.uri, 3000);
      if (o) {
        off = o;
        image = o.image;
      }
    }
  }

  const base = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ca,
    symbol,
    name,
    image,
    wallet,
    sig,
    free,
    at: Date.now(),
    version: KING_VERSION,
    dev: dug ? { n: dug.devN ?? 0, b: dug.devB ?? 0 } : null,
    nano: null as { score: number; verdict: string } | null,
  };

  if (!c) {
    return {
      ...base,
      score: null,
      verdict: "NO CURVE",
      progress: null,
      mcapSol: null,
      complete: false,
      plus: [],
      minus: ["not a pump.fun bonding curve coin"],
      note: "The Rat King v0 only reads pump.fun curves. v1 widens the nose.",
    };
  }

  const input = {
    progress: c.progress,
    progress0: dug ? dug.p0 : c.progress,
    twitter: !!off?.twitter,
    telegram: !!off?.telegram,
    website: !!off?.website,
    description: off?.description || "",
    symbol,
    name,
    devBuySol: dug ? dug.devBuySol : null,
  };
  const sc = score(input);
  const lines = reportLines(input, sc, { mcapSol: c.mcapSol, complete: c.complete });
  if (dug) {
    const n = dug.devN ?? 0;
    const b = dug.devB ?? 0;
    if (n === 0) lines.plus.push("fresh dev, first launch the rats have seen");
    else if (b > 0) lines.plus.push(`dev has bonded ${b} of ${n} before`);
    else if (n >= 5) lines.minus.push(`dev launched ${n} coins, none bonded`);
    const model = await loadModel();
    if (model.n >= NANO_MIN) {
      const x = features({
        curve5: c.progress,
        curve0: dug.p0,
        devBuySol: dug.devBuySol,
        twitter: !!dug.twitter,
        telegram: !!dug.telegram,
        website: !!dug.website,
        description: dug.description,
        symbol: dug.symbol,
        name: dug.name,
        devN: n,
        devB: b,
        createdAt: dug.createdAt,
      });
      const ns = nanoScore(model, x);
      base.nano = { score: ns, verdict: verdictOf(ns) };
    }
  }
  return {
    ...base,
    score: c.complete ? 100 : sc.score,
    verdict: c.complete ? "BONDED" : sc.verdict,
    progress: c.progress,
    mcapSol: c.mcapSol,
    complete: c.complete,
    plus: lines.plus,
    minus: lines.minus,
    note: dug
      ? "Dug by the rats at launch: full history used."
      : "Not in the rat dataset yet: scored on current state only. v0 is tuned for fresh launches.",
  };
}

export async function saveSniff(rep: SniffReport) {
  const p = redis().pipeline();
  p.lpush(K.sniffs, rep);
  p.ltrim(K.sniffs, 0, 499);
  p.hincrby(K.stat, "sniffs", 1);
  if (rep.wallet) p.sadd(K.sniffers, rep.wallet);
  await p.exec();
}
