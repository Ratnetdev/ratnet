"use client";
import { useRef } from "react";
// The LensCam: LENS's browser, live. Like watching someone open the website, the X account, the search and the
// Telegram of a coin, one tab after another, ticking off a checklist and writing the verdict.
import Link from "next/link";
import { usePoll } from "./usePoll";
import Info from "./Info";
import { safeHref, ago } from "./fmt";
import { lensCol } from "./Scorecard";
import CoinImg from "./CoinImg";

type Step = { k: string; label: string; st: "wait" | "run" | "ok" | "bad" | "skip"; note?: string };
type Live = { mint: string; symbol: string; image?: string; at: number; why: string; url: string; tab: string; title: string; text: string; steps: Step[]; score?: number; done: boolean };
type Recent = { mint: string; symbol: string; at: number; why: string; score: number; flags: string[]; good: string[] };
type View = { on: boolean; x: boolean; live: Live | null; recent: Recent[]; queued: number };
export type Dossier = {
  mint: string; symbol: string; at: number; why: string; done: boolean; score: number; flags: string[]; good: string[];
  site: { url: string; up: boolean; title: string; text: string; builder: string | null; caOnSite: boolean; linksX: boolean; domainAgeDays: number | null } | null;
  x: { kind: string; handle: string | null; followers: number | null; ageDays: number | null; posts: number | null; blue: boolean; bio: string; postText?: string; likes?: number; views?: number; trust?: number } | null;
  talk: { posts: number; authors: number; reach: number; top: { h: string; f: number; text: string; url: string }[]; known: string[] } | null;
  tg: { url: string; members: number | null } | null;
};

const WHY: Record<string, string> = { buy: "desk bought it", wire: "tweet pick", bond: "BOND call", pulse: "rising narrative" };
const TABS = [["site", "website"], ["x", "X"], ["talk", "X search"], ["tg", "Telegram"], ["verdict", "dossier"]] as const;
const ICON: Record<Step["st"], string> = { wait: "·", run: "›", ok: "✓", bad: "✗", skip: "–" };
const k = (n: number | null | undefined) => (n == null ? "?" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));

function Browser({ l }: { l: Live }) {
  const stale = !l.done && Date.now() - l.at > 120_000;
  return (
    <div className="lc">
      <div className="lc-bar">
        <span className="lc-dots"><i /><i /><i /></span>
        <span className="lc-tabs">
          {TABS.map(([t, label]) => (
            <span key={t} className={`lc-tab ${l.tab === t ? "on" : ""}`}>{label}</span>
          ))}
        </span>
      </div>
      <div className="lc-url">
        <span className={`lc-dot ${l.done ? "done" : stale ? "" : "run"}`} />
        <span className="lc-addr">{l.url || "about:blank"}</span>
        <Link href={`/c/${l.mint}`} className="lc-coin"><CoinImg mint={l.mint} sym={l.symbol} size={14} />${l.symbol}</Link>
      </div>
      <div className="lc-body">
        <div className="lc-page">
          <div className="lc-title">{l.title}</div>
          <pre className="lc-text">{l.text || " "}</pre>
        </div>
        <div className="lc-steps">
          <div className="lc-why">{WHY[l.why] || l.why}</div>
          {l.steps.map((s) => (
            <div key={s.k} className={`lc-step ${s.st}`}>
              <i>{ICON[s.st]}</i>
              <span>{s.label}</span>
              {s.note ? <em>{s.note}</em> : null}
            </div>
          ))}
          {l.done && l.score != null ? <div className="lc-score" style={{ color: lensCol(l.score) }}>{l.score}<small>/100</small></div> : null}
        </div>
      </div>
    </div>
  );
}

/** The live LensCam with the latest dossiers. On /desk. */
export default function LensCam() {
  const box = useRef<HTMLElement>(null);
  const v = usePoll<View>("/api/lens", 5000, { ref: box }).data;
  return (
    <section className="panel mt lens" ref={box}>
      <div className="ph">
        <span><Info k="lens"><b>LENS</b></Info> · hands-on look at the coins that matter{v?.live ? ` · ${ago(v.live.at)} ago` : ""}</span>
        <span className="tiny muted">{v ? `${v.queued} queued${v.x ? "" : " · X reads off (add X_API_KEY)"}` : ""}</span>
      </div>
      {v?.live ? <Browser l={v.live} /> : <div className="pb muted small">{v ? "LENS opens the website, the X account, an X search for the CA and the Telegram of every desk buy, tweet pick, BOND call and narrative coin. Waiting for the first one." : "loading…"}</div>}
      {v?.recent?.length ? (
        <div className="lc-recent">
          {v.recent.slice(0, 8).map((r) => (
            <Link key={`${r.mint}${r.at}`} href={`/c/${r.mint}`} className="lc-row">
              <b style={{ color: lensCol(r.score) }}>{r.score}</b>
              <span className="lc-sym"><CoinImg mint={r.mint} sym={r.symbol} size={14} />${r.symbol}</span>
              <span className="lc-tag">{WHY[r.why] || r.why}</span>
              <span className="lc-note">{r.flags[0] ? <span className="red">- {r.flags[0]}</span> : r.good[0] ? <span className="green">+ {r.good[0]}</span> : null}</span>
              <span className="muted tiny">{ago(r.at)}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** One coin's LENS dossier, with the live browser when LENS is on this coin right now. On coin pages. */
export function LensDossier({ mint, dossier }: { mint: string; dossier: Dossier | null }) {
  const v = usePoll<View>("/api/lens", 5000).data;
  const live = v?.live?.mint === mint && !v.live.done ? v.live : null;
  const d = dossier;
  if (!d && !live) return null;
  return (
    <section className="panel mt lens">
      <div className="ph">
        <span><Info k="lens"><b>LENS dossier</b></Info>{d ? ` · ${ago(d.at)} ago · ${WHY[d.why] || d.why}` : " · looking now"}</span>
        {d ? <b style={{ color: lensCol(d.score) }}>{d.score}/100</b> : null}
      </div>
      {live ? <Browser l={live} /> : null}
      {d ? (
        <div className="pb">
          <div className="ld-grid">
            <div>
              <div className="sc-h">Website</div>
              {d.site ? (
                <>
                  <a href={safeHref(d.site.url)} target="_blank" rel="noreferrer nofollow" className="ld-link">{d.site.url.replace(/^https?:\/\//, "").slice(0, 48)}</a>
                  <div className="tiny muted">{d.site.up ? `${d.site.builder || "custom"} · ${d.site.domainAgeDays == null ? "domain age ?" : `domain ${Math.round(d.site.domainAgeDays)}d old`}${d.site.caOnSite ? " · CA on page" : ""}${d.site.linksX ? " · links X" : ""}` : "does not load"}</div>
                  {d.site.title ? <div className="small">{d.site.title}</div> : null}
                </>
              ) : <div className="muted small">none</div>}
            </div>
            <div>
              <div className="sc-h">X</div>
              {d.x ? (
                <>
                  {d.x.handle ? <a href={`https://x.com/${encodeURIComponent(d.x.handle)}`} target="_blank" rel="noreferrer" className="ld-link">@{d.x.handle}</a> : <span className="small">community</span>}
                  <div className="tiny muted">{d.x.kind === "post" ? "the post behind it · " : ""}{k(d.x.followers)} followers{d.x.ageDays != null ? ` · ${Math.round(d.x.ageDays)}d old` : ""}{d.x.blue ? " · blue" : ""}{d.x.trust ? ` · WIRE trust ${d.x.trust}` : ""}</div>
                  {d.x.postText ? <q className="small">{d.x.postText}</q> : d.x.bio ? <div className="small muted">{d.x.bio}</div> : null}
                </>
              ) : <div className="muted small">none</div>}
            </div>
            <div>
              <div className="sc-h">Talking about it <span className="muted">last hour</span></div>
              {d.talk ? (
                <>
                  <div className="small">{d.talk.authors} accounts · {d.talk.posts} posts · {k(d.talk.reach)} reach</div>
                  {d.talk.known.length ? <div className="tiny green">trusted: @{d.talk.known.join(", @")}</div> : null}
                  {d.talk.top.slice(0, 3).map((t) => (
                    <a key={t.url} href={safeHref(t.url)} target="_blank" rel="noreferrer" className="ld-post"><b>@{t.h}</b> <span className="muted">{k(t.f)}</span> {t.text}</a>
                  ))}
                </>
              ) : <div className="muted small">X reads not connected</div>}
            </div>
            <div>
              <div className="sc-h">Telegram</div>
              {d.tg ? <><a href={safeHref(d.tg.url)} target="_blank" rel="noreferrer" className="ld-link">{d.tg.url.replace("https://", "")}</a><div className="tiny muted">{d.tg.members != null ? `${k(d.tg.members)} members` : "no count"}</div></> : <div className="muted small">none</div>}
            </div>
          </div>
          <div className="sc-grid" style={{ marginTop: 12 }}>
            <div>{d.good.map((x) => <div key={x} className="sc-r plus"><i>+</i>{x}</div>)}</div>
            <div>{d.flags.map((x) => <div key={x} className="sc-r minus"><i>-</i>{x}</div>)}</div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
