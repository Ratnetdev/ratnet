// RATNET extension background: calls the RATNET check API (no page CORS involved) and caches answers for 90 seconds.
var API = "https://www.ratnet.network/api/check?ca=";
var CACHE = new Map();
var B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function check(ca) {
  var hit = CACHE.get(ca);
  if (hit && Date.now() - hit.at < 90000) return Promise.resolve(hit.v);
  return fetch(API + encodeURIComponent(ca), { headers: { "x-ratnet-client": "ext/" + chrome.runtime.getManifest().version } })
    .then(function (r) {
      return r.json().then(function (j) {
        var v = r.ok ? { report: j.report } : { error: j.error || "The rats could not read it (" + r.status + ")" };
        if (r.ok) {
          CACHE.set(ca, { at: Date.now(), v: v });
          if (CACHE.size > 300) CACHE.delete(CACHE.keys().next().value);
        }
        return v;
      });
    })
    .catch(function () {
      return { error: "RATNET did not answer. Try again in a minute." };
    });
}

chrome.runtime.onMessage.addListener(function (msg, _sender, reply) {
  if (!msg || msg.type !== "check" || !B58.test(String(msg.ca || ""))) return false;
  check(msg.ca).then(reply);
  return true; // async reply
});

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.create({ id: "ratcheck", title: "Check with the Rat King", contexts: ["selection"] });
});
chrome.contextMenus.onClicked.addListener(function (info) {
  var ca = String(info.selectionText || "").trim();
  if (info.menuItemId !== "ratcheck" || !B58.test(ca)) return;
  chrome.tabs.create({ url: "https://www.ratnet.network/sniff?ca=" + encodeURIComponent(ca) + "&go=1" });
});
