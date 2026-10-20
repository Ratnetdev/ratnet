// RATNET extension: one renderer for the page panel and the popup. Plain DOM: text from the network is only ever set as text.
var RAT = (function () {
  var C = { bg: "#060807", panel: "#0c110e", line: "#1d2a22", text: "#d8e6dc", dim: "#7d8c84", rat: "#8cff5a", bond: "#ffb547", watch: "#7fd1ff", dust: "#ff5c5c" };
  var SITE = "https://www.ratnet.network";
  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (text != null) e.textContent = String(text);
    return e;
  }
  function vcol(v) {
    return v === "BOND" || v === "BONDED" ? C.bond : v === "WATCH" ? C.watch : v === "DUST" ? C.dust : C.dim;
  }
  function css() {
    return "font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:" + C.text + ";";
  }
  /** A check report (from /api/check) as a DOM node. */
  function card(rep) {
    var root = el("div", css());
    var top = el("div", "display:flex;justify-content:space-between;align-items:flex-start;gap:10px");
    var left = el("div", "min-width:0");
    left.appendChild(el("div", "font-size:10px;letter-spacing:1px;color:" + C.dim, "RAT KING CHECK"));
    left.appendChild(el("div", "font-size:15px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", "$" + (rep.symbol || "?") + " "));
    left.lastChild.appendChild(el("span", "font-size:11px;color:" + C.dim, rep.name || ""));
    var right = el("div", "text-align:right");
    right.appendChild(el("div", "font-size:26px;line-height:1;color:" + vcol(rep.verdict), rep.score == null ? "-" : rep.score));
    right.appendChild(el("div", "font-size:10px;margin-top:3px;color:" + vcol(rep.verdict), rep.verdict || ""));
    top.appendChild(left);
    top.appendChild(right);
    root.appendChild(top);
    if (rep.read) root.appendChild(el("div", "margin-top:8px;font-size:13px;color:" + C.rat, "🐀 " + rep.read));
    var L = rep.live;
    var w = L && L.who;
    if (w) {
      var row = el("div", "display:flex;flex-wrap:wrap;gap:10px;margin-top:8px");
      [["FOMO", w.fomo, 0], ["earners", w.earners, 0], ["proven", w.proven, 0], ["front-run", w.front, 0], ["bots", w.bots, 1], ["buyers", w.buyersCapped ? "300+" : w.buyers, 2]].forEach(function (x) {
        var b = el("div", "min-width:44px");
        var n = Number(x[1]) || 0;
        var col = x[2] === 2 ? C.text : x[2] === 1 ? (n ? C.dust : C.dim) : n ? C.bond : C.dim;
        b.appendChild(el("div", "font-size:15px;color:" + col, x[1]));
        b.appendChild(el("div", "font-size:9.5px;color:" + C.dim, x[0]));
        row.appendChild(b);
      });
      root.appendChild(row);
    } else if (L) {
      root.appendChild(el("div", "margin-top:8px;color:" + C.dim, "No buys seen by the rats yet."));
    }
    var good = (rep.plus || []).concat((L && L.good) || []).slice(0, 4);
    var bad = (rep.minus || []).concat((L && L.bad) || []).slice(0, 4);
    var list = el("div", "margin-top:8px");
    bad.forEach(function (x) { list.appendChild(el("div", "color:" + C.dust, "− " + x)); });
    good.forEach(function (x) { list.appendChild(el("div", "color:" + C.rat, "+ " + x)); });
    root.appendChild(list);
    var foot = el("div", "display:flex;justify-content:space-between;gap:8px;margin-top:10px;font-size:11px");
    var a1 = el("a", "color:" + C.bond + ";text-decoration:none", "Ask the Rat King ›");
    a1.href = SITE + "/sniff?ca=" + encodeURIComponent(rep.ca) + "&go=1";
    a1.target = "_blank";
    a1.rel = "noopener";
    var a2 = el("a", "color:" + C.dim + ";text-decoration:none", "ratnet.network");
    a2.href = SITE + "/c/" + encodeURIComponent(rep.ca);
    a2.target = "_blank";
    a2.rel = "noopener";
    foot.appendChild(a1);
    foot.appendChild(a2);
    root.appendChild(foot);
    root.appendChild(el("div", "margin-top:6px;font-size:9.5px;color:" + C.dim, "Not financial advice."));
    return root;
  }
  function note(text, color) {
    return el("div", css() + "color:" + (color || C.dim), text);
  }
  /** Ask the background for a check (it calls the API and caches). */
  function check(ca, cb) {
    try {
      chrome.runtime.sendMessage({ type: "check", ca: ca }, function (res) {
        if (chrome.runtime.lastError) return cb({ error: "The extension reloaded: refresh the page." });
        cb(res || { error: "No answer" });
      });
    } catch (e) {
      cb({ error: "The extension reloaded: refresh the page." });
    }
  }
  var B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return { C: C, SITE: SITE, el: el, card: card, note: note, check: check, B58: B58 };
})();
