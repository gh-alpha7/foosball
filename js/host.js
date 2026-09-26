/* Big-screen host: owns the room, simulates the table, renders it and streams it to spectators. */
var Host = (function () {
  "use strict";

  var W = Table.W, H = Table.H;
  var GOAL_TOP = Table.GOAL_TOP, GOAL_BOT = Table.GOAL_BOT;
  var BALL_R = Table.BALL_R, MAN_W = Table.MAN_W, MAN_H = Table.MAN_H;
  var KICK_TIME = 0.22, KICK_REACH = 24, WINDUP = 18;
  var ROD_SPEED = 2600, BOT_SPEED = 1050;
  var FRICTION = 0.62;                      // velocity kept per second
  var MAX_SPEED = 1700;
  var SNAP_MS = 33;                         // ~30 spectator updates a second

  var view;
  var peer, code, joinUrl, watchUrl;
  var players = {};          // pid -> { pid, name, team, conn, connected, roles, p, pull, leftAt, lastSeen }
  var claims = { red: {}, blue: {} };   // team -> role -> pid (kept while a player is briefly away)
  var spectators = [];       // { conn, lastSeen }
  var rods, ball, trail = [];
  var score = { red: 0, blue: 0 }, target = 5;
  var phase = "lobby";       // lobby | countdown | play | goal | over
  var phaseTime = 0, countdownShown = -1, stillTime = 0;
  var goalFlash = { team: null, t: 0 };
  var banner = null;         // { big, small, team } while a banner is up
  var metaDirty = true, lastSnap = 0, sfxQueue = [];
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
      redCount: document.getElementById("red-count"),
      blueCount: document.getElementById("blue-count"),
      qr: document.getElementById("qr"),
      joinUrl: document.getElementById("join-url"),
      roomCode: document.getElementById("room-code"),
      net: document.getElementById("net-status"),
      watchLine: document.getElementById("watch-line"),
      watchCount: document.getElementById("watch-count"),
      start: document.getElementById("btn-start"),
      targetSel: document.getElementById("target-select"),
      goalTarget: document.getElementById("goal-target")
    };
    el.view.hidden = false;
    document.title = "Foosball Party · Host";

    view = Table.createView(document.getElementById("table"), document.getElementById("table-wrap"));
    buildRods();
    resetBall(0);

    el.start.addEventListener("click", function () { Table.sound.unlock(); startMatch(); });
    el.targetSel.addEventListener("change", function () {
      target = +el.targetSel.value;
      el.goalTarget.textContent = target;
      broadcastScore();
      metaDirty = true;
    });
    document.getElementById("btn-lobby").addEventListener("click", function () { showLobby(true); });
    document.getElementById("btn-full").addEventListener("click", Table.toggleFullscreen);
    var soundBtn = document.getElementById("btn-sound");
    soundBtn.addEventListener("click", function () {
      Table.sound.setOn(!Table.sound.isOn());
      soundBtn.setAttribute("aria-pressed", String(Table.sound.isOn()));
    });
    document.addEventListener("pointerdown", Table.sound.unlock, { once: true });

    // dev-only hook for testing
    if (location.hostname === "localhost") {
      window.__fbHost = {
        rods: function () { return rods; }, ball: function () { return ball; },
        spectators: function () { return spectators.length; },
        tick: function (n) { for (var i = 0; i < (n || 1); i++) step(1 / 60); },
        pump: function () { step(1 / 60); lastSnap = 0; streamToSpectators(performance.now()); }
      };
    }
    // keep-alive on a timer, not the frame loop, so phones stay connected even if
    // the host tab is briefly in the background (browsers pause animation frames there)
    setInterval(function () { broadcast({ t: "ping" }); }, 2000);
    openRoom();
    renderLobby();
    renderWatchers();
    requestAnimationFrame(frame);
  }

  function buildRods() {
    rods = Table.rodLayout().map(function (r) {
      r.targetOff = 0; r.vy = 0;
      r.kick = 0; r.kickHit = false; r.power = 1; r.pull = 0; r.pull0 = 0;
      r.owners = [];
      r.bot = { think: 0, cool: 0, aim: 0 };
      return r;
    });
  }

  var manY = Table.manY;

  // Foot offset along x: leans back while the player pulls, then swings through
  // the ball. Harder shots swing further.
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
      var base = location.origin + location.pathname;
      joinUrl = base + "?join=" + code;
      watchUrl = base + "?watch=" + code;
      el.roomCode.textContent = code;
      el.joinUrl.textContent = joinUrl.replace(/^https?:\/\//, "");
      drawQr(joinUrl);
      setNet("ok", "ready for players");
      renderWatchers();
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
    if (conn.metadata && conn.metadata.role === "spectator") { addSpectator(conn); return; }
    conn.on("data", function (msg) { onMessage(conn, msg); });
    conn.on("close", function () { dropConn(conn); });
    conn.on("error", function () { dropConn(conn); });
  }

  /* ---------- spectators ---------- */
  function addSpectator(conn) {
    var s = { conn: conn, lastSeen: performance.now() };
    spectators.push(s);
    conn.on("open", function () { s.lastSeen = performance.now(); sendTo(conn, meta()); renderWatchers(); });
    conn.on("data", function (msg) {
      s.lastSeen = performance.now();
      if (msg && msg.t === "bye") removeSpectator(s);
    });
    conn.on("close", function () { removeSpectator(s); });
    conn.on("error", function () { removeSpectator(s); });
  }

  function removeSpectator(s) {
    var i = spectators.indexOf(s);
    if (i === -1) return;
    spectators.splice(i, 1);
    try { s.conn.close(); } catch (e) { /* ignore */ }
    renderWatchers();
  }

  function renderWatchers() {
    var n = spectators.length;
    el.watchCount.textContent = n ? " · 👀 " + n : "";
    el.watchLine.innerHTML = watchUrl
      ? "Just watching? Open <b>" + FB.escapeHtml(watchUrl.replace(/^https?:\/\//, "")) + "</b>" +
        (n ? ' <span class="watchers">👀 ' + n + " watching</span>" : "")
      : "";
    metaDirty = true;
  }

  function meta() {
    return {
      t: "meta",
      labels: rods.map(function (r) { return r.label; }),
      human: rods.map(function (r) { return r.owners.length > 0 ? 1 : 0; }),
      score: [score.red, score.blue], target: target, phase: phase, banner: banner,
      names: { red: teamList("red").map(pName), blue: teamList("blue").map(pName) },
      watchers: spectators.length, code: code
    };
  }
  function pName(p) { return p.name; }

  function snapshot() {
    return {
      t: "s",
      b: [Math.round(ball.x * 10) / 10, Math.round(ball.y * 10) / 10],
      r: rods.map(function (r) { return [Math.round(r.off * 10) / 10, Math.round(footDx(r) * 10) / 10]; }),
      g: goalFlash.t > 0 ? [goalFlash.team, Math.round(goalFlash.t * 100) / 100] : 0,
      a: sfxQueue.length ? sfxQueue.splice(0) : 0
    };
  }

  function streamToSpectators(now) {
    if (!spectators.length) { sfxQueue.length = 0; return; }
    if (metaDirty) { metaDirty = false; var m = meta(); spectators.forEach(function (s) { sendTo(s.conn, m); }); }
    if (now - lastSnap < SNAP_MS) return;
    lastSnap = now;
    var snap = snapshot();
    spectators.forEach(function (s) { sendTo(s.conn, snap); });
  }

  function sendTo(conn, msg) {
    if (conn && conn.open) { try { conn.send(msg); } catch (e) { /* ignore */ } }
  }

  /* ---------- players ---------- */
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
        p = players[pid] = { pid: pid, name: "", team: null, roles: [], p: 0.5, pull: 0, joinedAt: performance.now() };
      } else if (p.conn && p.conn !== conn) {
        try { p.conn.close(); } catch (e) { /* ignore */ }
      }
      p.conn = conn;
      p.connected = true;
      p.lastSeen = performance.now();
      p.name = cleanName(msg.name) || p.name || "Player";
      send(p, { t: "welcome", code: code });
      // a reconnecting player keeps their team and rods; a new one asks for a team
      if (!p.team && (msg.team === "red" || msg.team === "blue")) joinTeam(p, msg.team);
      assignRods();
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
        if ((msg.team === "red" || msg.team === "blue") && msg.team !== p.team) {
          if (teamMembers(msg.team).length >= FB.MAX_PER_TEAM) { send(p, { t: "full", team: msg.team }); break; }
          leaveTeam(p);
          joinTeam(p, msg.team);
          assignRods();
        }
        break;
      case "rod":
        toggleRod(p, msg.role, !!msg.take);
        break;
      case "name":
        p.name = cleanName(msg.name) || p.name;
        assignRods();
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
        leaveTeam(p);
        delete players[p.pid];
        assignRods();
        break;
    }
  }

  /* ---------- teams and rod claims ---------- */
  // everyone on a team, including players who are briefly disconnected
  function teamMembers(team) {
    return Object.keys(players).map(function (k) { return players[k]; })
      .filter(function (p) { return p.team === team; });
  }
  function rolesOf(pid, team) {
    return FB.ROLE_ORDER.filter(function (r) { return claims[team][r] === pid; });
  }

  // New arrivals take any free rods. If none are free they take the back half of
  // the rods held by the teammate with the most, so 1 player has all 4 and a second
  // player splits them 2/2. With four players holding one rod each the team is full.
  function joinTeam(p, team) {
    if (teamMembers(team).length >= FB.MAX_PER_TEAM) { send(p, { t: "full", team: team }); return false; }
    p.team = team;
    var free = FB.ROLE_ORDER.filter(function (r) { return !claims[team][r]; });
    if (!free.length) {
      var donor = null, most = 1;
      teamMembers(team).forEach(function (m) {
        var n = rolesOf(m.pid, team).length;
        if (m !== p && n > most) { most = n; donor = m; }
      });
      if (donor) free = rolesOf(donor.pid, team).slice(Math.ceil(most / 2));
    }
    free.forEach(function (r) { claims[team][r] = p.pid; });
    return true;
  }

  // Rods freed by someone leaving go to the teammate with the fewest rods, so the
  // bot only plays when a team is empty or a rod was deliberately left free.
  function leaveTeam(p) {
    var team = p.team;
    if (!team) return;
    var freed = rolesOf(p.pid, team);
    freed.forEach(function (r) { delete claims[team][r]; });
    p.team = null;
    var mates = teamMembers(team);
    freed.forEach(function (r) {
      if (!mates.length) return;
      mates.sort(function (a, b) { return rolesOf(a.pid, team).length - rolesOf(b.pid, team).length; });
      claims[team][r] = mates[0].pid;
    });
  }

  // take a free rod, or hand one of yours to the bot (you always keep at least one)
  function toggleRod(p, role, take) {
    var team = p.team;
    if (!team || FB.ROLE_ORDER.indexOf(role) === -1) return;
    var owner = claims[team][role];
    if (take) {
      if (owner && owner !== p.pid) {
        send(p, { t: "event", kind: "taken", role: role, by: players[owner] ? players[owner].name : "someone" });
        return;
      }
      claims[team][role] = p.pid;
    } else if (owner === p.pid && rolesOf(p.pid, team).length > 1) {
      delete claims[team][role];
    }
    assignRods();
  }

  function claimsView(team) {
    var out = {};
    FB.ROLE_ORDER.forEach(function (r) {
      var pid = claims[team][r], p = pid && players[pid];
      out[r] = p ? { pid: pid, name: p.name, away: !p.connected } : null;
    });
    return out;
  }

  function cleanName(s) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, 12); }

  function send(p, msg) { sendTo(p.conn, msg); }
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

  // Apply the claims to the table: a claimed rod follows its player while they're
  // connected; free rods and rods of players who are briefly away go to the bot.
  function assignRods() {
    rods.forEach(function (r) {
      var pid = claims[r.team][r.role], p = pid && players[pid];
      r.owners = p && p.connected ? [pid] : [];
      r.human = r.owners.length > 0;
      r.label = r.human ? p.name : "BOT";
    });
    Object.keys(players).forEach(function (k) {
      var p = players[k];
      p.roles = p.team ? rolesOf(p.pid, p.team) : [];
      send(p, { t: "you", team: p.team, roles: p.roles });
    });
    renderLobby();
    broadcastLobby();
    broadcastScore();
    metaDirty = true;
  }

  function broadcastLobby() {
    broadcast({
      t: "lobby",
      red: teamList("red").map(pName), blue: teamList("blue").map(pName),
      rods: { red: claimsView("red"), blue: claimsView("blue") },
      full: { red: teamMembers("red").length >= FB.MAX_PER_TEAM, blue: teamMembers("blue").length >= FB.MAX_PER_TEAM }
    });
  }
  function broadcastScore() {
    broadcast({ t: "score", red: score.red, blue: score.blue, phase: phase, target: target });
  }

  // One slot per rod, in field order, showing who holds it
  function renderLobby() {
    ["red", "blue"].forEach(function (team) {
      var view = claimsView(team);
      var ul = team === "red" ? el.lobbyRed : el.lobbyBlue;
      ul.innerHTML = FB.ROLE_ORDER.map(function (r) {
        var c = view[r];
        var who = c ? FB.escapeHtml(c.name) + (c.away ? ' <span class="away">away</span>' : "") : '<span class="bot">bot</span>';
        return '<li class="slot' + (c ? " taken" : "") + '"><span class="slot-role">' + FB.ROLE_SHORT[r] + "</span>" + who + "</li>";
      }).join("");
      var count = teamMembers(team).length;
      (team === "red" ? el.redCount : el.blueCount).textContent = count + "/" + FB.MAX_PER_TEAM;
      (team === "red" ? el.redNames : el.blueNames).textContent = teamList(team).map(pName).join(", ") || "bot";
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
    el.phase.textContent = Table.PHASE_LABELS[p] || p;
    broadcastScore();
    metaDirty = true;
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
    metaDirty = true;
  }

  function showBanner(big, small, team) {
    banner = { big: big, small: small || "", team: team || "" };
    Table.showBanner(el.banner, big, small, team);
    metaDirty = true;
  }
  function hideBanner() {
    banner = null;
    el.banner.hidden = true;
    metaDirty = true;
  }

  function sfx(kind, strength) {
    Table.sound.play(kind, strength);
    if (spectators.length && sfxQueue.length < 20) sfxQueue.push(strength ? [kind, Math.round(strength)] : kind);
  }

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
      if (!p.connected && now - p.leftAt > 30000) { leaveTeam(p); delete players[k]; assignRods(); }
    });
    spectators.slice().forEach(function (s) { if (now - s.lastSeen > 8000) removeSpectator(s); });

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
        else { nx = ball.x >= fx ? 1 : -1; ny = 0; }
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

  /* ---------- frame loop ---------- */
  function frame(t) {
    var dt = Math.min((t - (frame.last || t)) / 1000, 1 / 30);
    frame.last = t;
    step(dt);
    rods.forEach(function (r) { r.fdx = footDx(r); });
    view.draw({ ball: ball, trail: trail, goalFlash: goalFlash, rods: rods });
    streamToSpectators(performance.now());
    requestAnimationFrame(frame);
  }

  return { start: start };
})();
