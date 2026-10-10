# LEFT! LEFT! LEFT!

**DRIVE BLIND. NAVIGATE LOUD. SURVIVE THE CABIN.**

An asymmetrical two-player co-op rally game for the desktop browser. Two players share one faded
orange-red hatchback:

- **The Driver** sits behind a real steering wheel in a first-person cockpit. No minimap, no GPS, no
  arrows. Just a narrow gravel road, dense low-poly forest, mud on the windscreen and a co-driver yelling.
- **The Navigator** holds a *physical* navigation tablet that rattles around the cabin. It shows a
  heading-up map, the next turn, the distance and the route, but it's a real physics object. Hard corners
  drain your grip, crashes knock it out of your hands, and it can slide into the driver's footwell.

Built with **Vite + TypeScript + Three.js + Rapier 3D + Socket.IO (Node.js) + WebRTC**. Everything (models,
textures, sounds) is procedural, so no assets need to be imported.

---

## Quick start

Requirements: **Node.js 20.19+** (22 LTS recommended) and a modern Chromium browser (Chrome / Edge).
Firefox also works.

```bash
npm install
npm run dev
```

`npm run dev` starts both processes:

| Process | URL | Notes |
| --- | --- | --- |
| Vite client | http://localhost:5173 | open this in the browser |
| Game server (Socket.IO) | http://localhost:3001 | Vite proxies `/socket.io` and `/health` to it |

The main menu shows **"Game server online"** when the client can reach the server. If the server is not
running, online buttons are disabled and the menu says so. Offline modes still work.

### Production build

```bash
npm run build     # typecheck (client + server) -> vite build -> bundle server with esbuild
npm start         # node dist-server/index.js: serves dist/ and Socket.IO on GAME_PORT (default 3001)
```

Then open http://localhost:3001. To host for a friend over the internet, run `npm start` on a reachable
machine (or behind a reverse proxy with WebSocket support) and share the URL.

### Deploying

Static hosts like **GitHub Pages, Netlify, Vercel or Cloudflare Pages can only serve the client**. They
cannot run the Socket.IO game server (it needs a long-running Node.js process holding WebSocket
connections), so online play shows "Game server offline" there. Offline modes still work.

**Option A: Render only (simplest).** On [Render](https://render.com) use *New > Blueprint* and pick
your repo; the included `render.yaml` builds and serves the whole game (client + multiplayer) from one URL.
No other configuration is needed. (Any Node host with WebSocket support works the same way: build
`npm ci --include=dev && npm run build`, start `npm start`; the server listens on the host's `PORT`.)

**Option B: GitHub Pages (client) + Render (game server).**
1. Push the repo to GitHub and deploy the server on Render as in option A. Note its URL, e.g.
   `https://left-left-left-server.onrender.com`.
2. On Render, set the service's environment variable `CORS_ORIGIN` to your Pages origin, e.g.
   `https://your-name.github.io` (no path, no trailing slash).
3. On GitHub: *Settings > Secrets and variables > Actions > Variables*, add `VITE_SERVER_URL` = the Render
   URL.
4. On GitHub: *Settings > Pages > Source: GitHub Actions*. The included workflow
   (`.github/workflows/pages.yml`) builds and publishes on every push to `main`; run it once manually
   (*Actions > Deploy to GitHub Pages > Run workflow*) after adding the variable.
5. Open `https://your-name.github.io/leftleftleft/`: the menu should say **Game server online**.

The build uses relative asset paths, so it works both at a domain root and in a Pages sub-folder.

**Option C: Netlify (client) + Render (game server).**
1. Deploy the server on Render as in option A.
2. On Render set `CORS_ORIGIN` to your Netlify URL, e.g. `https://my-rally.netlify.app`.
3. In Netlify set the environment variable `VITE_SERVER_URL` to the server URL (e.g.
   `https://left-left-left-server.onrender.com`) and **redeploy**. Vite bakes it into the bundle at build
   time, so dragging an old `dist/` folder onto Netlify won't pick it up. Build with
   `VITE_SERVER_URL=... npm run build:client` before uploading, or let Netlify build from the repo (the
   included `netlify.toml` does that).
4. Open the Netlify site: the menu should say **Game server online**.

Free server tiers (e.g. Render free) sleep when idle; the first visit can take ~30-60 s while the server
wakes up. Reload the menu once it's up.

### Configuration

Copy `.env.example` to `.env` to override defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GAME_PORT` | `3001` | Port of the game server (also serves the production build). In production `PORT` (set by hosting platforms) is used when `GAME_PORT` is not set |
| `CLIENT_PORT` | `5173` | Vite dev server port |
| `CORS_ORIGIN` | `*` | Allowed origins (comma separated) when the client is served from another origin, e.g. your Netlify URL |
| `RECONNECT_GRACE_SECONDS` | `60` | How long a disconnected player's seat is kept |
| `VITE_SERVER_URL` | (empty) | Client connects to this server instead of its own origin |
| `VITE_STUN_URLS` | Google STUN | Comma-separated STUN/TURN URLs for built-in voice chat |

> The server uses `GAME_PORT` (not `PORT`) on purpose: many tools set `PORT` for the web dev server, and
> the two would collide.

---

## Testing with two browser windows (one computer)

1. Run `npm run dev`.
2. Open **two separate browser windows** (not tabs) at http://localhost:5173 and place them side by side.
   Browsers throttle background tabs, so separate windows keep both games running smoothly. (If a tab is
   backgrounded anyway, the game falls back to a ~10 Hz timer loop so the shared car keeps moving.)
3. Window A: enter a name → **CREATE ONLINE GAME**. Note the 4-letter room code.
4. Window B: enter a name, type the code → **JOIN WITH CODE**.
5. Roles are auto-assigned (creator = Driver). Swap them by clicking the role buttons if you like.
6. The host can pick the stage length / reroll the road. Both press **READY!**
7. Both clients build the same stage from the shared seed (checksums are verified), then a 3-second
   countdown starts.
8. In the Navigator window press **F** to pick up the tablet, then shout (or press `1`-`0`).

On two computers in the same LAN: open `http://<host-ip>:5173` on the second machine (Vite listens on all
interfaces). For built-in voice chat the page must be a secure context (`https://` or `localhost`), so on a
LAN use Discord or any external voice app instead (the game is designed to work great with it).

### Local / offline modes (no server needed)

- **COUCH CO-OP · SPLIT SCREEN**: both roles on one machine. Left half = driver (WASD), right half =
  navigator (mouse + arrow keys). This is the local development mode; it runs the exact same server
  authority code in-process.
- **SOLO PRACTICE**: you drive while an AI co-driver holds the tablet and reads pace notes computed from the
  real road. It drops the tablet in crashes too, and goes quiet until it picks it back up.

### Reconnecting

Refreshing the page or losing the connection mid-stage pauses the race for both players (the stage clock
stops). The menu offers **REJOIN ROOM XXXX** (the seat token lives in `sessionStorage`), the stage is rebuilt
and the race resumes from the last server-validated car state. Socket.IO also reconnects transparently on
short network drops. After `RECONNECT_GRACE_SECONDS` the seat is released and the room returns to the lobby.

---

## Controls

### Driver
| Key | Action |
| --- | --- |
| `W` / `↑` | Throttle |
| `S` / `↓` | Brake, hold at a standstill to reverse |
| `A` `D` / `←` `→` | Steer (speed-sensitive, rate-limited) |
| `Space` | Handbrake (right hand moves to the lever) |
| `V` | Toggle wipers |
| hold `C` | Wipe the windscreen by hand where you look (one hand off the wheel = less steering) |
| `G` | Close your door if it flew open (left hand reaches for the handle) |
| `H` | Horn |
| `R` | Reset car onto the road (server-validated, 2.5 s cooldown) |
| Mouse (click to capture) | Look around, e.g. glance at the navigator's tablet |
| `Shift`/`E`, `Ctrl`/`Q` | Shift up / down (when *Manual gearbox* is enabled in settings) |
| Gamepad | Left stick steer, triggers throttle/brake, A/RB handbrake, Y reset |

### Navigator
| Key | Action |
| --- | --- |
| Left click | Grab / release the tablet (or any loose object, or the door handle) |
| Mouse move | Move the held tablet in view |
| Mouse wheel | Hold it closer / farther |
| `Q` / `E` | Turn the tablet (e.g. show the screen to the driver!) |
| `Z` / `X` | Tilt the tablet |
| Middle-drag | Rotate the tablet freely |
| `F` (hold to lean) | Pick up the tablet without aiming; leaning extends your reach |
| Hold right mouse | Look around |
| `G` | Close your door |
| `1`-`0` | Shout: LEFT! · LEFT, LEFT, LEFT! · RIGHT! · RIGHT, RIGHT, RIGHT! · BRAKE! · STRAIGHT! · NO, THE OTHER LEFT/RIGHT! · WE MISSED IT! · WHY ARE YOU STILL ACCELERATING?! · JUMP! |
| `Space` | Read the next pace note aloud (only if you can actually see the tablet) |
| `T` | Push-to-talk (if enabled for built-in voice chat) |

`Esc` pauses (offline) / opens the menu (online, where the stage keeps running), `F1` toggles the control
hints. Split screen: the driver uses `WASD` + `Q`/`E` to glance, the navigator uses the arrow keys instead of
Q/E/Z/X and `Enter` to read a note.

---

## Features (implemented)

### Driving
- Custom **raycast vehicle** on a Rapier rigid body: per-wheel spring/damper suspension with bump stops,
  anti-roll bars, slip-angle tyre model with a friction circle, **front-wheel drive** (wheelspin and
  understeer under power), weight transfer, lift-off/braking oversteer, **handbrake turns**, rolling resistance
  and aero drag.
- Surfaces: loose gravel road, grass (less grip, more drag), **mud puddles** (very slippery).
- Engine torque curve, 5-speed automatic (or manual) gearbox with visible shift pauses, reverse logic, rev
  limiter, engine braking.
- Speed-sensitive, rate-limited steering. Steering authority drops while a hand is off the wheel.
- Collisions with trees, rocks, gates, terrain and **dynamic hay bales** (knocked around and synced).
  Impacts are measured from contact forces; landings after jumps are detected separately.
- Fixed 60 Hz physics timestep with accumulator, max-steps clamp, and render interpolation.
- Server-validated reset (`R`), automatic reset when flipped for 5 s or lost far off the route.

### Cockpit
- Procedural interior: angular orange-red dash, analogue speedo/tach (canvas texture) with warning lights,
  rotating steering wheel, H-pattern gear lever, handbrake, animated pedals, bucket seats, roll cage,
  pillars, sun visors, pine-tree air freshener on a spring, hood visible through the windscreen.
- **Real mirrors**: one wide backwards render feeds the rear-view and both side mirrors.
- Driver and passenger **IK arms** with polygonal gloved hands: on the wheel (rotating with it), on the gear
  knob during shifts, on the handbrake, wiping the glass, reaching for door handles, holding the tablet by its
  edges. Each occupant has a helmeted head/torso visible to the *other* player.
- **Spring-damper cabin motion** (no random shake): leaning in corners, pushed back on acceleration, nodding
  on braking, bouncing over bumps, sharp directional jolts on impacts and heavy landings.

### Navigation tablet
- A rugged 3D tablet with orange bumpers; the screen is a live canvas texture (20 fps): heading-up map,
  route line, passed road, turn markers coloured by severity, checkpoints, jumps, puddles, finish, the car,
  next instruction + distance, "then / into" chains, STRAIGHT FOR 100, BRAKE NOW!, JUMP ahead, WRONG WAY,
  TURN MISSED, progress bar, stage time and checkpoint counter.
- Simulated in a separate **car-local Rapier world** whose gravity is *(g − car acceleration)*, so cornering,
  braking, bumps, crashes (impulse shocks) and jumps (weightless) move everything realistically without
  tunnelling through a fast-moving car.
- Grab / hold (velocity-driven constraint, so it never teleports through the cabin), move, rotate, tilt,
  closer/farther, release, **drop on impacts or when grip runs out under sustained g-forces**, slide across
  the dash / seats / floor, pick up again (reach limit, lean to reach further).
- Detects when the screen faces away from the navigator or is out of view (HUD warning; pace-note reading
  disabled). The driver can only see route info if the tablet is physically visible from their seat.

### Stages & navigation
- Deterministic procedural stages from a seed (identical on server and clients, verified by checksum):
  clothoid-smoothed corners (easy → hairpin, chicanes), straights, self-intersection avoidance, elevation from
  terrain noise with grade limits, **jumps**, camber, crown, bumps and potholes, ditches and embankments,
  dense instanced vegetation, rocks, marker posts, hay bales, checkpoints, start/finish gates.
- Corner analysis from the real curvature: KEEP / EASY / (medium) / HARD / HAIRPIN LEFT/RIGHT with target
  speeds, "into" chains, braking-distance based BRAKE NOW, jump warnings.
- Race tracking: checkpoints (+10 s penalty if skipped), missed turns, wrong way, finish, odometer, top
  speed. Results: time, penalties, distance, crashes, missed turns, checkpoints, tablet drops, average/top
  speed, grade (S-D) and a team title.

### Cabin chaos
- **Mud**: puddles splatter the windscreen (deterministic procedural splats, same on both screens); off-road
  driving and terrain impacts add dirt. **Wipers** clear only their arcs over a few passes; **hand-wipe** with
  `C` cleans where you look but takes a hand off the wheel.
- **Doors**: latched doors rattle on rough ground; hard (side) impacts or long rough off-road stretches can
  unlatch them (decided by the server). Open doors swing on a hinge sim with limits, driven by g-forces and
  airflow, bang against their stops, add drag + yaw pull and wind roar until closed.
- **Loose objects**: water bottle, coffee cup on the dash, pace-note book, snack bag; all thrown around by the
  cabin physics, with rattle sounds.

### Multiplayer
- Node.js + Socket.IO rooms with 4-letter codes, lobby with role selection, ready states, host stage
  settings, loading sync with stage checksum, countdown, start/finish/restart (both vote: retry / new road)
  and back-to-lobby.
- **Server-authoritative game rules** (`src/shared/authority/GameAuthority.ts`, also used by the offline
  session): role validation, session membership, rate limits, car-state validation (finite values, speed
  cap, max displacement per time, world bounds, countdown hold) with corrections, server-issued resets,
  checkpoint/turn/finish tracking, race clock, crash counting, impact plausibility checks, door/mud
  decisions, tablet ownership, cabin-bounds clamping, callout validation.
- Compact binary snapshots (`Float32Array`): car at 30 Hz, cabin (tablet + 4 objects) at 20 Hz, hay bales at
  10 Hz only while moving. Remote state goes through a jitter buffer with clock-offset estimation, Hermite
  position interpolation and quaternion slerp.
- Disconnect pause, reconnection with seat tokens, transparent Socket.IO reconnects, clear connection status
  in menu/lobby/HUD.
- Optional **WebRTC voice chat** (perfect-negotiation signalling over Socket.IO, mute, push-to-talk, mic
  meter).
- Callouts: navigator hotkeys, pace-note reading, contextual automatic reactions decided by the server
  ("NO, THE OTHER LEFT!" when the driver steers the wrong way right after a call, "WHY ARE YOU STILL
  ACCELERATING?!", "WE MISSED IT!", "WRONG WAY!", "I DROPPED THE TABLET!", "OUCH!") with cooldowns, shown as
  subtitles and spoken with text-to-speech (toggleable).

### Audio (all procedural WebAudio)
Engine (pitch from RPM, load-dependent filter, rev limiter stutter, overrun crackle), road rumble, gravel
pings, tyre scrub/squeal, wind (louder with open doors), wipers motor + squeak, horn, impacts scaled by
strength and panned to the hit side, suspension thumps, tablet/object clacks, door rattles/bangs/slams,
splashes, bush rustle, UI clicks, countdown beeps, checkpoint chime. Independent volumes: master, engine,
environment, collisions, voice, interface.

### UI
Main menu, create/join, lobby, loading screen, HUD (minimal for the driver: speed, gear, time, checkpoint
count, warnings; navigator: grip meter, tablet visibility, hover hints), subtitles, toasts, pause menu with
full controls reference, settings (volumes, sensitivity, FOV, cabin motion intensity, quality, TTS,
subtitles, auto callouts, manual gearbox, push-to-talk, FPS), help screen, results. WebGL-unavailable error
screen. Handles resizing, split screen, focus loss (offline modes auto-pause when hidden).

---

## Project structure

```
server/                 Node.js game server
  index.ts              HTTP + Socket.IO + static hosting of dist/
  rooms/                Room (lobby, phases, reconnection), RoomManager
  networking/           Socket event handlers (rate limits, payload checks)
  validation/           Input sanitisation, rate limiter
src/
  shared/               Code shared by server and client (pure TypeScript)
    stage/              Stage generator, terrain base, pace-note analysis
    race/               Road locator, race tracker
    authority/          GameAuthority: server-authoritative rules
    protocol.ts         Typed Socket.IO events
    snapshot.ts         Binary snapshot layouts
  core/                 App flow, input, settings, event bus
  rendering/            Renderer (split screen), sky/lighting, materials, particles, geometry helpers
  physics/              Rapier world wrapper, car-local cabin physics
  vehicle/              Raycast vehicle controller, drivetrain, car spec, exterior model
  cockpit/              Interior, gauges, occupants/IK arms, cabin motion, doors, windshield/mud/wipers
  world/                Terrain field, chunked terrain, road, vegetation, props (gates, hay bales)
  navigation/           Minimap (tablet screen), callouts + AI co-driver
  tablet/               Tablet model, loose object definitions
  interactions/         Driver and navigator controls
  multiplayer/          Session interface, local/online sessions, snapshot interpolation, voice chat
  audio/                Audio engine and car sounds
  game/                 Game orchestration, seat camera rigs, car render state
  ui/                   DOM UI and styles
scripts/                Headless test harnesses (see below)
public/assets/          Favicon
```

## Automated checks

```bash
npm run typecheck                 # strict TypeScript for client and server
npm test                          # sim-test + cabin-test below
npx tsx scripts/sim-test.ts 42    # headless: autopilot drives a whole stage through the real physics
npx tsx scripts/cabin-test.ts     # headless: tablet/objects under cornering, impacts, braking, jumps
npm run test:net                  # end-to-end multiplayer protocol test (needs a running server)
```

`net-test` connects two Socket.IO clients and checks room creation/joining, sanitisation, full rooms, role
and host rules, load/countdown sync, car-state relay, role enforcement, teleport rejection + correction,
callout authorisation, resets, impact-driven door pops, disconnect pause, seat-token reconnection and token
hijack protection.

---

## Known limitations

- **Authority model:** the driver's client simulates the car (zero input latency) and the navigator's client
  simulates the cabin; the server validates and owns all game rules, timing and chaos events but does not
  re-simulate rigid-body physics. A modified client could still drive "plausibly fast" within the
  validation limits. Running Rapier on the server with client-side prediction would close that gap at the
  cost of complexity.
- **Background tabs:** browsers throttle hidden tabs. The game keeps simulating at a reduced rate, but the
  smooth experience needs both game windows visible. Offline modes auto-pause when hidden.
- **Voice chat** needs a secure context (`https://` or `localhost`) and uses public STUN only; peers behind
  strict NATs need a TURN server (`VITE_STUN_URLS` accepts TURN URLs). Discord or similar works everywhere.
- Text-to-speech voices depend on the browser/OS; it can be disabled in settings.
- Remote hay bales and loose objects are interpolated from snapshots (cosmetically smooth, not physically
  re-simulated on the receiving side).
- Rooms live in server memory: restarting the server ends running sessions.
- Steering wheel rotation is visually clamped (no hand-over-hand animation).
- Desktop only (keyboard + mouse or gamepad); touch input is not supported.
