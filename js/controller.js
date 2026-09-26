/* Phone controller (landscape): left half pulls and shoots, right half moves the rods. */
var Controller = (function () {
  "use strict";

  var code, pid, name, team = null;
  var peer, conn, retry = 0, retryTimer = null, welcomed = false;
  var el = {};
  var pos = 0.5, pull = 0, lastSend = 0, sendTimer = null;
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
      move: document.getElementById("move"),
      moveTrack: document.querySelector("#move .move-track"),
      moveThumb: document.getElementById("move-thumb"),
      shoot: document.getElementById("shoot"),
      shootHint: document.getElementById("shoot-hint"),
      shootPower: document.getElementById("shoot-power"),
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

    bindMove();
    bindShoot();
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
          updateShootHint();
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
    goLandscape();
    showPad();
  }

  function showPad() {
    el.join.hidden = true;
    el.pad.hidden = false;
    el.pad.className = "pad " + (team || "red");
    updateShootHint();
    placeThumb();
    keepAwake();
  }

  // Android can go fullscreen + lock to landscape from a tap; iOS ignores this and
  // shows the "turn your phone" overlay instead.
  function goLandscape() {
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    function lock() {
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock("landscape").catch(function () {});
    }
    var d = document.documentElement;
    if (d.requestFullscreen && !document.fullscreenElement) {
      d.requestFullscreen({ navigationUI: "hide" }).then(lock).catch(function () {});
    } else lock();
  }

  function keepAwake() {
    if (!("wakeLock" in navigator) || wakeLock) return;
    navigator.wakeLock.request("screen").then(function (l) {
      wakeLock = l;
      l.addEventListener("release", function () { wakeLock = null; });
    }).catch(function () { /* not allowed right now */ });
  }

  /* ---------- right half: drag up/down to move the rods ---------- */
  // Relative, like a trackpad: sliding 75% of the pad's height covers the full rod travel,
  // so you can lift and re-grab without the rods jumping.
  function bindMove() {
    var id = null, lastY = 0;
    el.move.addEventListener("pointerdown", function (e) {
      if (id !== null) return;
      id = e.pointerId; lastY = e.clientY;
      el.move.classList.add("active");
      try { el.move.setPointerCapture(id); } catch (err) { /* synthetic or already-ended pointer */ }
      e.preventDefault();
    });
    el.move.addEventListener("pointermove", function (e) {
      if (e.pointerId !== id) return;
      var h = el.moveTrack.getBoundingClientRect().height || 1;
      pos = Math.max(0, Math.min(1, pos + (e.clientY - lastY) / (h * 0.75)));
      lastY = e.clientY;
      placeThumb();
      sendInput();
    });
    function end(e) {
      if (e.pointerId !== id) return;
      id = null;
      el.move.classList.remove("active");
    }
    el.move.addEventListener("pointerup", end);
    el.move.addEventListener("pointercancel", end);
    window.addEventListener("resize", placeThumb);
  }

  function placeThumb() {
    var r = el.moveTrack.getBoundingClientRect();
    var th = el.moveThumb.offsetHeight;
    var y = (pos - 0.5) * (r.height - th);
    el.moveThumb.style.transform = "translateY(" + y + "px)";
  }

  /* ---------- left half: pull back, push forward to shoot ---------- */
  // Power comes from the furthest pull. The shot fires as soon as the thumb swings
  // back forward, or when it lifts. A quick tap is a soft touch.
  var PULL_FULL = 0.38;   // fraction of the pad's width for a full-power pull

  function forwardDir() { return team === "blue" ? -1 : 1; }   // matches the big screen

  function updateShootHint() {
    el.shootHint.innerHTML = team === "blue"
      ? '<span class="arrow">◀</span> push · pull <span class="arrow">▶</span>'
      : '<span class="arrow">◀</span> pull · push <span class="arrow">▶</span>';
  }

  function bindShoot() {
    var id = null, startX = 0, maxPull = 0, fired = false, tick = 0;

    el.shoot.addEventListener("pointerdown", function (e) {
      if (id !== null) return;
      id = e.pointerId; startX = e.clientX; maxPull = 0; fired = false; tick = 0;
      el.shoot.classList.add("active");
      el.shoot.classList.remove("fire");
      try { el.shoot.setPointerCapture(id); } catch (err) { /* synthetic or already-ended pointer */ }
      e.preventDefault();
    });

    el.shoot.addEventListener("pointermove", function (e) {
      if (e.pointerId !== id || fired) return;
      var w = el.shoot.getBoundingClientRect().width || 1;
      var back = (startX - e.clientX) * forwardDir();
      var p = Math.max(0, Math.min(1, back / (w * PULL_FULL)));
      if (p > maxPull) maxPull = p;
      var q = Math.floor(p * 4);
      if (q > tick) { tick = q; FB.buzz(6); }   // a little click at each quarter
      setPull(p);
      // swung forward after a real pull: shoot now
      if (maxPull > 0.12 && p < maxPull * 0.4) { fired = true; fire(maxPull); }
    });

    function end(e) {
      if (e.pointerId !== id) return;
      id = null;
      el.shoot.classList.remove("active");
      if (!fired) fire(Math.max(0.2, maxPull));   // released a pull, or just tapped
    }
    el.shoot.addEventListener("pointerup", end);
    el.shoot.addEventListener("pointercancel", function (e) {
      if (e.pointerId !== id) return;
      id = null; el.shoot.classList.remove("active"); setPull(0);
    });
    el.shoot.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  }

  function setPull(p) {
    pull = p;
    el.shoot.style.setProperty("--pull", p.toFixed(3));
    el.shootPower.textContent = Math.round(p * 100) + "%";
    sendInput();
  }

  function fire(power) {
    power = Math.round(Math.max(0, Math.min(1, power)) * 100) / 100;
    send({ t: "kick", power: power });
    el.shoot.style.setProperty("--from", (pull * 58).toFixed(1) + "deg");
    setPull(0);
    el.shoot.classList.remove("fire");
    void el.shoot.offsetWidth;
    el.shoot.classList.add("fire");
    FB.buzz(Math.round(10 + power * 35));
  }

  // ~40 updates a second at most, always ending on the latest values
  function sendInput() {
    var now = performance.now();
    clearTimeout(sendTimer);
    if (now - lastSend >= 25) {
      lastSend = now;
      send({ t: "in", p: Math.round(pos * 1000) / 1000, pull: Math.round(pull * 100) / 100 });
    } else {
      sendTimer = setTimeout(sendInput, 25 - (now - lastSend));
    }
  }

  return { start: start };
})();
