(function () {
  var ca = document.getElementById("ca");
  var go = document.getElementById("go");
  var out = document.getElementById("out");
  function show(n) {
    while (out.firstChild) out.removeChild(out.firstChild);
    out.appendChild(n);
  }
  function run() {
    var v = ca.value.trim();
    if (!RAT.B58.test(v)) return show(RAT.note("That is not a Solana token address.", RAT.C.dust));
    go.disabled = true;
    show(RAT.note("The rats are reading this coin…"));
    try { chrome.storage.local.set({ last: v }); } catch (e) {}
    RAT.check(v, function (res) {
      go.disabled = false;
      if (res.error) return show(RAT.note(res.error, RAT.C.dust));
      show(RAT.card(res.report));
    });
  }
  go.addEventListener("click", run);
  ca.addEventListener("keydown", function (e) { if (e.key === "Enter") run(); });
  try {
    chrome.storage.local.get("last", function (d) { if (d && d.last && !ca.value) ca.value = d.last; });
  } catch (e) {}
  ca.focus();
})();
