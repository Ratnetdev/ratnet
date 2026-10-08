"use client";
// Right-aligns every numeric column in every table on the page (v0.1.38), so digits line up whatever component drew
// the table. A column counts as numeric when most of its cells start with a number, a money amount, a percent or a
// multiple ("$12.4K", "+3.2%", "1.8x", "0.050 ◎", "4m"). Runs when rows change, at most every 400ms.
import { useEffect } from "react";

const NUM = /^[+\-−]?[$◎]?\s?[\d.,]+\s?([KMBk%x]|◎|SOL|s|m|h|d)?(\s?◎)?$/;

/** The cell's first piece of text (no layout read: innerText would force a reflow on every pass). */
function firstText(el: Element) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let txt = "";
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const v = (n.textContent || "").trim();
    if (!v) continue;
    // "$12.4K" can be split over two text nodes by React ("$", "12.4K"): join the first run
    txt += v;
    if (txt.length > 1 || !/^[$◎+\-−]$/.test(txt)) break;
  }
  return txt;
}

function alignTable(t: HTMLTableElement) {
  const rows = Array.from(t.tBodies[0]?.rows || []);
  if (!rows.length) return;
  const cols = Math.max(...rows.map((r) => r.cells.length));
  for (let c = 1; c < cols; c++) {
    let n = 0;
    let num = 0;
    for (const r of rows) {
      const cell = r.cells[c];
      if (!cell || cell.colSpan > 1) continue;
      const first = firstText(cell);
      if (!first || first === "–" || first === "-") continue;
      n++;
      if (NUM.test(first)) num++;
    }
    const isNum = n >= 2 && num / n >= 0.7;
    for (const r of [...Array.from(t.tHead?.rows || []), ...rows]) {
      const cell = r.cells[c];
      if (cell && cell.colSpan === 1) cell.classList.toggle("num", isNum);
    }
  }
}

export default function AlignNumbers() {
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      t = null;
      document.querySelectorAll<HTMLTableElement>("table.tbl").forEach(alignTable);
    };
    const mo = new MutationObserver(() => {
      if (!t) t = setTimeout(run, 400);
    });
    // rows coming and going is what changes a column's type; text ticking inside a cell does not
    mo.observe(document.body, { childList: true, subtree: true });
    run();
    return () => {
      mo.disconnect();
      if (t) clearTimeout(t);
    };
  }, []);
  return null;
}
