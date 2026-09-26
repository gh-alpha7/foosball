/* Picks a view: ?join=CODE -> phone controller, ?watch=CODE -> spectator, #host -> big screen, otherwise home. */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var join = FB.cleanCode(params.get("join"));
  var watch = FB.cleanCode(params.get("watch"));

  if (join.length === 4) { Controller.start(join); return; }
  if (watch.length === 4) { Spectator.start(watch); return; }
  if (location.hash === "#host") { Host.start(); return; }

  document.getElementById("view-home").hidden = false;

  document.getElementById("btn-host").addEventListener("click", function () {
    history.replaceState(null, "", location.pathname + "#host");
    document.getElementById("view-home").hidden = true;
    Host.start();
  });

  var input = document.getElementById("join-code");
  input.addEventListener("input", function () { input.value = FB.cleanCode(input.value); });
  function go(param) {
    var c = FB.cleanCode(input.value);
    if (c.length !== 4) { input.focus(); return; }
    location.search = "?" + param + "=" + c;
  }
  document.getElementById("join-form").addEventListener("submit", function (e) { e.preventDefault(); go("join"); });
  document.getElementById("btn-watch").addEventListener("click", function () { go("watch"); });
})();
