/* Spectator: joins a room read-only and replays the host's table from streamed snapshots. */
var Spectator = (function () {
  "use strict";

  var DELAY = 90;            // render this far behind the newest snapshot so there's always one to blend towards
  var code, peer, conn, view, rods;
  var buffer = [], trail = [], lastBall = null;
  var meta = null, lastHost = 0, retry = 0, retryTimer = null;
  var soundReady = false;
  var el = {};

  function start(roomCode) {
    code = FB.cleanCode(roomCode);
    el = {
      view: document.getElementById("view-host"),
      lobby: document.getElementById("lobby"),
      banner: document.getElementById("banner"),
      phase: document.getElementById("phase-label"),
      scoreRed: document.getElementById("score-red"),
      scoreBlue: document.getElementById("score-blue"),
      redNames: document.getElementById("red-names"),
      blueNames: document.getElementById("blue-names"),
      goalTarget: document.getElementById("goal-target"),
      watchCount: document.getElementById("watch-count"),
      pill: document.getElementById("spec-pill")
    };
    el.view.hidden = false;
    el.view.classList.add("spectating");
    el.lobby.hidden = true;
    document.getElementById("btn-lobby").hidden = true;
    document.title = "Foosball Party · Watching " + code;

    view = Table.createView(document.getElementById("table"), document.getElementById("table-wrap"));
    Table.fillWatchStrip(code);   // so spectators can pass the match on too
    rods = Table.rodLayout();

    document.getElementById("btn-full").addEventListener("click", Table.toggleFullscreen);
    var soundBtn = document.getElementById("btn-sound");
    soundBtn.addEventListener("click", function () {
      Table.sound.setOn(!Table.sound.isOn());
      soundBtn.setAttribute("aria-pressed", String(Table.sound.isOn()));
    });
    // browsers only allow audio after a tap
    document.addEventListener("pointerdown", function () {
      Table.sound.unlock(); soundReady = true; updatePill();
    }, { once: true });

    setInterval(function () {
      if (!conn || !conn.open) return;
      try { conn.send({ t: "ping" }); } catch (e) { /* ignore */ }
      if (performance.now() - lastHost > 6000) { try { conn.close(); } catch (e) { /* ignore */ } lost(); }
    }, 1000);
    window.addEventListener("pagehide", function () { if (conn && conn.open) try { conn.send({ t: "bye" }); } catch (e) { /* ignore */ } });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && (!conn || !conn.open)) { retry = 0; connect(); }
    });

    setPill("connecting", "Connecting to room " + code + "…");
    connect();
    requestAnimationFrame(frame);
  }

  /* ---------- networking ---------- */
  function connect() {
    clearTimeout(retryTimer);
    if (peer && !peer.destroyed) peer.destroy();
    peer = new Peer(FB.peerOptions());
    peer.on("open", function () {
      var c = peer.connect(FB.PEER_PREFIX + code, { reliable: true, serialization: "json", metadata: { role: "spectator" } });
      conn = c;
      c.on("open", function () { retry = 0; lastHost = performance.now(); updatePill(); });
      c.on("data", function (msg) { lastHost = performance.now(); onMessage(msg); });
      c.on("close", function () { if (c === conn) lost(); });
      c.on("error", function () { if (c === conn) lost(); });
    });
    peer.on("error", function (err) {
      if (err.type === "peer-unavailable") {
        setPill("err", "No game with code " + code + " right now. Retrying…");
        schedule(4000);
      } else if (err.type === "network" || err.type === "server-error" || err.type === "socket-error") {
        setPill("err", "Can't reach the game server. Check your connection.");
        schedule();
      }
    });
    peer.on("disconnected", function () { if (!peer.destroyed) peer.reconnect(); });
  }

  function lost() {
    setPill("err", "Connection lost, reconnecting…");
    schedule();
  }

  function schedule(ms) {
    clearTimeout(retryTimer);
    retry++;
    retryTimer = setTimeout(connect, ms || Math.min(8000, 700 * retry));
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "s") {
      buffer.push({ at: performance.now(), b: msg.b, r: msg.r, g: msg.g });
      if (buffer.length > 30) buffer.splice(0, buffer.length - 30);
      if (msg.a) msg.a.forEach(function (s) { if (Array.isArray(s)) Table.sound.play(s[0], s[1]); else Table.sound.play(s); });
    } else if (msg.t === "meta") {
      applyMeta(msg);
    }
  }

  function applyMeta(m) {
    var prev = meta;
    meta = m;
    m.labels.forEach(function (label, i) { rods[i].label = label; rods[i].human = !!m.human[i]; });
    el.scoreRed.textContent = m.score[0];
    el.scoreBlue.textContent = m.score[1];
    if (prev) {
      if (m.score[0] > prev.score[0]) bump(el.scoreRed);
      if (m.score[1] > prev.score[1]) bump(el.scoreBlue);
    }
    el.goalTarget.textContent = m.target;
    el.phase.textContent = Table.PHASE_LABELS[m.phase] || m.phase;
    el.redNames.textContent = m.names.red.join(", ") || "bot";
    el.blueNames.textContent = m.names.blue.join(", ") || "bot";
    el.watchCount.textContent = m.watchers ? " · 👀 " + m.watchers : "";
    if (m.banner) Table.showBanner(el.banner, m.banner.big, m.banner.small, m.banner.team);
    else el.banner.hidden = true;
    updatePill();
  }

  function bump(node) { node.classList.remove("bump"); void node.offsetWidth; node.classList.add("bump"); }

  function updatePill() {
    if (!conn || !conn.open) return;
    var parts = ["👀 Watching room " + code];
    if (meta && meta.phase === "lobby") parts.push("warm-up, waiting for kick-off");
    if (!soundReady) parts.push("tap for sound");
    setPill("ok", parts.join(" · "));
  }

  function setPill(cls, text) {
    el.pill.hidden = false;
    el.pill.className = "spec-pill " + cls;
    el.pill.textContent = text;
  }

  /* ---------- playback ---------- */
  function frame() {
    render();
    requestAnimationFrame(frame);
  }

  function render() {
    var ball = { x: Table.W / 2, y: Table.H / 2 }, goalFlash = null;
    if (buffer.length) {
      var t = performance.now() - DELAY;
      while (buffer.length > 2 && buffer[1].at <= t) buffer.shift();
      var a = buffer[0], b = buffer[1] || a;
      var span = b.at - a.at;
      var k = span > 0 ? Math.max(0, Math.min(1, (t - a.at) / span)) : 1;
      // the ball teleports on a re-serve or goal: don't smear it across the table
      var jump = Math.hypot(b.b[0] - a.b[0], b.b[1] - a.b[1]) > 160;
      if (jump) k = k < 0.5 ? 0 : 1;
      ball = { x: lerp(a.b[0], b.b[0], k), y: lerp(a.b[1], b.b[1], k) };
      for (var i = 0; i < rods.length; i++) {
        rods[i].off = lerp(a.r[i][0], b.r[i][0], k);
        rods[i].fdx = lerp(a.r[i][1], b.r[i][1], k);
      }
      var g = k < 0.5 ? a.g : b.g;
      if (g) goalFlash = { team: g[0], t: g[1] };

      if (lastBall && Math.hypot(ball.x - lastBall.x, ball.y - lastBall.y) > 160) trail = [];
      trail.push({ x: ball.x, y: ball.y });
      if (trail.length > 8) trail.shift();
      lastBall = ball;
    }
    view.draw({ ball: ball, trail: trail, goalFlash: goalFlash, rods: rods });
  }

  function lerp(a, b, k) { return a + (b - a) * k; }

  return { start: start };
})();
