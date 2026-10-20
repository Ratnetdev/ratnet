// RATNET extension on coin pages: finds the coin's mint, asks the Rat King, shows a small panel (bottom right).
// The panel lives in a shadow root so the site's styles never touch it. It can be folded to a pill or closed per tab.
(function () {
  var B58 = RAT.B58;
  var host = location.hostname;
  function fromUrl() {
    var segs = location.pathname.split("/").filter(Boolean);
    // pump.fun/coin/<mint>, gmgn.ai/sol/token/<prefix_><mint>
    for (var i = segs.length - 1; i >= 0; i--) {
      var s = decodeURIComponent(segs[i]);
      if (s.indexOf("_") > 0) s = s.split("_").pop();
      if (B58.test(s) && /pump$|bonk$|moon$/.test(s)) return s;
    }
    if (/pump\.fun$/.test(host) || /gmgn\.ai$/.test(host)) {
      for (var j = segs.length - 1; j >= 0; j--) {
        var t = decodeURIComponent(segs[j]);
        if (t.indexOf("_") > 0) t = t.split("_").pop();
        if (B58.test(t)) return t;
      }
    }
    return null;
  }
  // terminals (Axiom, Photon, BullX, DexScreener) put the pair in the URL: the mint is in their token links
  function fromPage() {
    var links = document.querySelectorAll('a[href*="solscan.io/token/"],a[href*="pump.fun/coin/"],a[href*="gmgn.ai/sol/token/"],a[href*="birdeye.so/token/"],a[href*="explorer.solana.com/address/"]');
    for (var i = 0; i < links.length; i++) {
      var m = /(?:token|coin|address)\/(?:[a-z]+_)?([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(links[i].getAttribute("href") || "");
      if (m && m[1] !== "So11111111111111111111111111111111111111112") return m[1];
    }
    var txt = (document.body && document.body.innerText) || "";
    var p = /\b([1-9A-HJ-NP-Za-km-z]{32,40}pump)\b/.exec(txt);
    return p ? p[1] : null;
  }
  function mintNow() {
    return fromUrl() || (/pump\.fun$/.test(host) ? null : fromPage());
  }

  var box = null, body = null, folded = false, closed = {}, cur = null, seq = 0;
  function mount() {
    if (box) return;
    var hostEl = document.createElement("div");
    hostEl.id = "ratnet-king";
    hostEl.setAttribute("style", "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483646");
    var root = hostEl.attachShadow({ mode: "closed" });
    box = RAT.el("div", "width:290px;max-width:calc(100vw - 32px);background:" + RAT.C.panel + ";border:1px solid " + RAT.C.line + ";border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden");
    var head = RAT.el("div", "display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:" + RAT.C.bg + ";border-bottom:1px solid " + RAT.C.line + ";cursor:pointer;font:11px ui-monospace,Menlo,monospace;color:" + RAT.C.rat + ";letter-spacing:1px");
    var title = RAT.el("span", "", "🐀 RATNET");
    var btns = RAT.el("span", "display:flex;gap:10px");
    var fold = RAT.el("span", "color:" + RAT.C.dim, "–");
    var x = RAT.el("span", "color:" + RAT.C.dim, "×");
    btns.appendChild(fold);
    btns.appendChild(x);
    head.appendChild(title);
    head.appendChild(btns);
    body = RAT.el("div", "padding:10px 12px;max-height:60vh;overflow:auto");
    box.appendChild(head);
    box.appendChild(body);
    root.appendChild(box);
    document.documentElement.appendChild(hostEl);
    head.addEventListener("click", function (e) {
      if (e.target === x) {
        if (cur) closed[cur] = true;
        hostEl.style.display = "none";
        return;
      }
      folded = !folded;
      body.style.display = folded ? "none" : "block";
      fold.textContent = folded ? "+" : "–";
    });
    box._host = hostEl;
    box._title = title;
  }
  function show(node) {
    while (body.firstChild) body.removeChild(body.firstChild);
    body.appendChild(node);
  }
  function run(ca) {
    cur = ca;
    if (closed[ca]) return;
    mount();
    box._host.style.display = "block";
    box._title.textContent = "🐀 RATNET";
    show(RAT.note("The rats are reading this coin…"));
    var my = ++seq;
    RAT.check(ca, function (res) {
      if (my !== seq) return;
      if (res.error) return show(RAT.note(res.error, RAT.C.dust));
      var r = res.report;
      box._title.textContent = "🐀 $" + (r.symbol || "?") + " · " + (r.score == null ? "-" : r.score) + " " + (r.verdict || "");
      show(RAT.card(r));
    });
  }
  var last = "";
  function tick() {
    if (location.href === last && cur) return;
    var m = mintNow();
    if (!m) return;
    last = location.href;
    if (m !== cur) run(m);
  }
  setInterval(tick, 1500);
  tick();
})();
