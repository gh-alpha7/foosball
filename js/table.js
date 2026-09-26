/* Table geometry, renderer and sound, shared by the host and spectators. */
var Table = (function () {
  "use strict";

  /* ---------- geometry (virtual units) ---------- */
  var W = 1200, H = 680, M = 40;            // field size and wooden frame margin
  var CW = W + M * 2, CH = H + M * 2;       // full canvas in virtual units
  var GOAL_H = 210, GOAL_TOP = (H - GOAL_H) / 2, GOAL_BOT = GOAL_TOP + GOAL_H;
  var BALL_R = 13, MAN_W = 24, MAN_H = 40;

  var COLORS = {
    red: ["#ff8a5b", "#ff4d5e", "#b3163a"],
    blue: ["#6ee7ff", "#3da5ff", "#1b5fc2"]
  };

  // Static layout for the 8 rods; the host adds simulation state on top.
  function rodLayout() {
    return FB.RODS.map(function (r, k) {
      var n = r.men;
      var spacing = n > 1 ? (H / n) * 0.98 : 0;
      return {
        team: r.team, role: r.role, men: n, spacing: spacing,
        maxOff: n === 1 ? GOAL_H / 2 + 34 : H / 2 - MAN_H / 2 - ((n - 1) / 2) * spacing,
        x: 58 + k * (W - 116) / 7,
        dir: r.team === "red" ? 1 : -1,
        off: 0, fdx: 0, label: "BOT", human: false
      };
    });
  }

  function manY(rod, i) { return H / 2 + (i - (rod.men - 1) / 2) * rod.spacing + rod.off; }

  /* ---------- renderer ---------- */
  // state: { ball: {x, y}, trail: [{x, y}], goalFlash: {team, t}, rods: [{x, team, dir, men, spacing, off, fdx, label, human}] }
  function createView(canvas, wrap) {
    var ctx = canvas.getContext("2d");
    var scale = 1;

    function fit() {
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
    new ResizeObserver(fit).observe(wrap);
    fit();

    function rr(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function draw(state) {
      var rods = state.rods;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, CW, CH);

      // wooden frame
      var wood = ctx.createLinearGradient(0, 0, 0, CH);
      wood.addColorStop(0, "#5b3a22"); wood.addColorStop(0.5, "#3f2716"); wood.addColorStop(1, "#5b3a22");
      rr(0, 0, CW, CH, 26); ctx.fillStyle = wood; ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 2; ctx.stroke();

      ctx.save();
      ctx.translate(M, M);

      drawGoal(-M + 8, "red");
      drawGoal(W, "blue");

      // felt with bands between the rods
      rr(0, 0, W, H, 10); ctx.save(); ctx.clip();
      var felt = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, W * 0.7);
      felt.addColorStop(0, "#23864c"); felt.addColorStop(1, "#15592f");
      ctx.fillStyle = felt; ctx.fillRect(0, 0, W, H);
      for (var b = 0; b < 8; b += 2) {
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
      var gf = state.goalFlash;
      if (gf && gf.t > 0 && COLORS[gf.team]) {
        var gx = gf.team === "red" ? W : 0;
        var g = ctx.createRadialGradient(gx, H / 2, 10, gx, H / 2, 420);
        g.addColorStop(0, hexA(COLORS[gf.team][1], 0.55 * Math.min(1, gf.t)));
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();

      // inner shadow along the walls
      rr(0, 0, W, H, 10);
      ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 6; ctx.stroke();

      drawBall(state.ball, state.trail || []);
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
      var human = rod.human;
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
      var fdx = rod.fdx || 0;
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
      var label = rod.label || "BOT";
      var text = label.length > 10 ? label.slice(0, 9) + "…" : label;
      var tw = ctx.measureText(text).width + 14;
      var lx = rod.x + (rod.dir > 0 ? 1 : -1) * (tw / 2 + 16);
      rr(lx - tw / 2, ly - 10, tw, 20, 10);
      ctx.fillStyle = human ? "rgba(10,14,12,0.85)" : "rgba(10,14,12,0.5)"; ctx.fill();
      ctx.fillStyle = human ? col[0] : "rgba(255,255,255,0.45)";
      ctx.fillText(text, lx, ly + 1);
    }

    function drawBall(ball, trail) {
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

    return { fit: fit, draw: draw };
  }

  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a + ")";
  }

  /* ---------- sound (tiny WebAudio synth, no files) ---------- */
  var sound = (function () {
    var audio = null, on = true, lastTap = 0;

    function unlock() {
      if (!audio) {
        try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
      }
      if (audio && audio.state === "suspended") audio.resume();
    }

    function play(kind, strength) {
      if (!on || !audio || audio.state !== "running") return;
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

    return {
      unlock: unlock, play: play,
      setOn: function (v) { on = v; if (v) unlock(); },
      isOn: function () { return on; }
    };
  })();

  /* ---------- shared page bits ---------- */
  function showBanner(el, big, small, team) {
    el.className = "banner " + (team || "");
    el.innerHTML = FB.escapeHtml(big) + (small ? "<small>" + FB.escapeHtml(small) + "</small>" : "");
    el.hidden = false;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  }

  function drawQr(target, url) {
    if (!target || typeof qrcode !== "function") return;
    var qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    target.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }

  // The strip under the table: a QR to watch, plus the code for anyone who wants to play.
  function fillWatchStrip(code) {
    var watchUrl = location.origin + location.pathname + "?watch=" + code;
    drawQr(document.getElementById("qr-watch"), watchUrl);
    document.getElementById("foot-watch-url").textContent = watchUrl.replace(/^https?:\/\//, "");
    document.getElementById("foot-code").textContent = code;
  }

  var PHASE_LABELS ={ lobby: "Lobby · warm-up", countdown: "Get ready", play: "Live", goal: "Goal!", over: "Full time" };

  return {
    W: W, H: H, M: M, GOAL_H: GOAL_H, GOAL_TOP: GOAL_TOP, GOAL_BOT: GOAL_BOT,
    BALL_R: BALL_R, MAN_W: MAN_W, MAN_H: MAN_H, COLORS: COLORS, PHASE_LABELS: PHASE_LABELS,
    rodLayout: rodLayout, manY: manY, createView: createView, sound: sound,
    showBanner: showBanner, toggleFullscreen: toggleFullscreen,
    drawQr: drawQr, fillWatchStrip: fillWatchStrip
  };
})();
