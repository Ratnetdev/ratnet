import Link from "next/link";
import LiveBoard from "@/components/LiveBoard";
import { SITE } from "@/config/site";

export default function Home() {
  return (
    <>
      <section className="hero">
        <div className="prompt">
          root@ratnet:~$ <span>./dig --source pump.fun --forever</span>
          <span className="caret" />
        </div>
        <h1>
          THE MODEL RAISED
          <br />
          IN THE TRENCHES
        </h1>
        <p>
          {SITE.tagline} {SITE.sub} Every pump.fun launch, dug live. Every Rat King call, logged and checked. The hit rate is
          public from hour one.
        </p>
      </section>

      <LiveBoard />

      <section className="grid g3 mt2">
        {[
          ["01 / DIG", "Rats dig every new pump.fun launch: name, ticker, description, socials, curve at birth, at 5 minutes, at 1 hour, and the outcome at 24h."],
          ["02 / CALL", "The Rat King scores each launch 0 to 100 on one question: will it bond? Calls are made 5 minutes in, logged, then checked against the chain."],
          ["03 / TRAIN", "The dug dataset trains the Rat King v1 from scratch. Weights go public on Hugging Face after the first epoch. Rat owners earn while it grows."],
        ].map(([h, p]) => (
          <div className="panel" key={h}>
            <div className="pb">
              <div className="crt green" style={{ fontSize: 24 }}>{h}</div>
              <p className="muted small" style={{ margin: "6px 0 0" }}>{p}</p>
            </div>
          </div>
        ))}
      </section>

      <section className="row mt2 wrapx" style={{ gap: 12 }}>
        <Link href="/king" className="btn">See every call</Link>
        <Link href="/dataset" className="btn dim">The dataset</Link>
        <Link href="/docs" className="btn dim">Read the docs</Link>
      </section>
    </>
  );
}
