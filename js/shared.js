/* Shared constants and helpers for host and controller. */
var FB = (function () {
  "use strict";

  // PeerJS ids are global on the public broker, so namespace ours.
  var PEER_PREFIX = "gha7-foosball-";
  // No 0/O/1/I/L so codes are easy to read off a TV.
  var CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

  // Rods from left to right. Red defends the left goal and attacks right.
  var RODS = [
    { team: "red",  role: "goalie",   men: 1 },
    { team: "red",  role: "defense",  men: 2 },
    { team: "blue", role: "attack",   men: 3 },
    { team: "red",  role: "midfield", men: 5 },
    { team: "blue", role: "midfield", men: 5 },
    { team: "red",  role: "attack",   men: 3 },
    { team: "blue", role: "defense",  men: 2 },
    { team: "blue", role: "goalie",   men: 1 }
  ];
  var ROLE_ORDER = ["goalie", "defense", "midfield", "attack"];
  var ROLE_SHORT = { goalie: "GK", defense: "DEF", midfield: "MID", attack: "ATT" };

  // How a team's four rods are split among its players.
  function splitRoles(n) {
    if (n <= 0) return [];
    if (n === 1) return [ROLE_ORDER.slice()];
    if (n === 2) return [["goalie", "defense"], ["midfield", "attack"]];
    if (n === 3) return [["goalie", "defense"], ["midfield"], ["attack"]];
    // 4+: one rod each, extra players double up starting from the midfield
    var out = ROLE_ORDER.map(function (r) { return [r]; });
    var extra = ["midfield", "attack", "defense", "goalie"];
    for (var i = 4; i < n; i++) out.push([extra[(i - 4) % 4]]);
    return out;
  }

  function describeRoles(roles) {
    if (!roles || !roles.length) return "spectating";
    if (roles.length === 4) return "all rods";
    return roles.map(function (r) { return ROLE_SHORT[r]; }).join(" + ");
  }

  function makeCode() {
    var s = "";
    var buf = new Uint32Array(4);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = 0; i < 4; i++) s += CODE_CHARS[buf[i] % CODE_CHARS.length];
    return s;
  }

  function cleanCode(s) {
    return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  }

  function uid() {
    var buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    return buf[0].toString(36) + buf[1].toString(36);
  }

  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { return null; }
  }

  function buzz(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) { /* ignore */ } }
  }

  function peerOptions() {
    return { debug: 1, config: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:global.stun.twilio.com:3478" }] } };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  return {
    PEER_PREFIX: PEER_PREFIX, RODS: RODS, ROLE_ORDER: ROLE_ORDER,
    splitRoles: splitRoles, describeRoles: describeRoles,
    makeCode: makeCode, cleanCode: cleanCode, uid: uid, store: store, buzz: buzz,
    peerOptions: peerOptions, escapeHtml: escapeHtml
  };
})();
