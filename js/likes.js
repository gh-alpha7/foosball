/* Like button shared by the portfolio's projects.
 *
 * Counts live in Abacus (a free, no-signup counter API) under the same namespace and
 * keys the portfolio uses, so a project's count is identical on the portfolio and on
 * the project itself. All the sites share the gh-alpha7.github.io origin, so a like
 * given in one place is remembered in the others too.
 *
 * Usage:
 *   <button class="lk-like" data-like-key="project-foosball" data-like-name="Foosball Party"></button>
 * or a floating button, from the script tag itself:
 *   <script src="likes.js" data-float-key="project-chess-video" data-float-name="chess-video"></script>
 */
(function () {
  "use strict";

  var API = "https://abacus.jasoncameron.dev";
  var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var NS = local ? "gh-alpha7-portfolio-dev" : "gh-alpha7-portfolio";
  var HEART = "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z";
  var script = document.currentScript;
  var compact = window.Intl && Intl.NumberFormat ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }) : null;
  var groups = {};   // key -> { buttons, name, count, liked, busy }

  var CSS =
    ".lk-like{--lk-heart:#ff3d7f;--lk-heart-2:#ff8a4c;display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px 0 10px;" +
    "border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(16,20,24,.82);color:#c9d1d9;cursor:pointer;" +
    "font:600 14px/1 system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);" +
    "transition:border-color .2s,color .2s,background .2s,box-shadow .2s}" +
    ".lk-like:hover{color:#fff;border-color:rgba(255,61,127,.5)}" +
    ".lk-like[aria-pressed=true]{color:#ffd1e0;border-color:rgba(255,61,127,.55);background:linear-gradient(135deg,rgba(255,61,127,.22),rgba(255,138,76,.14)),rgba(16,20,24,.85);box-shadow:0 0 24px -8px rgba(255,61,127,.6)}" +
    ".lk-icon{position:relative;display:grid;place-items:center;width:20px;height:20px}" +
    ".lk-heart{width:20px;height:20px;overflow:visible;fill:transparent;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:fill .2s,stroke .2s,transform .25s cubic-bezier(.3,1.6,.5,1)}" +
    ".lk-like:hover .lk-heart{stroke:var(--lk-heart);transform:scale(1.12)}" +
    ".lk-like[aria-pressed=true] .lk-heart{fill:url(#lk-grad);stroke:url(#lk-grad)}" +
    ".lk-like.lk-pop .lk-heart{animation:lk-pop .5s cubic-bezier(.2,1.8,.4,1)}" +
    ".lk-icon::after{content:'';position:absolute;inset:-4px;border-radius:50%;border:2px solid var(--lk-heart);opacity:0;transform:scale(.3);pointer-events:none}" +
    ".lk-like.lk-burst .lk-icon::after{animation:lk-ring .5s ease-out}" +
    ".lk-dots{position:absolute;inset:0;pointer-events:none}" +
    ".lk-dots i{position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:50%;background:var(--lk-heart);opacity:0;transform:rotate(var(--a)) translateY(0)}" +
    ".lk-dots i:nth-child(even){background:var(--lk-heart-2);width:3px;height:3px}" +
    ".lk-like.lk-burst .lk-dots i{animation:lk-dot .6s ease-out forwards}" +
    ".lk-count{display:inline-grid;overflow:hidden;height:1.25em;line-height:1.25em;min-width:1ch;font-variant-numeric:tabular-nums}" +
    ".lk-num{grid-area:1/1}" +
    ".lk-num.lk-in{animation:lk-in .35s cubic-bezier(.2,.9,.3,1)}.lk-num.lk-out{animation:lk-out .35s cubic-bezier(.2,.9,.3,1) forwards}" +
    ".lk-count.lk-loading .lk-num{width:2.2ch;height:.8em;margin-top:.22em;border-radius:4px;color:transparent;background:linear-gradient(90deg,#2a3038,#3a424c,#2a3038) 0 0/200% 100%;animation:lk-shim 1.2s linear infinite}" +
    ".lk-float{position:fixed;z-index:2147483000;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px}" +
    "@media (max-width:720px){.lk-float{top:auto;left:auto;right:14px;bottom:14px;transform:none}}" +
    ".lk-home{display:inline-flex;align-items:center;gap:4px;height:36px;padding:0 14px 0 8px;border-radius:999px;" +
    "border:1px solid rgba(255,255,255,.14);background:rgba(16,20,24,.82);color:#c9d1d9;text-decoration:none;" +
    "font:600 14px/1 system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);transition:border-color .2s,color .2s}" +
    ".lk-home:hover,.lk-home:focus-visible{color:#fff;border-color:rgba(8,253,216,.6)}" +
    ".lk-home svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}" +
    "@keyframes lk-pop{0%{transform:scale(.4)}55%{transform:scale(1.3)}100%{transform:scale(1)}}" +
    "@keyframes lk-ring{0%{opacity:.9;transform:scale(.3)}100%{opacity:0;transform:scale(1.5);border-width:0}}" +
    "@keyframes lk-dot{0%{opacity:1;transform:rotate(var(--a)) translateY(0) scale(1)}100%{opacity:0;transform:rotate(var(--a)) translateY(-17px) scale(.4)}}" +
    "@keyframes lk-in{from{transform:translateY(100%);opacity:0}to{transform:none;opacity:1}}" +
    "@keyframes lk-out{to{transform:translateY(-100%);opacity:0}}" +
    "@keyframes lk-shim{to{background-position:-200% 0}}" +
    "@media (prefers-reduced-motion:reduce){.lk-like.lk-pop .lk-heart,.lk-like.lk-burst .lk-icon::after,.lk-like.lk-burst .lk-dots i,.lk-num.lk-in,.lk-num.lk-out{animation:none}.lk-num.lk-out{display:none}}";

  function init() {
    if (!document.getElementById("lk-style")) {
      var style = document.createElement("style");
      style.id = "lk-style";
      style.textContent = CSS;
      document.head.appendChild(style);
      document.body.insertAdjacentHTML("beforeend",
        '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
        '<linearGradient id="lk-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff3d7f"/><stop offset="1" stop-color="#ff8a4c"/></linearGradient>' +
        "</defs></svg>");
    }
    if (script && script.dataset.floatKey && !document.querySelector(".lk-float")) {
      var wrap = document.createElement("div");
      wrap.className = "lk-float";
      if (script.dataset.portfolio !== "off") wrap.innerHTML = portfolioLink();
      var f = document.createElement("button");
      f.className = "lk-like";
      f.dataset.likeKey = script.dataset.floatKey;
      f.dataset.likeName = script.dataset.floatName || "this project";
      wrap.appendChild(f);
      document.body.appendChild(wrap);
    }
    // any <a class="lk-home"></a> placeholder gets the portfolio link contents
    Array.prototype.forEach.call(document.querySelectorAll("a.lk-home:empty"), function (a) {
      a.outerHTML = portfolioLink();
    });
    scan();
  }

  var PORTFOLIO = "https://gh-alpha7.github.io/portfolio/#projects";
  function portfolioLink() {
    return '<a class="lk-home" href="' + PORTFOLIO + '" title="More projects by Subham">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>Portfolio</a>';
  }

  // Wire up any buttons not seen yet (safe to call again after the page changes).
  function scan() {
    var dots = "";
    for (var d = 0; d < 8; d++) dots += '<i style="--a:' + (d * 45) + 'deg"></i>';
    var fresh = [];
    Array.prototype.forEach.call(document.querySelectorAll(".lk-like[data-like-key]"), function (btn) {
      if (btn.dataset.lkReady) return;
      btn.dataset.lkReady = "1";
      btn.type = "button";
      btn.innerHTML =
        '<span class="lk-icon" aria-hidden="true"><svg class="lk-heart" viewBox="0 0 24 24"><path d="' + HEART + '"/></svg>' +
        '<span class="lk-dots">' + dots + "</span></span>" +
        '<span class="lk-count lk-loading" aria-hidden="true"><span class="lk-num">0</span></span>';
      var key = btn.dataset.likeKey;
      var isNew = !groups[key];
      if (isNew) groups[key] = { buttons: [], name: btn.dataset.likeName || "this", count: null, liked: read(key), busy: false };
      groups[key].buttons.push(btn);
      btn.addEventListener("click", function () { like(key, btn); });
      if (isNew) fresh.push(key); else render(key, null);
    });
    fresh.forEach(function (key) {
      render(key, null);
      request("get", key).then(function (data) { groups[key].count = data.value; })
        .catch(function () { groups[key].count = 0; })
        .then(function () { render(key, null); });
    });
  }

  function read(key) { try { return localStorage.getItem("liked:" + key) === "1"; } catch (e) { return false; } }
  function remember(key) { try { localStorage.setItem("liked:" + key, "1"); } catch (e) { /* private mode */ } }
  function fmt(n) { return compact ? compact.format(n) : String(n); }

  function request(action, key) {
    return fetch(API + "/" + action + "/" + NS + "/" + key, { cache: "no-store" }).then(function (res) {
      if (res.status === 404) return { value: 0 };   // counter not created until the first like
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function setCount(btn, n, prev) {
    var box = btn.querySelector(".lk-count");
    var text = n == null ? "0" : fmt(n);
    box.classList.toggle("lk-loading", n == null);
    var cur = box.querySelector(".lk-num:not(.lk-out)");
    if (cur && cur.textContent === text) return;
    if (!cur || prev == null || n == null) { box.innerHTML = '<span class="lk-num">' + text + "</span>"; return; }
    var next = document.createElement("span");
    next.className = "lk-num lk-in";
    next.textContent = text;
    cur.className = "lk-num lk-out";
    box.appendChild(next);
    setTimeout(function () { if (cur.parentNode) cur.parentNode.removeChild(cur); }, 400);
  }

  function render(key, prev) {
    var g = groups[key];
    g.buttons.forEach(function (btn) {
      setCount(btn, g.count, prev);
      btn.setAttribute("aria-pressed", g.liked ? "true" : "false");
      var total = g.count == null ? "" : ", " + g.count + (g.count === 1 ? " like" : " likes");
      btn.setAttribute("aria-label", (g.liked ? "You liked " : "Like ") + g.name + total);
      btn.title = g.liked ? "Thanks for the love!" : "Like " + g.name;
    });
  }

  function animate(btn, cls) { btn.classList.remove(cls); void btn.offsetWidth; btn.classList.add(cls); }

  function like(key, btn) {
    var g = groups[key];
    animate(btn, "lk-pop");
    if (g.liked || g.busy) return;   // one like per browser; the API can't safely un-like
    g.busy = true;
    g.liked = true;
    var prev = g.count || 0;
    g.count = prev + 1;
    render(key, prev);
    g.buttons.forEach(function (b) { animate(b, "lk-burst"); });
    request("hit", key).then(function (data) {
      var shown = g.count; g.count = data.value; remember(key); render(key, shown);
    }).catch(function () {
      var shown = g.count; g.liked = false; g.count = Math.max(0, shown - 1); render(key, shown);
    }).then(function () { g.busy = false; });
  }

  window.ProjectLikes = { scan: scan };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
