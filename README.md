# Foosball Party

Multiplayer foosball for a room full of people. A laptop or TV browser shows the
table, and everyone plays with their phone (iPhone or Android) as the controller.

**Play:** https://gh-alpha7.github.io/foosball/

## How to play

1. On the big screen, open the site and choose **Host on this screen**.
2. Everyone scans the QR code (or opens the link and types the 4-letter code).
3. Enter a name, pick **Red** or **Blue**, then pick your rods.
4. Turn the phone sideways. The **right half** moves your rods: drag up and down.
   The **left half** shoots: pull your thumb back, then push it forward (or let go).
   The further you pull, the harder the shot, and a quick tap is a soft touch.
   Red pulls left and pushes right; Blue is mirrored to match the big screen.
5. The host presses **Start match**. First to 5 goals wins (3, 7 and 10 are also options).

## Picking rods

Each team has four rods: goalie, defence, midfield and attack. **Each rod has at
most one player, so a team holds up to 4 players.** After choosing a team you get
a rod picker: tap a free rod to take it, or tap one of yours to hand it to the bot
(you always keep at least one). Reopen the picker any time from the rods button on
the controller.

Everyone starts with a sensible default. A new player takes any free rods, or
otherwise the back half of the rods held by the teammate with the most. So one
player starts with all four and two players start 2 + 2, and anyone can change
that. A full team shows **Full** and can't be joined; join the other side or watch.

## Spectating

Anyone can watch a live match on their own screen, on a phone, tablet or another TV:

- open the site, type the room code and press **Watch**, or
- open `https://gh-alpha7.github.io/foosball/?watch=CODE` (the host lobby shows this link), or
- on the phone join screen, tap **Just watch instead**.

Spectators see the live table, scores, names and goal banners, with sound after a
tap. The host shows how many people are watching.

## Teams and bots

The bot plays any rod without a player, so an empty team is all bot and you can
play 1 vs bot. People can join, leave or switch teams mid-match. A phone that drops
out keeps its rods for 30 seconds (the bot covers them meanwhile), so reloading or
a sleeping screen doesn't lose them. After that, or when a player switches team,
their rods go to the teammate with the fewest.

## How it works

- Plain static site (no build step): `index.html`, `css/style.css`, `js/*.js`.
- The host runs the physics and rendering on a canvas. Phones only send slider
  position and kicks, so every phone sees the same game on the one big screen.
- Phones talk to the host directly over **WebRTC data channels** via
  [PeerJS](https://peerjs.com/). Its free public broker is only used for the
  initial handshake. After that the traffic goes device to device, over local
  Wi-Fi when everyone is on the same network.
- Spectators connect the same way but only receive: about 30 small snapshots a
  second (ball, rod positions, foot swings, sounds) plus a message whenever the
  score, names, phase or banner changes.
- Both sides send a heartbeat every second or two, because WebRTC close events
  are unreliable. The host frees a player's rods after 5 seconds of silence.

| File | What it does |
| --- | --- |
| `js/shared.js` | Constants, rod layout, how rods are split among teammates |
| `js/table.js` | Table geometry, canvas renderer and sound, shared by host and spectators |
| `js/host.js` | Room, players, physics, bots; streams snapshots to spectators |
| `js/spectator.js` | Read-only view: buffers snapshots and draws the table about 90 ms behind, interpolating between them |
| `js/controller.js` | Phone controller: join, team pick, slider, kick, haptics |
| `js/app.js` | Chooses host / controller / home view from the URL |

## Troubleshooting

- **Phone can't connect:** the host and phones need internet for the first
  handshake. Some corporate or guest Wi-Fi networks block device-to-device
  traffic; a phone hotspot usually works.
- **No vibration on iPhone:** iOS Safari doesn't support the vibration API.
  Android phones buzz on kicks and goals.
- **No sound:** click anywhere on the host page once. Browsers only play audio
  after a user interaction.

## Local development

Serve the folder with any static server, e.g. `npx serve .`, then open
`http://localhost:3000/#host` in one tab and the join link in another.
When `css/` or `js/` files change, bump the `?v=` numbers in `index.html` so
returning visitors don't mix a new page with cached old files.
