// "Why this call": the reasons behind a Rat King score, in plain words, from the same numbers the score used.
import { score } from "./king";
import type { Tape } from "./tape";
import type { Graph } from "./graph";
import type { Meta } from "./meta";

export type Why = { plus: string[]; minus: string[] };

type In = {
  progress: number;
  progress0: number | null;
  twitter: boolean;
  telegram: boolean;
  website: boolean;
  description: string;
  symbol: string;
  name: string;
  devBuySol: number | null;
  devN?: number;
  devB?: number;
  tape?: Tape | null;
  g?: Graph | null;
  meta?: Meta | null;
};

export function whyOf(i: In): Why {
  const s = score({ ...i, farm: !!i.tape?.farm?.farm });
  const plus: [number, string][] = [];
  const minus: [number, string][] = [];
  const p = s.parts;
  if (i.tape?.farm?.farm) minus.push([100, `farm or bot coin: ${i.tape.farm.why}`]);
  if (p.curve >= 30) plus.push([p.curve, `curve already ${i.progress}% full at minute 5`]);
  else minus.push([45 - p.curve, `curve only ${i.progress}% full at minute 5`]);
  const climb = i.progress - (i.progress0 ?? i.progress);
  if (climb >= 5) plus.push([p.momentum, `curve climbed ${Math.round(climb)} points since it was dug`]);
  const soc = [i.twitter && "X", i.website && "website", i.telegram && "Telegram"].filter(Boolean) as string[];
  if (soc.length >= 2) plus.push([p.x + p.website + p.tg, `has ${soc.join(", ")}`]);
  else if (!soc.length) minus.push([12, "no X, website or Telegram"]);
  if ((i.devN ?? 0) >= 5 && (i.devB ?? 0) === 0) minus.push([20, `dev launched ${i.devN} coins, none bonded`]);
  else if ((i.devB ?? 0) > 0) plus.push([15, `dev has bonded ${i.devB} of ${i.devN} before`]);
  const d = i.devBuySol ?? 0;
  if (d > 5) minus.push([6, `heavy dev buy (${d} SOL)`]);
  const t = i.tape;
  if (t && !t.farm?.farm) {
    if ((t.organic ?? t.uniq) >= 25) plus.push([18, `${t.organic ?? t.uniq} real traders on the curve`]);
    if (t.bundleShare > 0.5) minus.push([14, `bundle holds ${Math.round(t.bundleShare * 100)}% of the SOL in`]);
    if (t.devSold > 0.25) minus.push([4, `dev already sold ${t.devSold} SOL`]);
    if (t.buyShare >= 0.65) plus.push([8, `${Math.round(t.buyShare * 100)}% of recent trades are buys`]);
  }
  const g = i.g;
  if (g) {
    if (g.smartN > 0) plus.push([20, `${g.smartN} smart wallet${g.smartN > 1 ? "s" : ""} bought early`]);
    if (g.clN >= 5 && g.clB === 0) minus.push([16, `dev's funder: ${g.clN} launches, none bonded`]);
    else if (g.clRatio >= 2) plus.push([14, `dev's funder bonds ${g.clRatio}x more often than average`]);
  }
  if (i.meta?.copy) minus.push([8, "copies a recent winner"]);
  if (i.meta?.hot) plus.push([6, `rides the hot meta "${i.meta.hot}"`]);
  const top = (a: [number, string][], n: number) => a.sort((x, y) => y[0] - x[0]).slice(0, n).map((x) => x[1]);
  return { plus: top(plus, 3), minus: top(minus, 2) };
}
