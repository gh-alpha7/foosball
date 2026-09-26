/* Phone controller: joins a room, picks a team, then slides and kicks. */
var Controller = (function () {
  "use strict";

  var code, pid, name, team = null;
  var peer, conn, retry = 0, retryTimer = null, welcomed = false;
  var el = {};
  var pos = 0.5, lastSend = 0, sendTimer = null;
  var wakeLock = null;

  function start(roomCode) {
    code = FB.cleanCode(roomCode);
    // per tab, so a reload reconnects as the same player but two tabs are two players
    try { pid = sessionStorage.getItem("fb-pid"); } catch (e) { pid = null; }
    if (!pid) {
      pid = FB.uid();
      try { sessionStorage.setItem("fb-pid", pid); } catch (e) { /* ignore */ }
    }
    name = FB.store("fb-name") || "";
    var savedTeam = FB.store("fb-team-" + code);
    if (savedTeam === "red" || savedTeam === "blue") team = savedTeam;

    el = {
      view: document.getElementById("view-pad"),
      join: document.getElementById("pad-join"),
      pad: document.getElementById("pad"),
      room: document.getElementById("pad-room"),
      name: document.getElementById("pad-name"),
      status: document.getElementById("pad-status"),
      countRed: document.getElementById("count-red"),
      countBlue: document.getElementById("count-blue"),
      teamLabel: document.getElementById("pad-team"),
      rods: document.getElementById("pad-rods"),
      scoreRed: document.getElementById("pad-score-red"),
      scoreBlue: document.getElementById("pad-score-blue"),
      slider: document.getElementById("slider"),
      track: document.querySelector("#slider .slider-track"),
      thumb: document.getElementById("slider-thumb"),
      kick: document.getElementById("kick"),
      msg: document.getElementById("pad-msg")
    };
    el.view.hidden = false;
    el.room.textContent = code;
    el.name.value = name;
    document.title = "Foosball Party · " + code;

    el.name.addEventListener("input", function () {
      name = el.name.value.trim().slice(0, 12);
      FB.store("fb-name", name);
    });
    el.name.addEventListener("change", function () {
      send({ t: "name", name: name });
      if (team) el.teamLabel.textContent = teamLabel();
    });

    document.querySelectorAll(".team-btn").forEach(function (b) {
      b.addEventListener("click", function () { pickTeam(b.dataset.team); });
    });
    document.getElementById("pad-switch").addEventListener("click", function () {
      el.pad.hidden = true;
      el.join.hidden = false;
    });

    bindSlider();
    bindKick();
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        if (!el.pad.hidden) keepAwake();
        if (!conn || !conn.open) reconnect(true);
      }
    });

    // heartbeat both ways: the host drops silent phones, and we reconnect to a silent host
    setInterval(function () {
      if (!conn || !conn.open) return;
      send({ t: "ping" });
      if (welcomed && performance.now() - lastHost > 6500) {
        try { conn.close(); } catch (e) { /* ignore */ }
        lost();
      }
    }, 1000);
    window.addEventListener("pagehide", function () { send({ t: "bye" }); });

    connect();
  }

  var lastHost = 0;

  /* ---------- networking ---------- */
  function connect() {
    setStatus("", "connecting to table…");
    if (peer && !peer.destroyed) peer.destroy();
    peer = new Peer(FB.peerOptions());
    peer.on("open", function () {
      var c = peer.connect(FB.PEER_PREFIX + code, { reliable: true, serialization: "json" });
      conn = c;
      c.on("open", function () {
        retry = 0;
        lastHost = performance.now();
        send({ t: "hello", name: name || "Player", team: team });
      });
      c.on("data", function (msg) { lastHost = performance.now(); onMessage(msg); });
      c.on("close", function () { if (c === conn) lost(); });
      c.on("error", function () { if (c === conn) lost(); });
    });
    peer.on("error", function (err) {
      if (err.type === "peer-unavailable") {
        setStatus("err", "No table with code " + code + ". Check the code on the big screen.");
        scheduleRetry(4000);
      } else if (err.type === "network" || err.type === "server-error" || err.type === "socket-error") {
        setStatus("err", "Can't reach the game server. Check your connection.");
        scheduleRetry();
      } else {
        console.warn("peer error", err.type, err);
      }
    });
    peer.on("disconnected", function () { if (!peer.destroyed) peer.reconnect(); });
  }

  function lost() {
    welcomed = false;
    setStatus("err", "Connection lost, reconnecting…");
    showMsg("Reconnecting…");
    scheduleRetry();
  }

  function scheduleRetry(ms) {
    clearTimeout(retryTimer);
    retry++;
    retryTimer = setTimeout(function () { reconnect(false); }, ms || Math.min(8000, 600 * retry));
  }

  function reconnect(now) {
    clearTimeout(retryTimer);
    if (conn && conn.open) return;
    if (now) retry = 0;
    connect();
  }

  function send(msg) {
    if (!conn || !conn.open) return;
    msg.pid = pid;
    try { conn.send(msg); } catch (e) { /* ignore */ }
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.t) {
      case "welcome":
        welcomed = true;
        setStatus("ok", "Connected. Pick a team.");
        if (team) showPad();
        showMsg("");
        break;
      case "lobby":
        el.countRed.textContent = plural(msg.red.length);
        el.countBlue.textContent = plural(msg.blue.length);
        break;
      case "you":
        if (msg.team) {
          team = msg.team;
          el.pad.className = "pad " + team;
          el.teamLabel.textContent = teamLabel();
          el.rods.textContent = FB.describeRoles(msg.roles);
        }
        break;
      case "score":
        el.scoreRed.textContent = msg.red;
        el.scoreBlue.textContent = msg.blue;
        if (msg.phase === "lobby" && !el.msg.dataset.sticky) showMsg("Warm-up. Waiting for the host to start");
        break;
      case "event":
        onEvent(msg);
        break;
    }
  }

  function onEvent(msg) {
    var mine = msg.team === team;
    if (msg.kind === "hit") { FB.buzz(18); return; }
    if (msg.kind === "start") { showMsg("Kick-off!"); FB.buzz([40, 60, 40]); return; }
    if (msg.kind === "goal") {
      showMsg(mine ? "GOAL! Nice one 🎉" : "Conceded. Shake it off");
      FB.buzz(mine ? [80, 60, 80, 60, 160] : 250);
      return;
    }
    if (msg.kind === "win") {
      showMsg(mine ? "You win! 🏆" : "They win this one");
      FB.buzz(mine ? [100, 80, 100, 80, 300] : 400);
    }
  }

  function teamLabel() { return (team === "red" ? "Red" : "Blue") + (name ? " · " + name : ""); }

  function plural(n) { return n + (n === 1 ? " player" : " players"); }

  function setStatus(cls, text) {
    el.status.className = "pad-status " + cls;
    el.status.innerHTML = '<span class="dot"></span> ' + FB.escapeHtml(text);
  }

  var msgTimer = null;
  function showMsg(text) {
    clearTimeout(msgTimer);
    el.msg.textContent = text;
    if (text) msgTimer = setTimeout(function () { el.msg.textContent = ""; }, 3500);
  }

  /* ---------- team + pad ---------- */
  function pickTeam(t) {
    team = t;
    FB.store("fb-team-" + code, t);
    if (!name) { name = "Player"; }
    send({ t: "name", name: name });   // no-op until connected; hello carries the team then
    send({ t: "team", team: t });
    showPad();
  }

  function showPad() {
    el.join.hidden = true;
    el.pad.hidden = false;
    el.pad.className = "pad " + (team || "red");
    placeThumb();
    keepAwake();
  }

  function keepAwake() {
    if (!("wakeLock" in navigator) || wakeLock) return;
    navigator.wakeLock.request("screen").then(function (l) {
      wakeLock = l;
      l.addEventListener("release", function () { wakeLock = null; });
    }).catch(function () { /* not allowed right now */ });
  }

  function bindSlider() {
    var active = null;
    function update(e) {
      var r = el.track.getBoundingClientRect();
      var th = el.thumb.offsetHeight;
      var p = (e.clientY - r.top - th / 2) / (r.height - th);
      pos = Math.max(0, Math.min(1, p));
      placeThumb();
      sendPos();
    }
    el.slider.addEventListener("pointerdown", function (e) {
      active = e.pointerId;
      el.slider.setPointerCapture(e.pointerId);
      el.slider.classList.add("active");
      update(e);
      e.preventDefault();
    });
    el.slider.addEventListener("pointermove", function (e) { if (e.pointerId === active) update(e); });
    function end(e) {
      if (e.pointerId !== active) return;
      active = null;
      el.slider.classList.remove("active");
    }
    el.slider.addEventListener("pointerup", end);
    el.slider.addEventListener("pointercancel", end);
    window.addEventListener("resize", placeThumb);
  }

  function placeThumb() {
    var r = el.track.getBoundingClientRect();
    var th = el.thumb.offsetHeight;
    var y = pos * (r.height - th) - (r.height - th) / 2;
    el.thumb.style.transform = "translateY(" + y + "px)";
  }

  // ~40 updates a second at most, always ending on the latest position
  function sendPos() {
    var now = performance.now();
    clearTimeout(sendTimer);
    if (now - lastSend >= 25) {
      lastSend = now;
      send({ t: "in", p: Math.round(pos * 1000) / 1000 });
    } else {
      sendTimer = setTimeout(sendPos, 25 - (now - lastSend));
    }
  }

  function bindKick() {
    el.kick.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      send({ t: "kick" });
      FB.buzz(12);
      el.kick.classList.remove("down");
      void el.kick.offsetWidth;
      el.kick.classList.add("down");
    });
    function up() { setTimeout(function () { el.kick.classList.remove("down"); }, 90); }
    el.kick.addEventListener("pointerup", up);
    el.kick.addEventListener("pointercancel", up);
    el.kick.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  }

  return { start: start };
})();
