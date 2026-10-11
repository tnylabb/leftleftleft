# LEFT! LEFT! LEFT!

**DRIVE BLIND. NAVIGATE LOUD. SURVIVE THE CABIN.**

An asymmetrical two-player co-op rally game for the desktop browser. Two players share one faded
orange-red hatchback:

- **The Driver** sits behind a real steering wheel in a first-person cockpit. No minimap, no GPS, no
  arrows. Just a narrow gravel road, dense low-poly forest, mud on the windscreen and a co-driver yelling.
- **The Navigator** holds a *physical* navigation tablet that rattles around the cabin. It shows a
  heading-up map, the next turn, the distance and the route, but it's a real physics object. Hard corners
  drain your grip, crashes knock it out of your hands, and it can slide into the driver's footwell.

Stages run by day or at night. At night the tablet is only readable where the dashboard flashlight's beam
actually falls on it, and that same beam can blind the driver. There's a paper map in the glovebox as a
backup. Get stuck, and you both climb out and haul the car free by its tow hooks.

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
  real road (at night it also holds the flashlight on the tablet). It drops the tablet in crashes too, and
  goes quiet until it picks it back up.

Pick **DAY / NIGHT** in the main menu (local modes) or in the lobby (host, online).

### Reconnecting

Refreshing the page or losing the connection mid-stage pauses the race for both players (the stage clock
stops). The menu offers **REJOIN ROOM XXXX** (the seat token lives in `sessionStorage`), the stage is rebuilt
and the race resumes from the last server-validated car state. Socket.IO also reconnects transparently on
short network drops. After `RECONNECT_GRACE_SECONDS` the seat is released and the room returns to the lobby.

---

## Controls

**Hold `Tab`** in game for a compact overlay listing exactly the controls that work for your role right
now (in the car, holding the map, on foot next to a tow hook…). It doesn't pause the game. All bindings
live in `src/core/Bindings.ts`, and the overlay, pause screen and help screen are generated from it.

### Driver (online / solo)
| Key | Action |
| --- | --- |
| `W` / `↑` | Throttle (automatic gearbox) |
| `S` / `↓` | Brake, hold at a standstill to reverse |
| `A` `D` / `←` `→` | Steer (speed-sensitive, rate-limited) |
| `Space` | Handbrake (right hand moves to the lever) |
| `V` | One wiper sweep (out and back to rest; holding doesn't repeat, press again for another) |
| hold `C` | Wipe the windscreen by hand where you look (one hand off the wheel = less steering) |
| `G` | Close your door if it flew open (left hand reaches for the handle) |
| `H` | Horn |
| `E` | Get out (car stopped) / get back in (standing at your door) |
| hold `R` | Emergency reset onto the road: last resort, +5 s penalty |
| Mouse (click to capture) | Look around, e.g. glance at the navigator's tablet |
| Gamepad | Left stick steer, triggers throttle/brake, A/RB handbrake, hold Y emergency reset |

**On foot:** `WASD` walk, mouse look, `Shift` run, **hold left mouse** next to a tow hook to grip it, then walk
away from the car (e.g. backwards with `S`) to pull; release to let go. `E` at your door gets you back in.

### Navigator (online)
| Key | Action |
| --- | --- |
| Left click | Grab / put down the tablet, the map or a loose object, or click the door handle |
| Mouse move | Move the held object in view |
| Mouse wheel | Hold it closer / farther |
| `←` `→` / `↑` `↓` | Turn / tilt the held object (spin the map) - e.g. show the screen to the driver! |
| Middle-drag | Rotate the held object freely |
| hold `Q` | Pick up the tablet without aiming; leaning extends your reach |
| Hold right mouse | Look around |
| `F` | Take the flashlight from its dashboard clip / put it back |
| `G` | Flashlight on / off |
| `M` | Take the paper map from the glovebox; with the map in hand: fold / unfold it |
| hold `X` | Point with your arm where you look (the driver sees it) |
| `C` | Close your door |
| `E` | Get out (car stopped) / get back in (standing at your door) |
| `1`-`0` | Shout: LEFT! · LEFT, LEFT, LEFT! · RIGHT! · RIGHT, RIGHT, RIGHT! · BRAKE! · STRAIGHT! · NO, THE OTHER LEFT/RIGHT! · WE MISSED IT! · WHY ARE YOU STILL ACCELERATING?! · JUMP! |
| `Space` | Read the next pace note aloud (only if you can actually see the tablet, and at night only in the light) |
| `T` | Push-to-talk (if enabled for built-in voice chat) |

**On foot:** same as the driver: `WASD`, mouse, `Shift`, hold left mouse on a tow hook, `E` at your door.

### Split screen (couch)
No key is shared between the two players:

- **Driver:** `WASD`, `Space` handbrake, `V` wiper sweep, hold `C` hand-wipe, `G` door, `H` horn, hold `Q` glance
  at the tablet, `E` out / in, hold `R` emergency reset. On foot: `W`/`S` walk, `A`/`D` turn, `Left Shift` run,
  hold `Space` grip a tow hook.
- **Navigator:** mouse, arrow keys turn/tilt, hold `Right Shift` pick up / lean, `F` flashlight, `L` light
  on/off, `M` map, hold `X` point, `Enter` read note, `P` out / in. On foot: arrow keys walk, mouse look,
  `Right Ctrl` run, hold left mouse grip a tow hook.

`Esc` pauses (offline) / opens the menu (online, where the stage keeps running).

---

## Features (implemented)

### Driving
- Custom **raycast vehicle** on a Rapier rigid body: per-wheel spring/damper suspension with bump stops,
  anti-roll bars, slip-angle tyre model with a friction circle, rear-biased **all-wheel drive**, weight
  transfer, lift-off/braking oversteer, **handbrake turns** (the handbrake decouples the rear axle), rolling
  resistance and aero drag.
- Fast and twitchy: about 0-100 km/h in 5.2 s and ~158 km/h flat out (headless measurement), on a narrow
  gravel road (5.1 m wide) with tight corners, hairpins, blind crests and trees close to the edge.
- Surfaces: loose gravel road, grass (less grip, more drag), **mud puddles** (very slippery).
- Engine torque curve, **5-speed automatic gearbox only**, with launch slip, rpm-based downshifts, reverse logic, rev
  limiter and engine braking.
- Speed-sensitive, rate-limited steering. Steering authority drops while a hand is off the wheel.
- Collisions with trees, rocks, gates, terrain and **dynamic hay bales** (knocked around and synced).
  Impacts are measured from contact forces; landings after jumps are detected separately.
- Fixed 60 Hz physics timestep with accumulator, max-steps clamp, and render interpolation.
- Emergency reset (hold `R`, +5 s, server-validated); automatic reset only after 6 s upside down or when
  lost far off the route.

### Cockpit
- Procedural interior: angular orange-red dash, analogue speedo/tach (canvas texture) with warning lights,
  rotating steering wheel, gear selector, handbrake, animated pedals, bucket seats, roll cage, pillars,
  sun visors, pine-tree air freshener on a spring, hood visible through the windscreen.
- **Real mirrors**: one wide backwards render feeds the rear-view and both side mirrors.
- Driver and passenger **IK arms** with polygonal gloved hands: on the wheel (rotating with it), on the
  handbrake, wiping the glass, reaching for door handles, holding the tablet / map by its edges, holding the
  flashlight, pointing. Each occupant has a helmeted head/torso visible to the *other* player.
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
  driving and terrain impacts add dirt. **Wipers are manual and off by default**: each `V` press runs exactly
  one sweep out and back to the rest position (a press during the return stroke queues one more), synced to
  both players through the authority; the glass is cleaned only where the blades actually pass, as they
  pass. **Hand-wipe** with `C` cleans where you look but takes a hand off the wheel.
- **Doors**: latched doors rattle on rough ground; hard (side) impacts or long rough off-road stretches can
  unlatch them (decided by the server). Open doors swing on a hinge sim with limits, driven by g-forces and
  airflow, bang against their stops, add drag + yaw pull and wind roar until closed.
- **Loose objects**: water bottle, coffee cup on the dash, pace-note book, snack bag; all thrown around by the
  cabin physics, with rattle sounds.

### Night stages & the flashlight
- At night only the headlights, the moon and a **real 3D flashlight** light the world. It lives in a clip on
  the passenger side of the dash (a kinematic body riding with the car); the navigator takes it out (`F`),
  holds it in the right hand, aims it, switches it (`G`) and clips it back. Dropped, it's a physics object
  like everything else.
- Its spotlight follows the flashlight body's actual position and direction and lights the tablet, the
  map, the cabin and the road. Night shadows are on.
- The tablet has a **non-backlit (transflective) screen**: at night it has no glow at all, so it's readable
  only where the beam lands on it. Pace-note reading and the AI co-driver use the same rule: the
  flashlight's cone, distance falloff and screen angle must deliver enough light to the screen. By day the
  flashlight isn't needed.
- Holding the tablet and the flashlight at once means a one-handed grip (drains faster under g-forces).
- **Blinding:** if the beam hits the driver's eyes (within the cone, within 2.6 m, with clear line of sight
  past the cockpit, tablet, map, loose objects and the navigator's body), the *driver's* view flashes white
  and fades over about a second. Only the driver's screen is affected. It re-arms after the beam has been
  away for 0.5 s (and at most every 1.2 s).

### Paper map (backup)
- A folded rally map lives in the closed glovebox. `M` takes it out (it becomes a physics object in the
  hand, can be put down, slides around, can be picked up again), `M` again unfolds / folds it (the collider
  changes size too), the arrow keys spin it in its own plane, the mouse wheel holds it closer.
- It's drawn from the real stage: north-up route, numbered corners coded by severity and direction,
  checkpoints, start / finish, jumps, puddles and hay-bale landmarks, contour lines.
- Unfolded it covers most of your view, and at speed it flaps around and is much harder to hold. At night
  you need the flashlight to read it. The driver never gets a map overlay.

### Pointing
- Hold `X`: the navigator's right arm points where they're looking, stopping short of the dash, roof and door
  (no clipping or stretching). Release and it returns. It has priority over holding the flashlight (the
  torch beam then follows the finger) and works while the other hand holds the tablet or map.
- The driver sees it in the shared 3D cabin. Online, the exact hand target is synced in the cabin snapshot.
  There are no arrows or HUD hints for the driver.

### Getting stuck, getting out, pulling the car free
- The authority flags **STUCK** only when the driver is pressing a pedal and the car still doesn't move for
  4 s, so normal stops never count. Then the HUD suggests getting out. The emergency reset (hold `R`, +5 s)
  stays a separate last resort.
- `E` (split screen: driver `E`, navigator `P`) gets you out once the car has (almost) stopped. Seats are
  server-owned. You stand next to your door in a first-person on-foot camera, walk with collision against
  the car body, trees and boulders, and follow the terrain. The other player sees your low-poly avatar.
- Tow hooks front and rear: hold the grip button next to one, then walk away (e.g. backwards). The arm is
  taut at arm's length, so walking away turns into a **pull force on the car's rigid body** at the hook
  (up to 1500 N per player, slightly upwards). Both players' forces are applied to the same vehicle
  simulation and add up. Release and the force stops.
- An empty car sits in neutral on its brakes, which are released only while someone is pulling. Terrain,
  slope, mass and the car's angle all matter: one player can't drag the 980 kg car up a 12° bank, two
  can (see `scripts/recovery-test.ts`). No teleporting, no scripted movement.
- Back at your door, `E` gets you back into your own seat.

### Stage finish
- Crossing the finish line (the authority's race event, so it's the same moment on both clients and can
  only fire once) starts a cinematic: the car keeps rolling, steering along the road and braking gently,
  while the camera eases out of your eyes into a slow chase shot around the car (a spring arm pulls in when
  trees or terrain would block it). Letterbox bars, **STAGE COMPLETE** with your time and a short
  synthesised fanfare + crowd cheer. The results screen follows after 4.2 s. The physics timestep is never
  changed.

### Multiplayer
- Node.js + Socket.IO rooms with 4-letter codes, lobby with role selection, ready states, host stage
  settings, loading sync with stage checksum, countdown, start/finish/restart (both vote: retry / new road)
  and back-to-lobby.
- **Server-authoritative game rules** (`src/shared/authority/GameAuthority.ts`, also used by the offline
  session): role validation, session membership, rate limits, car-state validation (finite values, speed
  cap, max displacement per time, world bounds, countdown hold) with corrections, server-issued resets,
  checkpoint/turn/finish tracking, race clock, crash counting, impact plausibility checks, door/mud
  decisions, tablet ownership, cabin-bounds clamping, callout validation.
- Compact binary snapshots (`Float32Array`): car (+ driver on foot) at 30 Hz, cabin (tablet, 4 loose objects,
  flashlight, paper map, held object, flashlight/map/pointing flags, navigator on foot + pull force) at 20 Hz,
  hay bales at 10 Hz only while moving. Wiper sweeps, seat changes (get out / in) and the finish are
  authority events. The server sanitises on-foot positions, rejects tow-hook grips from too far away and
  clamps pull forces. Remote state goes through a jitter buffer with clock-offset estimation, Hermite
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
splashes, bush rustle, UI clicks, countdown beeps, checkpoint chime, finish fanfare + crowd cheer. Independent volumes: master, engine,
environment, collisions, voice, interface.

### UI
Main menu (with DAY / NIGHT), create/join, lobby, loading screen, HUD (minimal for the driver: speed, gear,
time, checkpoint count, warnings; navigator: grip meter, tablet visibility / darkness, hover hints; on foot:
tow-hook and door prompts, pull strength), hold-`Tab` controls overlay, finish cinematic, subtitles,
toasts, pause menu with full controls reference, settings (volumes, sensitivity, FOV, cabin motion
intensity, quality, TTS, subtitles, auto callouts, push-to-talk, FPS), help screen, results. WebGL-unavailable error
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
  core/                 App flow, input, key bindings (single source of truth), settings, event bus
  rendering/            Renderer (split screen), sky/lighting, materials, particles, geometry helpers
  physics/              Rapier world wrapper, car-local cabin physics
  vehicle/              Raycast vehicle controller, drivetrain, car spec, exterior model
  cockpit/              Interior, gauges, occupants/IK arms, cabin motion, doors, windshield/mud/wipers,
                        dashboard flashlight
  world/                Terrain field, chunked terrain, road, vegetation, props (gates, hay bales)
  navigation/           Minimap (tablet screen), callouts + AI co-driver
  tablet/               Tablet model, paper map, loose object / flashlight / map definitions
  interactions/         Driver and navigator controls
  multiplayer/          Session interface, local/online sessions, snapshot interpolation, voice chat
  audio/                Audio engine and car sounds
  game/                 Game orchestration, seat camera rigs, car render state, on-foot players,
                        finish cinematic
  ui/                   DOM UI and styles, controls overlay rows
scripts/                Headless test harnesses (see below)
public/assets/          Favicon
```

## Automated checks

```bash
npm run typecheck                    # strict TypeScript for client and server
npm test                             # sim-test + cabin-test + recovery-test below
npx tsx scripts/sim-test.ts 42       # headless: autopilot drives a whole stage through the real physics
npx tsx scripts/cabin-test.ts        # headless: tablet/objects under g-forces + flashlight clip + paper map
npx tsx scripts/recovery-test.ts     # headless: car in a ditch, one vs two players pulling on the tow hook
npm run test:net                     # end-to-end multiplayer protocol test (needs a running server)
```

`net-test` connects two Socket.IO clients and checks room creation/joining, sanitisation, full rooms, role
and host rules, load/countdown sync, car-state relay, role enforcement, teleport rejection + correction,
callout authorisation, resets, manual wiper cycles (one per press, driver only, relayed to both), getting
out only when stopped, server-owned seat flags, tow-hook grip / pull-force validation, getting back in only
at your own door, impact-driven door pops, disconnect pause, seat-token reconnection and token hijack
protection.

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
- Desktop only (keyboard + mouse or gamepad); touch input is not supported. On-foot movement and the
  navigator's interactions are keyboard + mouse only (the gamepad drives the car).
- **Recovery:** the pull force comes from the walking player, who is tethered to the hook at arm's length;
  there's no rope or winch, and players can only pull, not push. Players don't collide with each other or
  with hay bales. Online, the navigator's pull reaches the driver's car simulation through the 20 Hz cabin
  snapshot, so it lags by the snapshot delay (about 100-150 ms).
- **Night readability** for gameplay (reading notes, the AI co-driver, the HUD warning) uses the
  flashlight's analytic cone/falloff, not the rendered pixels, so a hand shadowing part of the screen
  doesn't affect it. The **blinding** check targets the driver's eye point; the driver's own arms and the
  steering wheel rim don't block the beam.
- When the navigator holds the tablet and the flashlight together, the beam automatically aims at the
  tablet (the hand holding it follows the cursor anyway). To shine it elsewhere, put the tablet down.
- The finish cinematic camera avoids trees, boulders and terrain, but bushes can briefly cross the shot.
  Most stages have ~90 m of straight road after the finish line. A few seeds have only ~30 m, and the car
  then rolls off the end onto the verge.
