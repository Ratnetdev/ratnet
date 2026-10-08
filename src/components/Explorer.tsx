"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePoll } from "./usePoll";
import { ScoreBar } from "./Calls";
import { CurveBar } from "./Radar";
import { fmtSecs } from "./Grads";
import { ago, chg, num, usd, type Mkt } from "./fmt";
import Info from "./Info";
import { TradeIcons } from "./venues";

type Row = {
  m: string;
  s: string;
  n: string;
  t: number;
  v: number;
  V: string;
  ns: number | null;
  NV: string;
  o: string;
  p: number;
  c: 0 | 1;
  dn: number;
  db: number;
  so: number;
  bs: number | null;
  cur: number | null;
  pk: number | null;
};

type F = {
  king: string; // "" | B | W | D
  nano: string;
  agree: boolean;
  out: string; // "" | P | B | D | A
  dev: string; // "" | fresh | proven | noserial
  soc: number; // 0 1 3
  min: number;
  win: number; // hours
  q: string;
  sort: string; // new | king | nano | curve | peak | fast
};
const DEF: F = { king: "", nano: "", agree: false, out: "", dev: "", soc: 0, min: 0, win: 24, q: "", sort: "new" };

const PRESETS: { label: string; f: Partial<F> }[] = [
  { label: "King says BOND", f: { king: "B", sort: "king" } },
  { label: "King + nano agree", f: { agree: true, sort: "king" } },
  { label: "Climbing now", f: { out: "P", sort: "curve" } },
  { label: "Fresh devs, liked", f: { dev: "fresh", king: "W", sort: "king" } },
  { label: "Graduated", f: { out: "B", sort: "new" } },
  { label: "Fastest bonds", f: { out: "B", sort: "fast" } },
  { label: "King missed it", f: { out: "B", king: "D", sort: "new" } },
];

const VNAME: Record<string, string> = { B: "BOND", W: "WATCH", D: "DUST" };
const ONAME: Record<string, string> = { B: "BONDED", A: "ALIVE", D: "DIED" };

function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button className={`btn ${on ? "" : "dim"}`} style={{ padding: "3px 10px", fontSize: 11 }} onClick={onClick}>
      {children}
    </button>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row wrapx" style={{ gap: 6 }}>
      <span className="tiny muted" style={{ width: 62, textTransform: "uppercase", letterSpacing: 1 }}>{label}</span>
      {children}
    </div>
  );
}

function toQuery(f: F) {
  const q = new URLSearchParams();
  (Object.keys(DEF) as (keyof F)[]).forEach((k) => {
    if (f[k] !== DEF[k]) q.set(k, String(f[k]));
  });
  return q.toString();
}
function fromQuery(s: string): F {
  const q = new URLSearchParams(s);
  const f: any = { ...DEF };
  (Object.keys(DEF) as (keyof F)[]).forEach((k) => {
    const v = q.get(k);
    if (v == null) return;
    f[k] = typeof DEF[k] === "number" ? Number(v) : typeof DEF[k] === "boolean" ? v === "true" : v;
  });
  return f;
}

export default function Explorer() {
  const { data, error } = usePoll<{ rows: Row[]; now: number }>("/api/coins", 15000);
  const [f, setF] = useState<F>(DEF);
  const [page, setPage] = useState(0);
  useEffect(() => setF(fromQuery(window.location.search.slice(1))), []);
  useEffect(() => {
    const q = toQuery(f);
    window.history.replaceState(null, "", q ? `?${q}` : window.location.pathname);
    setPage(0);
  }, [f]);
  const set = (p: Partial<F>) => setF((x) => ({ ...x, ...p }));

  const rows = useMemo(() => {
    const now = Date.now();
    const q = f.q.trim().toLowerCase();
    let r = (data?.rows || []).filter((x) => {
      if (now - x.t > f.win * 3600_000) return false;
      if (f.king && x.V !== f.king) return false;
      if (f.nano && x.NV !== f.nano) return false;
      if (f.agree && !(x.V !== "D" && x.V === x.NV)) return false;
      if (f.out === "P" ? !!x.o : f.out && x.o !== f.out) return false;
      if (f.dev === "fresh" && x.dn > 0) return false;
      if (f.dev === "proven" && x.db === 0) return false;
      if (f.dev === "noserial" && x.dn >= 5 && x.db === 0) return false;
      if (x.so < f.soc) return false;
      if (x.v < f.min) return false;
      if (q && !x.s.toLowerCase().includes(q) && !x.n.toLowerCase().includes(q) && !x.m.toLowerCase().startsWith(q)) return false;
      return true;
    });
    const by: Record<string, (a: Row, b: Row) => number> = {
      new: (a, b) => b.t - a.t,
      king: (a, b) => b.v - a.v || b.t - a.t,
      nano: (a, b) => (b.ns ?? -1) - (a.ns ?? -1) || b.t - a.t,
      curve: (a, b) => (b.cur ?? -1) - (a.cur ?? -1),
      peak: (a, b) => (b.pk ?? -1) - (a.pk ?? -1),
      fast: (a, b) => (a.bs ?? 1e12) - (b.bs ?? 1e12),
    };
    r = [...r].sort(by[f.sort] || by.new);
    return r;
  }, [data, f]);

  const bonded = rows.filter((x) => x.o === "B").length;
  const pending = rows.filter((x) => !x.o).length;
  const dead = rows.filter((x) => x.o === "D").length;
  const settled = rows.length - pending;
  const PER = 50;
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const view = rows.slice(page * PER, page * PER + PER);
  const viewKey = view.map((x) => x.m).join(",");
  const [mkt, setMkt] = useState<Record<string, Mkt | null>>({});
  useEffect(() => {
    if (!viewKey) return;
    const t = setTimeout(() => {
      fetch(`/api/market?m=${viewKey}`)
        .then((r) => r.json())
        .then((j) => setMkt((old) => ({ ...old, ...(j.market || {}) })))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [viewKey, data?.now]);

  const [more, setMore] = useState(false);
  return (
    <>
      <section className="panel glow">
        <div className="ph wrapx" style={{ gap: 10 }}>
          <span className="row" style={{ gap: 6 }}>
            <span className={`dot ${error ? "off" : ""}`} /> <b>filters</b> · {num(data?.rows.length ?? 0)} coins indexed
          </span>
          <span className="row wrapx" style={{ gap: 6 }}>
            {PRESETS.map((p) => (
              <Chip key={p.label} on={false} onClick={() => setF({ ...DEF, win: f.win, ...p.f })}>{p.label}</Chip>
            ))}
            <Chip on={false} onClick={() => setF(DEF)}>reset</Chip>
            {/* v0.1.47: on phones the detailed filters fold away under the presets (they filled two screens) */}
            <button className="btn sm ghost ex-more" onClick={() => setMore(!more)} aria-expanded={more}>{more ? "fewer filters ▴" : "all filters ▾"}</button>
          </span>
        </div>
        <div className={`pb grid ex-groups ${more ? "open" : ""}`} style={{ gap: 10 }}>
          <Group label="King">
            {["", "B", "W", "D"].map((v) => <Chip key={v} on={f.king === v} onClick={() => set({ king: v })}>{v ? VNAME[v] : "any"}</Chip>)}
            <span className="tiny muted" style={{ marginLeft: 10 }}>min score</span>
            <input type="range" min={0} max={100} step={5} value={f.min} onChange={(e) => set({ min: Number(e.target.value) })} style={{ accentColor: "var(--rat)", width: 120 }} />
            <span className="small green" style={{ width: 28 }}>{f.min}</span>
          </Group>
          <Group label="Nano">
            {["", "B", "W", "D"].map((v) => <Chip key={v} on={f.nano === v} onClick={() => set({ nano: v })}>{v ? VNAME[v] : "any"}</Chip>)}
            <Chip on={f.agree} onClick={() => set({ agree: !f.agree })}>King + nano agree</Chip>
          </Group>
          <Group label="Outcome">
            {[["", "any"], ["P", "pending"], ["B", "bonded"], ["A", "alive"], ["D", "died"]].map(([v, l]) => <Chip key={v} on={f.out === v} onClick={() => set({ out: v })}>{l}</Chip>)}
          </Group>
          <Group label="Dev">
            {[["", "any"], ["fresh", "fresh dev"], ["proven", "has bonded before"], ["noserial", "hide serial launchers"]].map(([v, l]) => <Chip key={v} on={f.dev === v} onClick={() => set({ dev: v })}>{l}</Chip>)}
            <span className="tiny muted" style={{ marginLeft: 10 }}>socials</span>
            {[[0, "any"], [1, "1+"], [3, "X + TG + web"]].map(([v, l]) => <Chip key={String(v)} on={f.soc === v} onClick={() => set({ soc: Number(v) })}>{l}</Chip>)}
          </Group>
          <Group label="Window">
            {[1, 6, 24].map((h) => <Chip key={h} on={f.win === h} onClick={() => set({ win: h })}>{h}h</Chip>)}
            <input className="input" style={{ width: 220, padding: "5px 10px", marginLeft: 10 }} placeholder="search ticker, name or CA" value={f.q} onChange={(e) => set({ q: e.target.value })} spellCheck={false} />
          </Group>
          <Group label="Sort">
            {[["new", "newest"], ["king", "King score"], ["nano", "nano score"], ["curve", "curve now"], ["peak", "peak"], ["fast", "fastest bond"]].map(([v, l]) => <Chip key={v} on={f.sort === v} onClick={() => set({ sort: v })}>{l}</Chip>)}
          </Group>
        </div>
      </section>

      <section className="grid g4 mt">
        <div className="panel"><div className="pb stat"><div className="k"><Info k="matching">Matching</Info></div><div className="big rat">{num(rows.length)}</div><div className="s">in the last {f.win}h</div></div></div>
        <div className="panel"><div className="pb stat"><div className="k"><Info k="bonded">Bonded</Info></div><div className="big" style={{ color: "var(--bond)" }}>{num(bonded)}</div><div className="s">{rows.length ? `${Math.round((bonded / rows.length) * 1000) / 10}% of matches so far` : "–"}</div></div></div>
        <div className="panel"><div className="pb stat"><div className="k"><Info k="died">Died</Info></div><div className="big" style={{ color: "var(--dust)" }}>{num(dead)}</div><div className="s">{num(settled - bonded - dead)} alive at 24h</div></div></div>
        <div className="panel"><div className="pb stat"><div className="k"><Info k="stilllive">Still live</Info></div><div className="big">{num(pending)}</div><div className="s">can still bond</div></div></div>
      </section>

      <section className="panel mt">
        <div className="ph">
          <span><Info k="t_coins"><b>coins</b></Info> · page {page + 1} / {pages}</span>
          <span className="row">
            <button className="btn dim" style={{ padding: "3px 10px" }} disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
            <button className="btn dim" style={{ padding: "3px 10px" }} disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>›</button>
          </span>
        </div>
        <div className="scroll">
          <table className="tbl">
            <thead>
              <tr><th>Coin</th><th>Age</th><th><Info k="king">King</Info></th><th><Info k="nano">Nano</Info></th><th><Info k="curveout">Curve / outcome</Info></th><th><Info k="mcap">Mcap</Info></th><th><Info k="v1">Vol 1h</Info></th><th><Info k="peakcurve">Peak</Info></th><th><Info k="dev">Dev</Info></th><th><Info k="socials">Socials</Info></th></tr>
            </thead>
            <tbody>
              {view.map((x) => (
                <tr key={x.m}>
                  <td><Link href={`/c/${x.m}`}>${x.s || "?"}</Link><TradeIcons ca={x.m} /> <span className="muted small">{x.n.slice(0, 16)}</span></td>
                  <td className="muted">{ago(x.t)}</td>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      <span style={{ width: 22 }}>{x.v}</span>
                      <ScoreBar s={x.v} v={VNAME[x.V] || "DUST"} w={40} />
                      <span className={`tag v-${VNAME[x.V]}`}>{VNAME[x.V]}</span>
                      {!x.c && <span className="tiny mute2">late</span>}
                    </span>
                  </td>
                  <td>{x.NV ? <span className="row" style={{ gap: 6 }}><span style={{ width: 22 }}>{x.ns}</span><span className={`tag v-${VNAME[x.NV]}`}>{VNAME[x.NV]}</span></span> : <span className="tiny mute2">learning</span>}</td>
                  <td>
                    {x.o ? (
                      <span>
                        <span className={`tag o-${ONAME[x.o]}`}>{ONAME[x.o]}</span>
                        {x.bs != null && <span className="tiny" style={{ color: "var(--bond)" }}> in {fmtSecs(x.bs)}</span>}
                      </span>
                    ) : x.cur != null ? (
                      <CurveBar p={x.cur} />
                    ) : (
                      <span className="tiny mute2">quiet</span>
                    )}
                  </td>
                  <td>
                    {usd(mkt[x.m]?.mc)}
                    {mkt[x.m]?.c1 != null && <span className="tiny" style={{ color: (mkt[x.m]!.c1 ?? 0) >= 0 ? "var(--rat)" : "var(--dust)" }}> {chg(mkt[x.m]!.c1)}</span>}
                  </td>
                  <td className="muted">{mkt[x.m] ? usd(mkt[x.m]!.v1) : "–"}</td>
                  <td className="muted">{x.pk != null ? `${x.pk}%` : "–"}</td>
                  <td className="tiny" style={{ color: x.dn >= 5 && x.db === 0 ? "var(--dust)" : x.db > 0 ? "var(--bond)" : x.dn === 0 ? "var(--rat)" : "var(--dim)" }}>{x.dn === 0 ? "fresh" : `${x.dn} / ${x.db} bonded`}</td>
                  <td className="muted tiny">{x.so ? "●".repeat(x.so) : "–"}</td>
                </tr>
              ))}
              {!view.length && (
                <tr><td colSpan={10} className="muted">{data ? "No coins match. Loosen a filter." : "Loading the index…"}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <p className="tiny muted mt">The index holds every coin the King or nano rated BOND or WATCH in the last 24 hours, plus every coin that bonded. DUST calls stay on the King page. Filters live in the URL, so any view can be shared.</p>
    </>
  );
}
