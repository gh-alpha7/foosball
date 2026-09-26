/* Big-screen host: owns the room, simulates the table and renders it. */
var Host = (function () {
  "use strict";

  /* ---------- table geometry (virtual units) ---------- */
  var W = 1200, H = 680, M = 40;            // field size and wooden frame margin
  var CW = W + M * 2, CH = H + M * 2;       // full canvas in virtual units
  var GOAL_H = 210, GOAL_TOP = (H - GOAL_H) / 2, GOAL_BOT = GOAL_TOP + GOAL_H;
  var BALL_R = 13, MAN_W = 24, MAN_H = 40;
  var KICK_TIME = 0.22, KICK_REACH = 24;
  var ROD_SPEED = 2600, BOT_SPEED = 1050;
  var FRICTION = 0.62;                      // velocity kept per second
  var MAX_SPEED = 1700;

  var COLORS = {
    red: ["#ff8a5b", "#ff4d5e", "#b3163a"],
    blue: ["#6ee7ff", "#3da5ff", "#1b5fc2"]
  };

  var canvas, ctx, scale = 1;
  var peer, code, joinUrl;
  var players = {};          // pid -> { pid, name, team, conn, connected, roles, p, leftAt }
  var rods, ball, trail = [];
  var score = { red: 0, blue: 0 }, target = 5;
  var phase = "lobby";       // lobby | countdown | play | goal | over
  var phaseTime = 0, countdownShown = -1, stillTime = 0;
  var goalFlash = { team: null, t: 0 };
  var soundOn = true, audio = null;
  var el = {};

  /* ---------- setup ---------- */
  function start() {
    el = {
      view: document.getElementById("view-host"),
      lobby: document.getElementById("lobby"),
      banner: document.getElementById("banner"),
      phase: document.getElementById("phase-label"),
      scoreRed: document.getElementById("score-red"),
      scoreBlue: document.getElementById("score-blue"),
      redNames: document.getElementById("red-names"),
      blueNames: document.getElementById("blue-names"),
      lobbyRed: document.getElementById("lobby-red"),
      lobbyBlue: document.getElementById("lobby-blue"),
      qr: document.getElementById("qr"),
      joinUrl: document.getElementById("join-url"),
      roomCode: document.getElementById("room-code"),
      net: document.getElementById("net-status"),
      start: document.getElementById("btn-start"),
      targetSel: document.getElementById("target-select"),
      goalTarget: document.getElementById("goal-target")
    };
    el.view.hidden = false;
    document.title = "Foosball Party · Host";

    canvas = document.getElementById("table");
    ctx = canvas.getContext("2d");
    new ResizeObserver(fit).observe(document.getElementById("table-wrap"));
    fit();

    buildRods();
    resetBall(0);

    el.start.addEventListener("click", function () { unlockAudio(); startMatch(); });
    el.targetSel.addEventListener("change", function () {
      target = +el.targetSel.value;
      el.goalTarget.textContent = target;
      broadcastScore();
    });
    document.getElementById("btn-lobby").addEventListener("click", function () { showLobby(true); });
    document.getElementById("btn-full").addEventListener("click", toggleFullscreen);
    var soundBtn = document.getElementById("btn-sound");
    soundBtn.addEventListener("click", function () {
      soundOn = !soundOn;
      soundBtn.setAttribute("aria-pressed", String(soundOn));
      if (soundOn) unlockAudio();
    });
    document.addEventListener("pointerdown", unlockAudio, { once: true });

    if (location.hostname === "localhost") window.__fbHost = { rods: function () { return rods; }, ball: function () { return ball; }, tick: function (n) { for (var i = 0; i < (n || 1); i++) step(1 / 60); } };   // dev-only hook for testing
    openRoom();
    renderLobby();
    requestAnimationFrame(frame);
  }

  function fit() {
    var wrap = document.getElementById("table-wrap");
    var r = wrap.getBoundingClientRect();
    var s = Math.min(r.width / CW, r.height / CH);
    if (!isFinite(s) || s <= 0) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = Math.floor(CW * s) + "px";
    canvas.style.height = Math.floor(CH * s) + "px";
    canvas.width = Math.floor(CW * s * dpr);
    canvas.height = Math.floor(CH * s * dpr);
    scale = s * dpr;
  }

  function buildRods() {
    rods = FB.RODS.map(function (r, k) {
      var n = r.men;
      var spacing = n > 1 ? (H / n) * 0.98 : 0;
      var maxOff = n === 1 ? GOAL_H / 2 + 34 : H / 2 - MAN_H / 2 - ((n - 1) / 2) * spacing;
      return {
        team: r.team, role: r.role, men: n, spacing: spacing, maxOff: maxOff,
        x: 58 + k * (W - 116) / 7,
        dir: r.team === "red" ? 1 : -1,
        off: 0, targetOff: 0, vy: 0,
        kick: 0, kickHit: false, power: 1, pull: 0, pull0: 0,
        owners: [], label: "",
        bot: { think: 0, cool: 0, aim: 0 }
      };
    });
  }

  function manY(rod, i) { return H / 2 + (i - (rod.men - 1) / 2) * rod.spacing + rod.off; }
  // Foot offset along x: leans back while the player pulls, then swings through
  // the ball. Harder shots swing further.
  var WINDUP = 18;
  function kickReach(rod) { return KICK_REACH * (0.55 + 0.45 * rod.power); }
  function footDx(rod) {
    if (rod.kick <= 0) return -rod.dir * rod.pull * WINDUP;
    var k = 1 - rod.kick / KICK_TIME;
    return rod.dir * (Math.sin(k * Math.PI) * kickReach(rod) - (1 - k) * rod.pull0 * WINDUP);
  }
  function footVx(rod) {
    if (rod.kick <= 0) return 0;
    var k = 1 - rod.kick / KICK_TIME;
    return rod.dir * (Math.cos(k * Math.PI) * Math.PI * kickReach(rod) + rod.pull0 * WINDUP) / KICK_TIME;
  }
  function startKick(rod, power) {
    if (rod.kick > 0) return;
    rod.kick = KICK_TIME;
    rod.kickHit = false;
    rod.power = Math.max(0, Math.min(1, power));
    rod.pull0 = rod.pull;
    rod.pull = 0;
  }

  /* ---------- networking ---------- */
  function openRoom() {
    code = FB.makeCode();
    setNet("", "connecting…");
    peer = new Peer(FB.PEER_PREFIX + code, FB.peerOptions());

    peer.on("open", function () {
      joinUrl = location.origin + location.pathname + "?join=" + code;
      el.roomCode.textContent = code;
      el.joinUrl.textContent = joinUrl.replace(/^https?:\/\//, "");
      drawQr(joinUrl);
      setNet("ok", "ready for players");
    });
    peer.on("connection", onConnection);
    peer.on("disconnected", function () {
      setNet("err", "lost the signalling server, retrying…");
      setTimeout(function () { if (peer && !peer.destroyed) peer.reconnect(); }, 1500);
    });
    peer.on("error", function (err) {
      if (err.type === "unavailable-id") { peer.destroy(); openRoom(); return; }
      if (err.type === "network" || err.type === "server-error" || err.type === "socket-error") {
        setNet("err", "can't reach the signalling server. Check the internet connection.");
        return;
      }
      console.warn("peer error", err.type, err);
    });
  }

  function setNet(cls, text) {
    el.net.className = "net-status " + cls;
    el.net.innerHTML = '<span class="dot"></span> ' + FB.escapeHtml(text);
  }

  function drawQr(url) {
    var qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    el.qr.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }

  function onConnection(conn) {
    conn.on("data", function (msg) { onMessage(conn, msg); });
    conn.on("close", function () { dropConn(conn); });
    conn.on("error", function () { dropConn(conn); });
  }

  function dropConn(conn) {
    Object.keys(players).forEach(function (pid) {
      var p = players[pid];
      if (p.conn === conn) {
        p.connected = false;
        p.conn = null;
        p.leftAt = performance.now();
        assignRods();
      }
    });
  }

  function onMessage(conn, msg) {
    if (!msg || typeof msg !== "object") return;
    var p = msg.pid ? players[msg.pid] : null;

    if (msg.t === "hello") {
      var pid = String(msg.pid || "").slice(0, 32);
      if (!pid) return;
      p = players[pid];
      if (!p) {
        p = players[pid] = { pid: pid, name: "", team: null, roles: [], p: 0.5, joinedAt: performance.now() };
      } else if (p.conn && p.conn !== conn) {
        try { p.conn.close(); } catch (e) { /* ignore */ }
      }
      p.conn = conn;
      p.connected = true;
      p.lastSeen = performance.now();
      p.name = cleanName(msg.name) || p.name || "Player";
      if (msg.team === "red" || msg.team === "blue") p.team = msg.team;
      assignRods();
      send(p, { t: "welcome", code: code });
      return;
    }
    if (!p || p.conn !== conn) return;
    p.lastSeen = performance.now();

    switch (msg.t) {
      case "ping":
        break;
      case "bye":
        dropConn(conn);
        break;
      case "team":
        if (msg.team === "red" || msg.team === "blue") { p.team = msg.team; assignRods(); }
        break;
      case "name":
        p.name = cleanName(msg.name) || p.name;
        renderLobby(); broadcastLobby();
        break;
      case "in":
        var v = +msg.p, pl = +msg.pull;
        if (v >= 0 && v <= 1) p.p = v;
        if (pl >= 0 && pl <= 1) p.pull = pl;
        break;
      case "kick":
        var power = +msg.power;
        if (!(power >= 0 && power <= 1)) power = 0.7;
        p.pull = 0;
        rods.forEach(function (rod) {
          if (rod.owners.indexOf(p.pid) !== -1) startKick(rod, power);
        });
        break;
      case "leave":
        delete players[p.pid];
        assignRods();
        break;
    }
  }

  function cleanName(s) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, 12); }

  function send(p, msg) {
    if (p.conn && p.conn.open) { try { p.conn.send(msg); } catch (e) { /* ignore */ } }
  }
  function broadcast(msg, team) {
    Object.keys(players).forEach(function (pid) {
      var p = players[pid];
      if (!team || p.team === team) send(p, msg);
    });
  }

  function teamList(team) {
    return Object.keys(players).map(function (k) { return players[k]; })
      .filter(function (p) { return p.team === team && p.connected; })
      .sort(function (a, b) { return a.joinedAt - b.joinedAt; });
  }

  // Split each team's rods among its connected players; empty rods go to the bot.
  function assignRods() {
    rods.forEach(function (r) { r.owners = []; });
    ["red", "blue"].forEach(function (team) {
      var list = teamList(team);
      var split = FB.splitRoles(list.length);
      list.forEach(function (p, i) {
        p.roles = split[i] || [];
        rods.forEach(function (r) {
          if (r.team === team && p.roles.indexOf(r.role) !== -1) r.owners.push(p.pid);
        });
      });
    });
    Object.keys(players).forEach(function (k) {
      var p = players[k];
      if (!p.team || !p.connected) p.roles = [];
      send(p, { t: "you", team: p.team, roles: p.roles });
    });
    rods.forEach(function (r) {
      r.label = r.owners.length ? r.owners.map(function (id) { return players[id].name; }).join(" / ") : "BOT";
    });
    renderLobby();
    broadcastLobby();
    broadcastScore();
  }

  function broadcastLobby() {
    broadcast({
      t: "lobby",
      red: teamList("red").map(function (p) { return p.name; }),
      blue: teamList("blue").map(function (p) { return p.name; })
    });
  }
  function broadcastScore() {
    broadcast({ t: "score", red: score.red, blue: score.blue, phase: phase, target: target });
  }

  function renderLobby() {
    ["red", "blue"].forEach(function (team) {
      var list = teamList(team);
      var ul = team === "red" ? el.lobbyRed : el.lobbyBlue;
      ul.innerHTML = list.length
        ? list.map(function (p) {
            return "<li>" + FB.escapeHtml(p.name) + '<span class="rods">' + FB.describeRoles(p.roles) + "</span></li>";
          }).join("")
        : '<li class="empty">Bot will play</li>';
      var names = list.map(function (p) { return p.name; }).join(", ");
      (team === "red" ? el.redNames : el.blueNames).textContent = names || "bot";
    });
  }

  /* ---------- match flow ---------- */
  function startMatch() {
    score.red = score.blue = 0;
    target = +el.targetSel.value;
    updateScoreboard(null);
    showLobby(false);
    beginCountdown();
    broadcast({ t: "event", kind: "start" });
  }

  function showLobby(show) {
    el.lobby.hidden = !show;
    if (show) {
      setPhase("lobby");
      hideBanner();
      el.start.textContent = score.red || score.blue ? "Rematch" : "Start match";
      resetBall(0);
    }
  }

  function setPhase(p) {
    phase = p;
    phaseTime = 0;
    var labels = { lobby: "Lobby · warm-up", countdown: "Get ready", play: "Live", goal: "Goal!", over: "Full time" };
    el.phase.textContent = labels[p] || p;
    broadcastScore();
  }

  function beginCountdown() {
    setPhase("countdown");
    countdownShown = -1;
    resetBall(0);
  }

  function resetBall(towards) {
    ball = { x: W / 2, y: H / 2 + (Math.random() - 0.5) * 120, vx: 0, vy: 0 };
    if (towards) {
      ball.vx = towards * (140 + Math.random() * 80);
      ball.vy = (Math.random() - 0.5) * 260;
    }
    trail = [];
    stillTime = 0;
  }

  function serve() {
    var dir = Math.random() < 0.5 ? -1 : 1;
    ball.vx = dir * (120 + Math.random() * 90);
    ball.vy = (Math.random() < 0.5 ? -1 : 1) * (260 + Math.random() * 200);
  }

  function goal(team) {
    if (phase !== "play" && phase !== "lobby") return;   // already scored this frame
    if (phase === "lobby") {   // warm-up goals don't count
      sfx("goal-soft");
      goalFlash = { team: team, t: 0.8 };
      resetBall(team === "red" ? -1 : 1);
      return;
    }
    score[team]++;
    goalFlash = { team: team, t: 1.6 };
    updateScoreboard(team);
    sfx("goal");
    var scorer = team === "red" ? "Red" : "Blue";
    if (score[team] >= target) {
      setPhase("over");
      showBanner(scorer + " wins!", score.red + " – " + score.blue, team);
      broadcast({ t: "event", kind: "win", team: team });
      sfx("win");
    } else {
      setPhase("goal");
      showBanner("GOAL!", scorer + " scores · " + score.red + " – " + score.blue, team);
      broadcast({ t: "event", kind: "goal", team: team });
    }
    ball.vx *= 0.2; ball.vy *= 0.2;
  }

  function updateScoreboard(bumpTeam) {
    el.scoreRed.textContent = score.red;
    el.scoreBlue.textContent = score.blue;
    if (bumpTeam) {
      var s = bumpTeam === "red" ? el.scoreRed : el.scoreBlue;
      s.classList.remove("bump"); void s.offsetWidth; s.classList.add("bump");
    }
    broadcastScore();
  }

  function showBanner(big, small, team) {
    el.banner.className = "banner " + (team || "");
    el.banner.innerHTML = FB.escapeHtml(big) + (small ? "<small>" + FB.escapeHtml(small) + "</small>" : "");
    el.banner.hidden = false;
  }
  function hideBanner() { el.banner.hidden = true; }

  /* ---------- simulation ---------- */
  function step(dt) {
    phaseTime += dt;

    if (phase === "countdown") {
      var n = 3 - Math.floor(phaseTime);
      if (n !== countdownShown && n > 0) { countdownShown = n; showBanner(String(n), null, ""); sfx("tick"); }
      if (phaseTime >= 3) { hideBanner(); setPhase("play"); serve(); sfx("go"); }
    } else if (phase === "goal" && phaseTime > 2.2) {
      hideBanner(); beginCountdown();
    } else if (phase === "over" && phaseTime > 4.5) {
      showLobby(true);
    }

    // WebRTC close events are unreliable, so silence counts as leaving.
    // A player keeps their slot for 30s in case they reload or their phone sleeps.
    var now = performance.now();
    Object.keys(players).forEach(function (k) {
      var p = players[k];
      if (p.connected && now - p.lastSeen > 5000) {
        var c = p.conn;
        dropConn(c);
        try { c.close(); } catch (e) { /* ignore */ }
      }
      if (!p.connected && now - p.leftAt > 30000) { delete players[k]; assignRods(); }
    });
    if (now - (step.lastPing || 0) > 2000) { step.lastPing = now; broadcast({ t: "ping" }); }

    rods.forEach(function (rod) { moveRod(rod, dt); });

    if (goalFlash.t > 0) goalFlash.t -= dt;

    var ballLive = phase === "play" || phase === "lobby";
    if (!ballLive) {
      if (phase === "goal" || phase === "over") freeBall(dt, false);
      return;
    }
    freeBall(dt, true);
  }

  function moveRod(rod, dt) {
    var human = rod.owners.length > 0;
    if (human) {
      // most recently joined owner on a shared rod wins; normally there's just one
      var owner = players[rod.owners[rod.owners.length - 1]];
      rod.targetOff = (owner.p * 2 - 1) * rod.maxOff;
      if (rod.kick <= 0) rod.pull = owner.pull || 0;
    } else {
      rod.pull = 0;
      botThink(rod, dt);
    }
    var speed = human ? ROD_SPEED : BOT_SPEED;
    var before = rod.off;
    var d = rod.targetOff - rod.off;
    var maxStep = speed * dt;
    rod.off += Math.max(-maxStep, Math.min(maxStep, d));
    rod.off = Math.max(-rod.maxOff, Math.min(rod.maxOff, rod.off));
    rod.vy = dt > 0 ? (rod.off - before) / dt : 0;
    if (rod.kick > 0) rod.kick = Math.max(0, rod.kick - dt);
  }

  function botThink(rod, dt) {
    var b = rod.bot;
    b.think -= dt;
    b.cool -= dt;
    if (b.think <= 0) {
      b.think = 0.08 + Math.random() * 0.08;
      b.aim = (Math.random() - 0.5) * 18;
    }
    // line the closest reachable man up with where the ball is heading
    var py = ball.y + ball.vy * 0.12 + b.aim;
    var best = null, bestD = Infinity;
    for (var i = 0; i < rod.men; i++) {
      var base = H / 2 + (i - (rod.men - 1) / 2) * rod.spacing;
      var off = Math.max(-rod.maxOff, Math.min(rod.maxOff, py - base));
      var dd = Math.abs(base + off - py);
      if (dd < bestD - 1 || (Math.abs(dd - bestD) <= 1 && Math.abs(off - rod.off) < Math.abs(best - rod.off))) { bestD = dd; best = off; }
    }
    rod.targetOff = best;

    var ahead = (ball.x - rod.x) * rod.dir;
    if (b.cool <= 0 && ahead > -10 && ahead < 36 && phase !== "countdown") {
      for (var j = 0; j < rod.men; j++) {
        if (Math.abs(ball.y - manY(rod, j)) < MAN_H / 2 + 8) {
          startKick(rod, 0.55 + Math.random() * 0.45);
          b.cool = 0.45 + Math.random() * 0.45;
          break;
        }
      }
    }
  }

  function freeBall(dt, collide) {
    var speed = Math.hypot(ball.vx, ball.vy);
    var steps = Math.max(1, Math.ceil(speed * dt / 5));
    var h = dt / steps;
    for (var s = 0; s < steps; s++) {
      ball.x += ball.vx * h;
      ball.y += ball.vy * h;
      walls(collide);
      if (collide) men();
      if (!collide && (ball.x < -BALL_R * 3 || ball.x > W + BALL_R * 3)) { ball.vx = ball.vy = 0; }
    }
    var f = Math.pow(FRICTION, dt);
    ball.vx *= f; ball.vy *= f;
    speed = Math.hypot(ball.vx, ball.vy);
    if (speed > MAX_SPEED) { ball.vx *= MAX_SPEED / speed; ball.vy *= MAX_SPEED / speed; }

    trail.push({ x: ball.x, y: ball.y });
    if (trail.length > 8) trail.shift();

    // a dead ball nobody can reach gets re-served
    if (collide) {
      stillTime = speed < 22 ? stillTime + dt : 0;
      if (stillTime > 3.5) {
        resetBall(0); serve();
        if (phase === "play") { showBanner("Re-serve", null, ""); setTimeout(hideBanner, 900); }
      }
    }
  }

  function walls(collide) {
    var r = BALL_R;
    var inMouth = ball.y > GOAL_TOP + r * 0.4 && ball.y < GOAL_BOT - r * 0.4;
    if (ball.y < r) { ball.y = r; ball.vy = Math.abs(ball.vy) * 0.82; if (collide) sfx("wall", Math.abs(ball.vy)); }
    if (ball.y > H - r) { ball.y = H - r; ball.vy = -Math.abs(ball.vy) * 0.82; if (collide) sfx("wall", Math.abs(ball.vy)); }

    if (ball.x < r) {
      if (!inMouth && ball.x > -r) { ball.x = r; ball.vx = Math.abs(ball.vx) * 0.82; if (collide) sfx("wall", Math.abs(ball.vx)); }
      else if (ball.x < 0) goalMouth();
      if (collide && ball.x < -r * 1.1) goal("blue");
    }
    if (ball.x > W - r) {
      if (!inMouth && ball.x < W + r) { ball.x = W - r; ball.vx = -Math.abs(ball.vx) * 0.82; if (collide) sfx("wall", Math.abs(ball.vx)); }
      else if (ball.x > W) goalMouth();
      if (collide && ball.x > W + r * 1.1) goal("red");
    }
  }

  // inside the goal the ball is boxed in by the goal's own walls
  function goalMouth() {
    var r = BALL_R;
    if (ball.y < GOAL_TOP + r) { ball.y = GOAL_TOP + r; ball.vy = Math.abs(ball.vy) * 0.6; }
    if (ball.y > GOAL_BOT - r) { ball.y = GOAL_BOT - r; ball.vy = -Math.abs(ball.vy) * 0.6; }
  }

  function men() {
    for (var k = 0; k < rods.length; k++) {
      var rod = rods[k];
      var fx = rod.x + footDx(rod);
      if (Math.abs(ball.x - fx) > MAN_W / 2 + BALL_R + 2) continue;
      for (var i = 0; i < rod.men; i++) {
        var my = manY(rod, i);
        var cx = Math.max(fx - MAN_W / 2, Math.min(ball.x, fx + MAN_W / 2));
        var cy = Math.max(my - MAN_H / 2, Math.min(ball.y, my + MAN_H / 2));
        var dx = ball.x - cx, dy = ball.y - cy;
        var d2 = dx * dx + dy * dy;
        if (d2 > BALL_R * BALL_R) continue;

        var d = Math.sqrt(d2), nx, ny;
        if (d > 0.0001) { nx = dx / d; ny = dy / d; }
        else { nx = ball.x >= fx ? 1 : -1; ny = 0; d = 0; }
        // push out
        ball.x = cx + nx * (BALL_R + 0.5);
        ball.y = cy + ny * (BALL_R + 0.5);

        var mvx = footVx(rod), mvy = rod.vy;
        var rvx = ball.vx - mvx, rvy = ball.vy - mvy;
        var vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          ball.vx -= 1.55 * vn * nx;
          ball.vy -= 1.55 * vn * ny;
          ball.vy += mvy * 0.35;
          sfx("tap", -vn);
        }

        if (rod.kick > 0 && !rod.kickHit) {
          rod.kickHit = true;
          var aim = Math.max(-1, Math.min(1, (ball.y - my) / (MAN_H / 2)));
          var ang = aim * 0.55 + Math.max(-0.35, Math.min(0.35, rod.vy / 5000));
          // soft tap ~330 px/s, full pull ~1600 px/s
          var sp = 300 + rod.power * 1250 + Math.random() * 80;
          ball.vx = rod.dir * Math.cos(ang) * sp;
          ball.vy = Math.sin(ang) * sp;
          ball.x = fx + rod.dir * (MAN_W / 2 + BALL_R + 1);
          sfx("kick");
          rod.owners.forEach(function (id) { if (players[id]) send(players[id], { t: "event", kind: "hit" }); });
        }
        return;
      }
    }
  }

  /* ---------- rendering ---------- */
  function frame(t) {
    var dt = Math.min((t - (frame.last || t)) / 1000, 1 / 30);
    frame.last = t;
    step(dt);
    draw();
    requestAnimationFrame(frame);
  }

  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function draw() {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, CW, CH);

    // wooden frame
    var wood = ctx.createLinearGradient(0, 0, 0, CH);
    wood.addColorStop(0, "#5b3a22"); wood.addColorStop(0.5, "#3f2716"); wood.addColorStop(1, "#5b3a22");
    rr(0, 0, CW, CH, 26); ctx.fillStyle = wood; ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 2; ctx.stroke();

    ctx.save();
    ctx.translate(M, M);

    // goals (drawn into the frame on each side)
    drawGoal(-M + 8, "red");
    drawGoal(W, "blue");

    // felt with bands between the rods
    rr(0, 0, W, H, 10); ctx.save(); ctx.clip();
    var felt = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, W * 0.7);
    felt.addColorStop(0, "#23864c"); felt.addColorStop(1, "#15592f");
    ctx.fillStyle = felt; ctx.fillRect(0, 0, W, H);
    for (var b = 0; b < 8; b++) {
      if (b % 2) continue;
      var x0 = b === 0 ? 0 : (rods[b - 1].x + rods[b].x) / 2;
      var x1 = (rods[b].x + rods[b + 1].x) / 2;
      ctx.fillStyle = "rgba(255,255,255,0.035)"; ctx.fillRect(x0, 0, x1 - x0, H);
    }
    // markings
    ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 78, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.beginPath(); ctx.arc(W / 2, H / 2, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeRect(-3, GOAL_TOP - 60, 110, GOAL_H + 120);
    ctx.strokeRect(W - 107, GOAL_TOP - 60, 110, GOAL_H + 120);
    ctx.strokeRect(-3, GOAL_TOP - 10, 44, GOAL_H + 20);
    ctx.strokeRect(W - 41, GOAL_TOP - 10, 44, GOAL_H + 20);
    // goal flash
    if (goalFlash.t > 0) {
      var gx = goalFlash.team === "red" ? W : 0;
      var g = ctx.createRadialGradient(gx, H / 2, 10, gx, H / 2, 420);
      g.addColorStop(0, hexA(COLORS[goalFlash.team][1], 0.55 * Math.min(1, goalFlash.t)));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();

    // inner shadow along the walls
    rr(0, 0, W, H, 10);
    ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 6; ctx.stroke();

    drawBall();
    rods.forEach(drawRod);

    ctx.restore();
  }

  function drawGoal(x, team) {
    ctx.fillStyle = "#0c120f";
    rr(x, GOAL_TOP - 6, M - 8, GOAL_H + 12, 6); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1;
    for (var y = GOAL_TOP; y < GOAL_BOT; y += 12) { ctx.beginPath(); ctx.moveTo(x + 3, y); ctx.lineTo(x + M - 11, y); ctx.stroke(); }
    ctx.fillStyle = COLORS[team][1];
    ctx.fillRect(team === "red" ? x + M - 12 : x, GOAL_TOP - 6, 4, GOAL_H + 12);
  }

  function drawRod(rod) {
    var human = rod.owners.length > 0;
    var col = COLORS[rod.team];
    // bar
    var bar = ctx.createLinearGradient(rod.x - 5, 0, rod.x + 5, 0);
    bar.addColorStop(0, "#6f7a74"); bar.addColorStop(0.5, "#eef3f0"); bar.addColorStop(1, "#6f7a74");
    ctx.fillStyle = bar;
    ctx.fillRect(rod.x - 4, -M + 4, 8, H + M * 2 - 8);

    // handle on the owning team's side: red at the bottom, blue at the top
    var hy = rod.team === "red" ? H + 6 : -M + 6;
    rr(rod.x - 11, hy, 22, M - 12, 7);
    ctx.fillStyle = human ? col[1] : "#3a3f3c"; ctx.fill();

    // men
    var fdx = footDx(rod);
    for (var i = 0; i < rod.men; i++) {
      var y = manY(rod, i);
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.beginPath(); ctx.ellipse(rod.x + fdx * 0.6 + 4, y + 6, MAN_W * 0.7, MAN_H * 0.55, 0, 0, Math.PI * 2); ctx.fill();

      var body = ctx.createLinearGradient(rod.x - MAN_W / 2, 0, rod.x + MAN_W / 2, 0);
      body.addColorStop(0, col[0]); body.addColorStop(0.55, col[1]); body.addColorStop(1, col[2]);
      if (!human) ctx.globalAlpha = 0.82;
      rr(rod.x - MAN_W / 2 + fdx, y - MAN_H / 2, MAN_W, MAN_H, 8);
      ctx.fillStyle = body; ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1.5; ctx.stroke();
      // shoulders across the bar
      ctx.fillStyle = col[2];
      rr(rod.x - MAN_W / 2 - 3, y - 7, MAN_W + 6, 14, 6); ctx.fill();
      // head
      ctx.fillStyle = "#f4d8b8";
      ctx.beginPath(); ctx.arc(rod.x, y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // owner label in the frame
    ctx.font = "600 13px 'JetBrains Mono', monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    var ly = rod.team === "red" ? H + M / 2 + 2 : -M / 2 + 2;
    var text = rod.label.length > 10 ? rod.label.slice(0, 9) + "…" : rod.label;
    var tw = ctx.measureText(text).width + 14;
    var lx = rod.x + (rod.dir > 0 ? 1 : -1) * (tw / 2 + 16);
    rr(lx - tw / 2, ly - 10, tw, 20, 10);
    ctx.fillStyle = human ? "rgba(10,14,12,0.85)" : "rgba(10,14,12,0.5)"; ctx.fill();
    ctx.fillStyle = human ? col[0] : "rgba(255,255,255,0.45)";
    ctx.fillText(text, lx, ly + 1);
  }

  function drawBall() {
    for (var i = 0; i < trail.length; i++) {
      var a = (i + 1) / trail.length;
      ctx.fillStyle = "rgba(255,255,255," + (0.12 * a) + ")";
      ctx.beginPath(); ctx.arc(trail[i].x, trail[i].y, BALL_R * (0.5 + 0.5 * a), 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath(); ctx.ellipse(ball.x + 4, ball.y + 6, BALL_R, BALL_R * 0.8, 0, 0, Math.PI * 2); ctx.fill();
    var g = ctx.createRadialGradient(ball.x - 4, ball.y - 5, 2, ball.x, ball.y, BALL_R);
    g.addColorStop(0, "#ffffff"); g.addColorStop(0.7, "#e6ece8"); g.addColorStop(1, "#aab5ae");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2); ctx.fill();
  }

  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a + ")";
  }

  /* ---------- sound (tiny WebAudio synth, no files) ---------- */
  function unlockAudio() {
    if (!audio) {
      try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
    }
    if (audio && audio.state === "suspended") audio.resume();
  }

  var lastTap = 0;
  function sfx(kind, strength) {
    if (!soundOn || !audio || audio.state !== "running") return;
    var t = audio.currentTime;
    if ((kind === "wall" || kind === "tap") && (t - lastTap < 0.05 || (strength || 0) < 90)) return;
    if (kind === "wall" || kind === "tap") lastTap = t;
    switch (kind) {
      case "kick": tone(170, 0.09, "triangle", 0.5, 60); noise(0.05, 0.25); break;
      case "tap": tone(260, 0.05, "sine", 0.18, 120); break;
      case "wall": tone(120, 0.06, "sine", Math.min(0.3, (strength || 0) / 3000), 70); break;
      case "tick": tone(660, 0.12, "square", 0.08); break;
      case "go": tone(990, 0.25, "square", 0.1); break;
      case "goal-soft": tone(520, 0.15, "triangle", 0.15); tone(780, 0.2, "triangle", 0.15, 0, 0.1); break;
      case "goal":
        [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.22, "square", 0.09, 0, i * 0.09); });
        noise(1.2, 0.18, 0.05);
        break;
      case "win":
        [523, 659, 784, 1047, 784, 1047].forEach(function (f, i) { tone(f, 0.3, "triangle", 0.14, 0, 0.5 + i * 0.12); });
        break;
    }
  }

  function tone(freq, dur, type, vol, slideTo, delay) {
    var t = audio.currentTime + (delay || 0);
    var o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noise(dur, vol, delay) {
    var t = audio.currentTime + (delay || 0);
    var len = Math.floor(audio.sampleRate * dur);
    var buf = audio.createBuffer(1, len, audio.sampleRate), data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = audio.createBufferSource(), g = audio.createGain(), f = audio.createBiquadFilter();
    f.type = "bandpass"; f.frequency.value = 1400; f.Q.value = 0.7;
    src.buffer = buf; g.gain.value = vol;
    src.connect(f).connect(g).connect(audio.destination);
    src.start(t);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  }

  return { start: start };
})();
