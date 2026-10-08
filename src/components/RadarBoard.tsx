"use client";
import { useState } from "react";
import { usePoll } from "./usePoll";
import RadarTable, { RadarRow } from "./Radar";

export default function RadarBoard() {
  const { data, error } = usePoll<{ radar: RadarRow[] }>("/api/radar", 5000);
  const [min, setMin] = useState(0);
  const [called, setCalled] = useState(false);
  const [fresh, setFresh] = useState(false);
  const rows = (data?.radar || []).filter(
    (r) => r.pNow >= min && (!called || r.call?.verdict === "BOND" || r.call?.verdict === "WATCH") && (!fresh || r.devN === 0)
  );
  return (
    <div className="panel glow">
      <div className="ph wrapx" style={{ gap: 12 }}>
        <span className="row" style={{ gap: 6 }}>
          <span className={`dot ${error ? "off" : ""}`} /> <b>radar</b> · {rows.length} coins · refresh 3s
        </span>
        <span className="row wrapx" style={{ gap: 6 }}>
          {[0, 20, 50, 80].map((m) => (
            <button key={m} className={`btn ${min === m ? "" : "dim"}`} style={{ padding: "3px 10px" }} onClick={() => setMin(m)}>
              {m ? `${m}%+` : "all"}
            </button>
          ))}
          <button className={`btn ${called ? "" : "dim"}`} style={{ padding: "3px 10px" }} onClick={() => setCalled(!called)}>
            king likes
          </button>
          <button className={`btn ${fresh ? "" : "dim"}`} style={{ padding: "3px 10px" }} onClick={() => setFresh(!fresh)}>
            fresh devs
          </button>
        </span>
      </div>
      <RadarTable rows={rows} full />
    </div>
  );
}
