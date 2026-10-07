"use client";
import Info from "./Info";
import { ago } from "./fmt";

export type DeskNowData = {
  beatAt: number | null;
  running: boolean;
  today: { seen: number; passed: number; fails: { rule: string; n: number }[] };
  kingBond: number;
  nano: { n: number; min: number };
  early: { n: number; min: number; on: boolean };
  stalkOn: boolean;
  history: { phase: string; done: number; lessons: number; clock: number | null } | null;
  speed?: { call: Lat; early: Lat; flash: Lat; chain: Lat; fill: Lat } | null;
};
type Lat = { p50: number; n: number } | null;

type Check = { label: string; need: string; now: string; ok: boolean };

const RULE: Record<string, string> = {
  king_or_nano_bond: "not a BOND call",
  nano_agrees: "nano disagreed",
  curve_window: "curve outside the buy window",
  curve_not_late: "curve already late at the call",
  dev_not_serial: "serial dev with no graduations",
  dev_buy_sane: "dev bought too much",
  dev_not_selling: "dev already selling",
  bundle_ok: "too much bundled",
  cluster_ok: "dev's funder has a bad record",
  not_a_copycat: "copycat of a recent winner",
  not_a_farm: "farm (no organic buyers)",
  has_socials: "no X, website or Telegram",
  post_traction: "the post spawned no wave",
  mind_send: "MIND not convinced",
  independent_signal: "only MIND liked it",
  traction: "not enough volume or buyers",
  buy_pressure: "more sellers than buyers",
  holder_spread: "top 10 hold too much",
  liquidity_ok: "too little liquidity",
  holding_floor: "already dumped from its high",
  fresh_signal: "signal too old",
  open_slots: "all slots in use",
  daily_loss_ok: "daily loss limit",
};

function Bar({ v }: { v: number }) {
  return (
    <span className="dn-bar">
      <i style={{ width: `${Math.max(0, Math.min(100, v))}%` }} />
    </span>
  );
}

export default function DeskNow({ now, live, open, closed, exam }: { now: DeskNowData | null | undefined; live: boolean; open: number; closed: number; exam: Check[] }) {
  const passed = exam.filter((c) => c.ok).length;
  const step = live ? 3 : passed === exam.length && exam.length ? 2 : 1;
  const left = exam.filter((c) => !c.ok);
  const t = now?.today;

  let headline: string;
  let detail: string;
  if (!now) {
    headline = "Loading the desk…";
    detail = "";
  } else if (!now.running) {
    headline = "The desk is paused.";
    detail = now.beatAt ? `Last heartbeat ${ago(now.beatAt)} ago. It runs every minute when the scheduler pings it.` : "It starts on the first ping of the minute scheduler.";
  } else if (open > 0) {
    headline = `Holding ${open} ${live ? "" : "paper "}position${open > 1 ? "s" : ""}.`;
    detail = "Every position is re-checked twice a second (paid RPC) against its exits: initials, trail, insider dumps.";
  } else if (live) {
    headline = "Trading its own wallet. Waiting for the next clean BOND call.";
    detail = "It buys the moment a King call passes every check.";
  } else {
    headline = "Paper trading is on. Waiting for a clean BOND call.";
    detail = "The desk buys on paper the moment a King BOND call passes every safety check. Real prices, simulated fills.";
  }

  return (
    <section className="panel desk-now">
      <div className="ph">
        <span><Info k="exam"><b>right now</b></Info></span>
        <span className="tiny muted">{now?.running ? <><i className="dn-live" /> running · beat {now.beatAt ? ago(now.beatAt) : "–"} ago</> : "paused"}</span>
      </div>

      <ol className="dn-steps">
        {[
          ["Paper trading", live ? "done" : step === 1 ? `${closed} trade${closed === 1 ? "" : "s"} closed` : "done"],
          ["Exam", live ? "passed" : `${passed} of ${exam.length || 5} passed`],
          ["Own wallet", live ? "live" : "unlocks after the exam"],
        ].map(([label, sub], i) => {
          const n = i + 1;
          const cls = n < step ? "done" : n === step ? "on" : "";
          return (
            <li key={label} className={cls}>
              <span className="dn-n">{n < step ? "✓" : n}</span>
              <span>
                <b>{label}</b>
                <em>{sub}</em>
              </span>
            </li>
          );
        })}
      </ol>

      {now?.speed && (now.speed.flash || now.speed.call) ? (
        <div className="dn-speed tiny">
          <span className="muted">speed, after a launch is born:</span>
          {now.speed.flash ? <span>first read <b>{now.speed.flash.p50}s</b></span> : null}
          {now.speed.early ? <span>minute-1 read <b>{now.speed.early.p50}s</b></span> : null}
          {now.speed.call ? <span>King call <b>{now.speed.call.p50}s</b></span> : null}
          {now.speed.fill ? <span>signal to fill <b>{now.speed.fill.p50}s</b></span> : null}
        </div>
      ) : null}

      <div className="dn-grid">
        <div className="dn-main">
          <div className="dn-h">{headline}</div>
          {detail && <p className="dn-p">{detail}</p>}

          {!live && now && (now.running || now.today.seen > 0) && (
            <div className="dn-today">
              <div className="dn-k">Today</div>
              <div className="dn-line">
                <b>{t?.seen ?? 0}</b> signal{t?.seen === 1 ? "" : "s"} checked · <b>{t?.passed ?? 0}</b> passed
                {t && t.seen === 0 ? <span className="muted"> · BOND calls reach the desk within seconds of the minute-5 call</span> : null}
              </div>
              {!!t?.fails.length && (
                <div className="dn-fails">
                  {t.fails.map((f) => (
                    <span key={f.rule}>
                      {RULE[f.rule] || f.rule.replace(/_/g, " ")} <b>{f.n}</b>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="dn-next">
            <div className="dn-k">Next</div>
            {live ? (
              <p className="dn-p">Stays live while drawdown is under 40%. Past that it drops back to paper and re-takes the exam.</p>
            ) : (
              <p className="dn-p">
                Pass the exam, then it switches to its own wallet by itself.
                {left.length ? <> Still needed: {left.map((c, i) => <span key={c.label}>{i ? ", " : " "}<span className="dn-need">{c.label} {c.now} / {c.need}</span></span>)}.</> : null}
              </p>
            )}
          </div>
        </div>

        <div className="dn-side">
          <div className="dn-k"><Info k="learn">Learning in the background</Info></div>
          <div className="dn-row">
            <span><Info k="historian">Historian replay</Info></span>
            <span className="dn-v">{now?.history && now.history.phase !== "starting" ? (now.history.phase === "done" ? "done" : `${Math.round(now.history.done)}%`) : "starting"}</span>
            <Bar v={now?.history?.done ?? 0} />
          </div>
          <div className="dn-row">
            <span><Info k="nano">Nano model</Info></span>
            <span className="dn-v">{now ? (now.nano.n >= now.nano.min ? "calling" : `${now.nano.n} / ${now.nano.min} lessons`) : "–"}</span>
            <Bar v={now ? (now.nano.n / now.nano.min) * 100 : 0} />
          </div>
          <div className="dn-row">
            <span><Info k="early">Minute-1 entries</Info></span>
            <span className="dn-v">{now ? (now.early.on ? "unlocked" : `${now.early.n} / ${now.early.min} reads`) : "–"}</span>
            <Bar v={now ? (now.early.on ? 100 : (now.early.n / now.early.min) * 100) : 0} />
          </div>
          <div className="dn-row">
            <span><Info k="arms">Pullback entries</Info></span>
            <span className="dn-v">{now?.stalkOn ? "unlocked" : "proving in shadow"}</span>
            <Bar v={now?.stalkOn ? 100 : 0} />
          </div>
        </div>
      </div>
    </section>
  );
}
