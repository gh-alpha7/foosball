# Foosball Party

Multiplayer foosball for a room full of people. A laptop or TV browser shows the
table, and everyone plays with their phone (iPhone or Android) as the controller.

**Play:** https://gh-alpha7.github.io/foosball/

## How to play

1. On the big screen, open the site and choose **Host on this screen**.
2. Everyone scans the QR code (or opens the link and types the 4-letter code).
3. Enter a name and pick **Red** or **Blue**.
4. Slide on the left half of the phone to move your rods, and tap **KICK** to shoot.
5. The host presses **Start match**. First to 5 goals wins (3, 7 and 10 are also options).

Rods are shared out automatically within each team:

| Players on a team | Split |
| --- | --- |
| 1 | all four rods |
| 2 | goalie + defence / midfield + attack |
| 3 | goalie + defence / midfield / attack |
| 4+ | one rod each, extras double up from midfield |

A team with nobody on it is played by a bot, so you can also play 1 vs bot.
People can join, leave or switch teams mid-match. A phone that drops out keeps its
place for 30 seconds, so reloading or a sleeping screen doesn't lose the slot.

## How it works

- Plain static site (no build step): `index.html`, `css/style.css`, `js/*.js`.
- The host runs the physics and rendering on a canvas. Phones only send slider
  position and kicks, so every phone sees the same game on the one big screen.
- Phones talk to the host directly over **WebRTC data channels** via
  [PeerJS](https://peerjs.com/). Its free public broker is only used for the
  initial handshake. After that the traffic goes device to device, over local
  Wi-Fi when everyone is on the same network.
- Both sides send a heartbeat every second or two, because WebRTC close events
  are unreliable. The host frees a player's rods after 5 seconds of silence.

| File | What it does |
| --- | --- |
| `js/shared.js` | Constants, rod layout, how rods are split among teammates |
| `js/host.js` | Room, players, physics, bots, rendering, sound |
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
