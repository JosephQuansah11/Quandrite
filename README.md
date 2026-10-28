# Quandrite

A communication tool like WhatsApp and Zoom combined - chat, group calls and
screen sharing - with a full livestreaming studio built in. One program feed is
encoded once and pushed to YouTube, Facebook, X/Twitter, TikTok and any custom
RTMP endpoint at the same time, while several cameras (including Bluetooth
paired ones) are composited together, overlays are added on the fly, and the
whole broadcast is recorded for later.

```
browser compositor ──WebM──▶ WebSocket ──▶ ffmpeg (encode once) ──tee──▶ YouTube
   cameras + screen                            │                        Facebook
   overlays + audio mix                        │                        X / TikTok
   LIVE / REC badges                           └──▶ recording (.mp4)
```

## What it does

| Requirement | How Quandrite delivers it |
| --- | --- |
| Chat like WhatsApp | Room chat with history, presence and system messages (`server/studio.js`, chat panel in `public/index.html`) |
| Meetings like Zoom | Peer-to-peer WebRTC mesh with mute, camera toggle and screen share with sound (`public/js/webrtc.js`) |
| Livestream to several platforms at once | Single ffmpeg encode fanned out with the `tee` muxer to every enabled destination (`server/ffmpeg.js`, `server/relay.js`) |
| YouTube, Facebook, Twitter/X, TikTok | Built-in ingest catalogue with per-platform stream key handling (`shared/destinations.js`) |
| Share screen *and* its sound | `getDisplayMedia({ audio: true })`, mixed into the program audio (`public/js/devices.js`, `public/js/compositor.js`) |
| Record the video for later | The recording is a `tee` slave of the same encode - no second encode, no extra CPU (`server/studio.js`) |
| Several cameras on one machine | The `Cameras & screens` pop-up lists every camera and microphone with a tick box and sends the selection to the studio, the grid or straight on air (`public/js/app.js`, `public/js/devices.js`) |
| People view like Zoom | Every row in the *People* tab has mic and camera controls: your own switch your media, the host's also mute and stop video for anyone, plus *Mute all* / *Stop all video* (`server/signaling.js`) |
| Cameras connected over Bluetooth | Web Bluetooth pairing assist, then a poll for the newly exposed camera and automatic attach of it (see note below) |
| Everyone can see who joined | The *People* tab lists host, co-hosts, viewers and visitors with roles and per-person host actions (`public/js/app.js`) |
| Roles protected by passwords | Host and co-host seats are claimed with a room password; the host grants co-hosts without one and can rotate the passwords (`server/studio.js`) |
| Breakout rooms | Split the room into up to 8 sub-rooms with their own chat and call, assign or shuffle the groups, open/close them (optionally on a timer) and message every room at once (`server/studio.js`, `server/signaling.js`) |
| See all cameras together | Grid program mode composites every selected camera into one picture (`shared/layout.js`) |
| See everyone who joined | An *In this room* strip on the stage shows every participant of the room you are in, live video included, for every role (`public/js/app.js`) |
| Program preview, and a grid preview for the studio | Every role sees the program output (the canvas that goes out); the host and co-hosts additionally get a *Grid preview* pane showing the multi-camera arrangement, and clicking a tile puts it on air (`public/js/app.js`, `shared/layout.js`) |
| Participants in the program | The host/co-hosts announce each participant's call video as a virtual source, so the grid carries them and any one can be put on air (`public/js/devices.js`, `server/studio.js`) |
| Primary stream plus view switching | Program modes `single` / `grid` / `screenshare`; click "air" on any tile to switch what the platforms receive |
| Titles, announcements, screenshare, songs, break, end card | Six scene types with live forms, timed or persistent (`shared/overlays.js`) |

## Quick start

```bash
npm install          # express, ws, a bundled ffmpeg binary and TypeScript
npm start            # builds the client, then serves http://localhost:8080
```

Open the page, enter a name, a room code and (when claiming a seat) the role
password, then press **Join**. The first person in a room becomes the host and
can drive the broadcast; co-hosts can too; viewers and visitors can chat and
join the call.

### TypeScript

Everything is TypeScript - `shared/`, `server/`, the browser client and the
tests. The split exists because the two runtimes need different things:

| Where | How it runs | Command |
| --- | --- | --- |
| `server/`, `shared/`, `test/` | Node strips the types at load time, so the sources run directly (imports use `.ts`) | `npm start`, `npm test` |
| `public/js/` (browser) | compiled to `build/public/js/*.js`, with `shared/` compiled to `build/shared/*.js` | `npm run build` |

`npm start` and `npm test` build the client first (`prestart` / `pretest`), and
`npm run typecheck` type-checks the server, the shared contracts and the tests.
`shared/` is loaded by the server at start-up **and** compiled into the browser
bundle, so a change there needs both: `npm run dev` restarts the server for you
(`node --watch` follows the imports) and rebuilds the client; with `npm start`
press *Ctrl-C* and start it again, or the running server keeps the old copy of
the shared module in memory.
The domain contracts (`Member`, `Source`, `Program`, `BreakoutCatalogue`,
`RoomSnapshot`, ...) live in `shared/protocol.ts` and are used by both sides.
The client is converted file by file: its types are still being filled in and the
build emits it regardless (`noCheck`), so the browser bundle is never blocked by
the migration. The browser only ever sees `build/`; TypeScript sources are never
served.

### The host password by email

Room passwords can be mailed instead of only shown on screen:

```bash
QUANDRITE_SMTP_URL=smtp://user:pass@smtp.example.com:587   # or
QUANDRITE_MAIL_WEBHOOK=https://hooks.example.com/mail      # a JSON POST
QUANDRITE_MAIL_FROM='Quandrite <studio@example.com>'
QUANDRITE_PUBLIC_URL=https://studio.example.com            # used for the join link
```

- `POST /api/rooms` with `hostEmail` creates the room **and** mails the host and
  co-host passwords; the response reports `mail.ok`.
- The *People* tab has an **Email me the password** control for the host, backed
  by `POST /api/rooms/:id/invite` - which only mails a password the caller has
  just proved it knows.
- Neither transport needs a dependency: the SMTP client is written against
  `node:net` / `node:tls` (STARTTLS, or implicit TLS on 465) and the webhook is a
  plain `fetch`. With no transport configured the mailer reports itself disabled,
  the UI hides the control, and `send()` returns `{ ok: false }` instead of
  throwing: creating a room never depends on a mail server being reachable.

### Live updates (no refreshing)

Everything the UI shows is pushed: chat, roster and roles, sources, the program,
scenes, destinations, stream and recording state, breakouts, requests to be
shown and the **recording library** (`recordings:update` the moment a recording
is finalised or deleted, so the Library tab is always current). The page also
**re-joins the room by itself** if the connection drops instead of asking for a
reload: the join parameters are kept in memory and replayed on reconnect, and a
host that proves the host password takes the seat back.

A socket that drops is never silent: a banner across the top says what happened
and carries a **Retry now** button, the connection pill turns to `reconnecting`,
and the join bar keeps the room, name and role so **Rejoin the room** is one click.
`Leave` empties the client (media included) without a page reload, so another
room can be joined straight away. The server pings every open socket and drops
the ones that stop answering, so a closed tab never lingers in the roster as a
ghost member holding a seat.

### Roles and passwords

| Role | How you get it | What you can do |
| --- | --- | --- |
| **Host** | The host password, or the very first person in a brand new room. Exactly one at a time - the host hands the seat over from the *People* tab. | Everything: cameras, screens, program switching, overlays, platforms, going live, promoting people, rotating the passwords |
| **Co-host** | The host promotes you from the *People* tab (no password), or you claim the seat yourself with the co-host password. Several people can hold it. | The same studio controls as the host, but no role or password changes |
| **Viewer** | Just join - no password | Watch the program preview, chat and join the meeting call |
| **Visitor** | Just join - no password | Same as a viewer |

The *People* tab lists everyone in the room with their role, and gives the host
one-click **co-host / viewer / host** buttons plus the room passwords to copy and
rotate. Passwords are never part of the room snapshot that is broadcast: the
host is the only client that receives them. A room with no password configured
generates its own on creation; `POST /api/rooms` hands the generated pair to the
caller.

**A host that joins a room whose seat is not protected yet gets a password page on
the way in.** The server always generates a password, but until one is *required*
the bootstrap rule stands: the first person into an empty room becomes the host.
So the join form leads to **Protect the host seat** - its own page, not a dialog
over the studio - with a readable suggestion (`amber-cedar-4821`), a **New
suggestion** button and **Save password and enter the room**; *Later - enter the
room* skips it and is remembered per room. Once a host exists the page never
appears again: the password lives inside the room, in the *People* tab, where the
host can read it, share it and **change it** at any time (the save button reads
**Set the room password** until the seat is protected, and **Generate passwords**
fills both fields).

Viewers and visitors never see the camera/screen pane, the program switches, the
overlay forms, the platform setup, the go-live box or the password pane - those
are hidden rather than disabled, and the server refuses the matching messages
anyway.

### Live in five steps

1. **Cameras** - press `Cameras & screens` to open the picker: tick the cameras
   and microphones you want, then choose `Add to studio`, `Add to grid` or `Put
   on air` in the same pop-up. `Share screen` (leave *with sound* ticked for
   system audio) and `Pair Bluetooth` live in the same pane. **The pane stays
   open after each action**, because devices are usually published and placed in
   a row - tick the next one and press again; `Close` when you are done.
2. **Program** - pick `Single camera`, `All cameras` (grid) or `Screen`, and use
   the `air` / `grid` buttons on each tile to choose exactly what goes out.
3. **Overlays** - the *Scenes* tab has Title, Announcement, Screen share, Song,
   Break and End of livestream. Timed scenes clear themselves; the rest stay
   until you press *Clear overlay*.
4. **Platforms** - the *Go live* tab: choose the platform, paste the stream key
   (add a URL override if your regional endpoint differs), press *Add
   destination*. Repeat for every platform you want to hit.
5. **Go live** - pick a quality preset, tick *Record this broadcast*, press
   *Go live*. The badges on the preview show what viewers see.

The *People* tab shows everyone who has joined, and the program preview follows
every change immediately: a camera, a screen share or an overlay appears on the
picture as soon as it is added, without re-joining the room.

### Participants in the program

Everyone in a room sees who else is there: the *In this room* strip on the stage
lists every participant of the room you are in (main room or breakout) with live
video, their role and their mic/camera state, and new arrivals are announced to
the room as they join.

**Turning a camera (or a screen) on publishes it to the whole room** - being "in
the call" is not a prerequisite. The mesh follows the room, not a button: the
moment anyone captures media it is handed to every member of that room, so a
viewer's video shows up in everyone's *In this room* strip, and switching the
camera off puts the avatar back. **A microphone counts as media too**: unmuting
adds one if you have none and publishes it, so the host and the viewers are all
heard by the room. **Screen shares travel the same way**: the sharer announces the
stream it published with the source, so every client attaches that feed under its
own id - a co-host can then put a viewer's screen on the program like any other
source, and it stops cleanly when the share ends (without disturbing that
person's camera).
**Joining a meeting happens on the landing page**, where the microphone, the camera
and *Join call* sit with the form: the two toggles are yours to use before anybody
is in a room, and *Join call* enters the room and joins the call in one press. It is
about being **heard** - it makes sure there is a microphone and turns it on - and it
never reaches for the camera: that is the toggle's business, and a video left off
stays off. *Leave* mutes you and drops a member's meeting camera, while the host
keeps the camera that is on the air.

When a participant's video reaches the host or a co-host, it is registered as a
**virtual source** named after them, so it can be composited like any other
camera:

- `All cameras` (grid) now includes the participants who are in the call.
- The `air` button on their tile puts a single participant on the program.
- A participant who leaves the call drops out of the program automatically, and
  the program falls back to the remaining sources.

Because the feed is a real program source, a participant's audio is mixed into
the program audio too - use headphones so the program does not pick up the room.
Only the host and co-hosts can announce a participant, which is what makes them
part of what goes out.

### Panes that collapse

Every pane carries its own collapse arrow, so the top bar stays free for who you
are, where you are, your state and the way out:

- `V` in the `Program`, `In this room`, `Grid preview` and `Cameras & screens`
  heads collapses that pane down to its header - the arrow stays there, now `>`,
  to bring it straight back.
- `<` in the studio sidebar collapses it to a thin strip (`>` to expand).
- The choice is remembered in the browser, and it is independent of what your role
  is allowed to see (`Grid preview` and `Cameras & screens` are host/co-host panes,
  so viewers and visitors never get them, arrows included).

### Getting in: the landing page

The name, room code, role, password and the join button live on a landing page
*before* you enter a room, and so do the meeting's own controls: a **microphone**
and a **camera** toggle plus **Join call**, as icons with the words in the tooltip.
The toggles are yours whether or not you have joined anything - turning the camera
on previews it locally, and it is announced and published the moment you are in a
room - and *Join call* takes the name, the room and the role from the form, enters
the room and joins the call. The quiet **Join the room** button is the room without
the call. Once you are in, the page gives way to the studio and the top bar carries
only the essentials: your name, the room, `online`, your role and a red **Leave**
with an exit icon. Leaving brings the landing page back, ready for the next room.

A **brand new room has no host yet**, so if you pick *Host* for a room that has
none, the landing page offers to **set the host password** there and then (the
room code is checked as you type). Once a host has been assigned the offer
disappears from the landing page: the password lives inside the room, in the
*People* tab, where the host can read it, share it and **change it** at any time.

### How the room is shown

The *In this room* strip has three views, switchable in its head:

- **Slide** - a filmstrip you scroll sideways (the default for a small room).
- **Grid** - tiles side by side, like the program grid.
- **List** - one row per person with their mic/camera controls. A room with **more
  than 50 people** starts here, because slides and grids stop being readable at
  that size; a smaller room starts on slides and can be switched to the grid.

### Two previews: the program, and the grid

- The **program preview** owns the width of the page and about **90% of the
  view**, with the *In this room* strip directly under it; nothing is ever
  mirrored, so a camera or a shared screen looks the same to everyone. It is the
  output itself - the canvas that is streamed to the platforms and recorded, and
  every role sees it, because that is the picture everyone is watching. Everything
  else lives in the tabbed sidebar (or in the *Grid preview* / *Cameras &
  screens* panes below), each of which can be collapsed and brought back from the
  arrow in its own head.
  The host's picture is sent to the rest of the room over its own WebRTC channel
  (marked `kind: 'program'`), **picture and program audio together**, so every
  participant watches and hears the real program - overlays, countdowns and all -
  in tens of milliseconds, without going near the RTMP relay or its live delay.
  **What travels is the real streaming video**: when a single camera or screen is
  on air, its own track goes out - to the room *and* to the encoder - with no
  canvas in the way; the canvas is used only when something genuinely has to be
  composited (the grid, or an overlay on air). Switching what is on air while live
  re-points the encoder at the new source.
  The pane says `live program` while the received feed is on screen; the meeting
  tiles go quiet then, because the program mix already contains the room (in a
  breakout the room keeps its own audio and the feed is muted, picture only).
- The **grid preview** is a studio tool for the host and co-hosts: it lays the
  cameras, screens and announced participants out exactly like the program grid
  (`All cameras` mode), so you can see the arrangement before it goes out. It
  shows how many tiles are live, marks the ones already on air in green, and
  clicking a tile puts that source straight on air. It only renders while you
  hold a control role and the pane is open - viewers and visitors never get one.

### Announcements with a countdown

The *Announcement* scene takes a **countdown** as well as a message and a
priority: the banner carries the countdown on the right, and it really counts
down (`doors open in 05:00`, then `04:59`, ...) because the picture is redrawn
from the scene's age rather than from the value that was asked for. The same
applies to the *Break* card. **A countdown is a promise to come back**: it is also
the lifetime of the card, so when it reaches zero the scene clears itself and the
program picture resumes - no one has to press *Clear overlay*. The *Scenes* tab
shows the remaining time next to the scene and repaints it once a second, so the
countdown is visible on the program output and in the studio UI at the same time.

### Participants, and being shown

The *People* tab mirrors Zoom's participants panel: a header with the count and
an **Invite** button (copies the join link), one row per person with their
avatar, role, room and mic/camera controls, and a footer with **Unmute me** and
**Claim host** (the room password wins the seat, even if someone else holds it).
Your own mic/camera buttons switch your own media; the host and co-hosts can
switch anyone's, and the target's client applies it at once.

Publishing and placement are immediate, never a two-step:

- **Share** in the top bar opens the *Cameras & screens* **Share tab** of the
  studio sidebar (nothing pops over the room), for **every** role - the host also
  opens it from the *Cameras & screens* pane. It lists every camera and microphone
  the machine exposes, with what is already published marked, and ticks the rest
  for you.
- The picker's three actions follow the role: the host and co-hosts get
  `Add to studio` / `Add to grid` / `Put on air`, while everyone else gets
  `Publish to the room` / `ask for grid` / `ask for air` - publishing always
  reaches the whole room over the mesh, and placing it is a request the host sees
  at once. **Share screen** and **Pair Bluetooth** are open to everyone too.
- **A screen share happens once.** There is one screen of yours at a time: the library
  ends whatever you were sharing before it starts the next one, and the same button
  becomes **Stop sharing** while a share is running, so pressing it again ends it instead
  of opening a second. Ending it stops the capture, which is also what takes the browser's
  own "stop sharing" bar away - nobody has to remember to tidy up.
- `Add to studio` / `Add to grid` / `Put on air` in the **Cameras & screens**
  pane act on the ticked devices - or, if nothing is ticked, on what is already
  published (or the first camera) - then close the pane so the program preview
  shows the result at once.
- A participant's `ask for grid` / `ask for air` reaches the host instantly: a
  toast with **Apply**, a `wants grid` badge on the tile, and a one-click line in
  the *Cameras & screens* pane. The request clears itself once it is on air.
- Switching sidebar tabs paints the panel from the state already in the browser,
  then refreshes anything that comes from the server, so a click never shows a
  stale panel.

### Breakout rooms

**Participants choose their own room.** The host sets the rooms up; where somebody goes is
their own decision, and they are told about it.

For the host (the studio's **Rooms** tab, plus the *…* button on the meeting bar):

1. Pick how many rooms (up to 8) and, optionally, how many minutes they should run for,
   then press **Create**. Everyone except the host is **suggested** a room - a spread the
   picker shows as *"suggested for you"* - and the host stays in the main room so they can
   drop into any of them. **A suggestion moves nobody.**
2. **Rename** a room from its own row (Enter saves, Escape changes nothing): what a room
   is *for* is what the people choosing one need to read. The breakout room's own name
   follows, and the room is told *"Design is now called Build"*.
3. Move people with the room picker next to each name - a host's move **does** move them -
   or press **Shuffle** to re-deal the suggestions.
4. Press **Open all** (or `open` on a single room). This announces the rooms and does not
   take anybody anywhere: the notification says *"Breakout rooms are open - choose a room
   to join"* and clicking it opens the picker. A timer closes the rooms automatically, and
   **Close all** brings everyone home while keeping the groups for next time. **Remove**
   deletes the rooms.
5. **Announce to all rooms** posts a message into the main room and every breakout, so
   nobody misses it.

**The rooms are visible from both places they are used from.** The **Rooms** tab in the
studio is the catalogue - what exists, what is open, who is actually in each one, and a
**Choose a room to join** button - and the **Rooms** button on the meeting bar (with a
badge when there is somewhere to go) opens the same picker. The bar's button is always
there, rooms or not: a way in that only appears once a host has made a room is a way in
nobody knows about, and the picker says what the state of the rooms is either way. The
host's controls - create, open, close, shuffle, remove and *announce to all rooms* - are
inside the tab, gated to the host and co-hosts.

The picker lists the **Main room**, then each room with *who is actually in it* and
whether it is open, plus *"suggested for you"* where the host's spread put you. One click
walks in; the same picker is where the notification points.

**Leaving is one click from wherever you are looking**, which is the point: a participant
in a breakout is usually watching the grid, not the program.

- The **banner** over the stage - *"You are in Breakout 1 - only this room can hear you"*
  with a **Leave this room - back to the main room** button. It floats over the stage
  rather than living inside one view, so it is there in Program, People and Split alike.
- The **location pill** in the top bar (*Breakout 1*) is a button: click it to leave, with
  a tooltip that says so. It is disabled in the main room, where there is nothing to
  leave.
- The **picker's** first row reads *"Leave this room - back to the main room"* while you
  are in one.
- Leaving says so - *"Left Breakout 1 - you are back in the main room"* - and the same
  `breakout:assign` message does the work however it was asked for.

Each breakout is a room of its own: its own chat, its own call, and **its own primary
screen**. The program, the sources and the overlays that belong to the *broadcast* stay
with the parent room, so a host inside a breakout still runs the show from the studio
panes - but the picture on the stage is the one the room is looking at.

- **Sharing into a breakout needs no host.** Inside a breakout, sharing your screen puts
  it on that room's screen, for that room and nobody else: no "ask for air", no
  permission. The stage follows: it shows the room you are standing in, and the parent's
  program feed is not drawn over it.
- **It is a shared table, not a free-for-all.** Anybody in the room may put *their own*
  sources up; moving somebody else's, or changing the mode for the room, needs the host
  or a co-host - the same control that runs the broadcast.
- **It is private.** The parent room never sees a breakout's sources
  (`breakout:sources` / `breakout:program` / `breakout:scene` go to that room only), the
  other breakouts never see them, and nothing shared in a breakout reaches the platforms.
- **Walking out takes it with you.** Leaving a breakout removes your sources from its
  screen, so a room is never left showing a screen whose owner has gone.
- Measured live: a participant walked into *Breakout 1*, shared their screen, and the
  room's own Program view showed that screen while the host's broadcast grid preview
  still read *"not on the grid yet"* - untouched.

Recordings appear in the *Library* tab and under `/recordings/` on disk, with
download links served by the API.

## How multiple cameras and Bluetooth work

`navigator.mediaDevices.enumerateDevices()` lists every video input the
operating system exposes - USB webcams, capture cards, phone-as-webcam apps
(DroidCam, IVCam, Camo), Continuity Camera, and cameras that were paired over
Bluetooth. Quandrite opens a stream per device, keeps one `<video>` decoder per
source, and composites the selected ones into the program picture.

Browsers cannot open a raw video stream straight off a BLE peripheral, so
*Pair Bluetooth* does what a browser legitimately can: it runs the Web Bluetooth
pairing flow, waits for the OS/driver to publish the camera, then re-enumerates
and attaches it automatically. If Web Bluetooth is unavailable, pair the device
in the OS settings and press *Add all cameras* - the result is identical.

## Architecture

```
shared/          pure modules used by both the server and the browser
  protocol.js      message types, roles, scene vocabulary
  overlays.js      overlay validation + the drawing model (scenes -> draw ops)
  layout.js        grid maths and "what is on air" resolution
  destinations.js  platform catalogue, ingest URL building, secret masking
server/
  index.js         express + http + WebSocket wiring, createServer() for tests
  api.js           REST: rooms, capabilities, recording library
  signaling.js     WebSocket protocol, role enforcement, binary program feed
  studio.js        per-room state machine: members, chat, sources, program,
                   scenes, destinations, relay and recording lifecycle
  relay.js         ffmpeg process manager: backpressure, restarts, metrics
  ffmpeg.js        presets, tee spec builder, probe/remux helpers
  recordings.js    recording catalogue, duration probe, finalisation
public/          studio UI (vanilla ES modules, no build step)
test/            node:test suites, including a real-ffmpeg end-to-end run
```

The program picture is produced in the browser on a canvas (cameras + overlays +
badges), encoded with `MediaRecorder`, and streamed over the WebSocket as binary
frames. The server pipes those frames straight into one ffmpeg process, which
encodes once and fans out:

```
ffmpeg -f matroska -i pipe:0 -c:v libx264 -preset veryfast -b:v 6000k \
       -c:a aac -b:a 160k -f tee \
       "[f=flv:onfail=ignore]rtmp://a.rtmp.youtube.com/live2/<key>|\
        [f=flv:onfail=ignore]rtmps://live-api-s.facebook.com:443/rtmp/<key>|\
        [f=mp4:onfail=ignore]/recordings/<room>_<time>.mp4"
```

`onfail=ignore` means one platform dropping out never kills the other outputs.
Adding or pausing a destination mid-broadcast rebuilds the relay with the new
target set.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP + WebSocket port |
| `QUANDRITE_HOST` | `0.0.0.0` | Bind address |
| `QUANDRITE_FFMPEG_BIN` | bundled `ffmpeg-static` | ffmpeg executable to use |
| `QUANDRITE_RECORDINGS_DIR` | `./recordings` | Where recordings are written |
| `QUANDRITE_PRESET` | `1080p30` | Default quality preset |
| `QUANDRITE_INPUT_FORMAT` | `matroska` | Container of the incoming program feed |
| `QUANDRITE_AUDIO_KBPS` | `160` | Program audio bitrate |
| `QUANDRITE_MAX_DESTINATIONS` | `8` | Destinations per room |
| `QUANDRITE_MAX_SOURCES` | `24` | Media sources per room |
| `QUANDRITE_MAX_BREAKOUTS` | `8` | Breakout rooms a room can be split into |
| `QUANDRITE_STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN servers handed to every client |
| `QUANDRITE_TURN_URLS` | *unset* | Comma-separated TURN servers (`turn:relay.example.org:3478`) - what makes calls work across strict firewalls and symmetric NAT |
| `QUANDRITE_TURN_USERNAME` | *unset* | TURN username |
| `QUANDRITE_TURN_CREDENTIAL` | *unset* | TURN credential |
| `QUANDRITE_TLS_CERT` | *unset* | TLS certificate path: the studio is then served over HTTPS |
| `QUANDRITE_TLS_KEY` | *unset* | TLS key path |
| `QUANDRITE_SMTP_URL` | *unset* | SMTP relay for mailing the host password (`smtp://user:pass@host:587`) |
| `QUANDRITE_MAIL_WEBHOOK` | *unset* | Alternative: POST the message as JSON to this URL |
| `QUANDRITE_MAIL_FROM` | `Quandrite <no-reply@quandrite.local>` | From address of the password mail |
| `QUANDRITE_PUBLIC_URL` | *unset* | Base URL used for the join link inside that mail |
| `QUANDRITE_HOST_PASSWORD` | *generated per room* | Password required to claim the host seat |
| `QUANDRITE_COHOST_PASSWORD` | *generated per room* | Password that lets people claim a co-host seat |
| `QUANDRITE_LOG_LEVEL` | `info` | Server log level |

## REST API

```
GET    /api/health                        service, ffmpeg path, room count
GET    /api/capabilities                  platforms, presets, scene catalogue, roles
GET    /api/rooms                         room summaries
POST   /api/rooms                         create a room (accepts hostEmail to mail the passwords)
POST   /api/rooms/:id/invite              mail a room password to an address (caller must know it)
GET    /api/rooms/:id                     full studio snapshot
GET    /api/rooms/:id/chat                chat history
GET    /api/rooms/:id/recordings          recording library for a room
DELETE /api/rooms/:id                     close a room
GET    /api/recordings                    every recording
DELETE /api/recordings/:id                delete a recording and its files
GET    /recordings/:file                  play / download a recording
```

`POST /api/rooms` accepts `{ id, name, hostName, hostPassword, cohostPassword }`.
The response is the room snapshot plus a `credentials` object - the only place
the passwords are ever returned, and only to the caller that created the room.

## Across the internet

The meeting mesh is peer to peer, so three things decide whether two people on
different networks can see and hear each other:

1. **The signaling server has to be reachable.** The WebSocket that carries
   `join`, the SDP offers/answers and the ICE candidates is this app's own server
   (`server/signaling.ts`), and it is room scoped - not a blind broadcast to every
   socket. Put it on a public host (Render, Railway, Fly, a VPS) and everyone
   points at `wss://your-studio.example.com/ws`; `ws://localhost:8080` only works
   for people on your own machine.
2. **STUN finds a route, TURN makes one when there is none - and the socket
   carries the picture when both fail.** Most home networks get through with STUN
   alone, but symmetric NAT, corporate firewalls and some mobile networks block a
   direct connection. A TURN relay is the proper fix:

   ```bash
   QUANDRITE_STUN_URLS=stun:stun.l.google.com:19302 \
   QUANDRITE_TURN_URLS=turn:relay.example.org:3478 \
   QUANDRITE_TURN_USERNAME=user \
   QUANDRITE_TURN_CREDENTIAL=secret \
   npm start
   ```

   The list is handed to every client in the `welcome` message and used for both
   the meeting connections and the program feed, so no client needs a rebuild to
   pick it up. Self-host Coturn, or use a managed relay (Metered, Xirsys, Twilio).

   **If nothing else works, the studio still shows the picture.** While a peer
   connection exists but is not `connected`, each client posts its own camera and
   screen as low-rate JPEG frames (`QMR1` frames, ~4 fps, 480 px) over the same
   WebSocket the studio already uses; the server fans them out to the room, the
   tiles show them, and they can be composited onto the program like any other
   source. It costs bandwidth and it is not full frame rate - TURN is still the
   better path - but a camera or a shared screen is never invisible, whatever the
   two networks do to each other.
3. **The page has to be a secure origin.** Browsers only hand out the camera, the
   microphone and the screen on HTTPS (or `localhost`). Give the server a
   certificate and it serves TLS itself - the WebSocket follows as `wss://`:

   ```bash
   QUANDRITE_TLS_CERT=/etc/letsencrypt/live/studio.example.com/fullchain.pem \
   QUANDRITE_TLS_KEY=/etc/letsencrypt/live/studio.example.com/privkey.pem \
   npm start
   ```

   (A reverse proxy that terminates TLS in front of the app works just as well.)

## Which path is faster?

There are two ways a camera or a screen reaches the room, and each tile says which
one it is on:

| Tile says | Path | Character |
| --- | --- | --- |
| `P2P` (green) | WebRTC peer connection | Full frame rate, audio too, a few tens of milliseconds. Used whenever it connects. |
| `relay ~N ms` (amber) | Pictures and voice over the WebSocket | The fallback. Lower frame rate, video plus voice - and it works on networks that refuse peer-to-peer. `N` is how far behind the picture is right now. |

The relay is built so that **lag stays flat instead of growing** (the idea Akka
Streams would give you with `conflate` + `dropHead`, which is JVM-only - this is
the same shape in the browser):

**Pictures** (JPEG, 480 px wide, target 4 fps):

- **One picture at a time, never a queue.** While the encoder or the socket is
  busy the frame is *dropped*: the next one is fresher anyway, so the room always
  sees the newest picture rather than a backlog.
- **A nearly empty socket.** More than 64 KB buffered and frames are dropped
  instead of queued.
- **A picture that arrives too late is thrown away** (over 1.5 s), because
  showing it would only add its delay to what the room already sees.
- **The rate adapts**: slow frames, a filling socket or a slow encoder walk the
  rate down (to 1 fps / JPEG q0.3 if they must); when everything is comfortable it
  walks back up to the target.
- **Every frame is stamped in nanoseconds** on a shared clock (see below), taken when
  the picture was drawn rather than when it finished encoding, so a slow encoder
  shows up as lag instead of hiding inside it.

**Voice** (Opus at 48 kHz, 48 kbps for a microphone and 96 kbps for a shared
screen's sound; 48 kHz **24-bit PCM** where WebCodecs is missing, stepping down to
16-bit while the socket is busy so the slice still goes out):

- **The same rule**: a slice is dropped rather than queued when the socket is
  behind, and a slice that arrives more than 600 ms late is thrown away.
- **The depth follows the socket.** 24-bit is three bytes a sample - 144 KB/s at
  48 kHz - and the relay is a fallback path with a 64 KB socket budget, so a slice
  that cannot fit is sent at 16-bit instead of being dropped. The header says which
  depth it is (`codec: pcm24` / `pcm16`, plus `bits`) and the receiving end reads
  exactly that: a slice that does *not* say is read as 16-bit, because reading
  16-bit samples as 24-bit is noise rather than a rounding error.
- **A small jitter buffer, pushed forward.** Playback keeps ~50 ms of voice
  queued ahead of the clock to ride out jitter; if it ever falls more than 350 ms
  behind, it jumps forward to now instead of drifting. That is why a struggling
  network sounds choppy but stays *live*.
- **Silence is not sent** (below a small peak threshold), apart from a keepalive
  every 500 ms - and muting stops the bytes entirely, not just the sound.
- **One voice per person**: a camera's built-in microphone and a separately
  published microphone are recognised as the same device and sent once, and
  remote sources are never relayed back (that would echo the room to itself).
- **The server keeps voice and pictures on separate budgets**, so a burst of
  pictures can never chop the sound up: voice gets 60 slices a second with a small
  burst allowance for jittery audio callbacks.

So: if you see `P2P`, WebRTC is winning - nothing to do. If you see `relay 40 ms`
the socket is keeping up well; if that number climbs, the network is the limit and
the relay is deliberately shedding frames to keep the delay from growing. Adding a
TURN server (above) is the way to get the full-rate path back on a strict network.

### Sharp when it can be, steady when it cannot

A call has to survive a phone on a train *and* look like 1080p on fibre, and those
are the same problem: send the best picture the link can carry, and never send more
than it can. There are two paths, and each has its own way of doing that.

**Peer-to-peer (the path you get when it connects).** WebRTC already measures the
path and changes what it sends - that is what it is for - but it can only work
within the limits it is given, and the default limit for a video sender is low. So
each sender is now told what the feed is worth:

| Feed | Ceiling | Frames | Behaviour under pressure |
| --- | --- | --- | --- |
| Camera | 2.5 Mbps | 30 fps | `balanced`: gives up some of both |
| Screen share | 6 Mbps | 15 fps | `maintain-resolution`: keeps the pixels, drops frames - text stays readable |
| Program (outgoing) | by the track's own hint | - | follows whatever the feed is |

The camera is asked for **1920×1080** at capture (measured: `1920×1080` live), and
each track carries a `contentHint` - `motion` for a camera, `detail` for a screen -
which travels with it into the encoder, so smoothness and sharpness are traded in the
right direction for each feed. Nothing here needs to be perfect: WebRTC will happily
send less when the network tightens, and that is the point.

**The socket relay (the fallback).** JPEG cannot do 1080p at 30 fps - it would be
tens of megabits - so the relay sends a **rung from a quality ladder**, chosen from
how the sending is actually going:

| Rung | Size | Frames | Costs |
| --- | --- | --- | --- |
| 1080p | 1920×1080 | 3 fps | ~3.2 Mbps |
| 720p | 1280×720 | 4 fps | ~1.9 Mbps |
| 480p | 854×480 | 5 fps | ~900 kbps |
| 360p | 640×360 | 6 fps | ~480 kbps |
| 240p | 426×240 | 6 fps | ~240 kbps |

- The ladder **steps down at once** when a pass is slow, the socket is filling, or
  frames had to be dropped: a stutter is felt in the second it starts.
- It **steps up slowly** - one rung per five comfortable seconds - because climbing
  eagerly is what makes a marginal link oscillate between sharp-but-broken and
  soft-but-smooth. One bad pass resets the climb.
- It opens at the rung the browser's own network report suggests
  (`navigator.connection`: `downlink`, `effectiveType`, and `saveData`, which is
  honoured), and starts again if the browser says the network changed - a phone
  moving between wifi and mobile data.
- `quandriteRelay.stats().video` reports the rung, the measured throughput and
  whether it is already at its ceiling, so this is visible rather than guessed at.

**What this cannot do, honestly:** nothing can send 1080p over a link that cannot
carry it. What it does instead is always send *the best picture that fits* - sharp
and calm on a good link, smaller and still moving on a bad one - and keep the voice
on its own budget so it is never the thing that suffers. The clear next step for the
relay is to stop sending JPEG altogether and send **H.264/VP8 via WebCodecs**, which
would put real 1080p30 in the same bandwidth budget; the ladder is the right shape
for that change, since a rung then means a bitrate rather than a size.

### Audio quality: both stacks, promoted

Voice travels by two stacks - WebRTC when two browsers can reach each other, the socket
relay when they cannot - and both were quiet by default in ways nobody asked for. The
numbers both ends have to agree on live in `shared/audio.ts`.

**WebRTC (peer to peer).** The Opus encoder's real settings are not in `setParameters`;
they are in the SDP's `a=fmtp` line, so the local description is rewritten before it is
set - for the offer, for the answer, and for the program connections. `preferOpus()` finds
the codec's dynamic payload type from its `rtpmap` and rewrites just that line (creating
it if the browser sent none), leaving everything else in the SDP untouched.

| | before | now |
| --- | --- | --- |
| bitrate | ~32 kbps (browser default) | **96 kbps** voice, **128 kbps** for a screen or the program |
| DTX | on - quiet passages stopped being sent | **off**: a soft voice and music are part of the sound |
| in-band FEC | as offered | **on**, so packet loss is a glitch and not a hole |
| stereo | no | **yes** for a shared screen's sound, mono for a microphone |
| sender priority | low | **high** - voice is not what should queue behind video |

**The socket relay.** It used to send 16 kHz 16-bit PCM: telephone bandwidth at
256 kbps, with nothing left over for quality. It now encodes **Opus at 48 kHz** through
WebCodecs - 48 kbps for a microphone, 96 kbps for a shared screen's sound - and decodes it
with a per-sender decoder into the same jitter-buffered scheduler the PCM path used, so the
delay behaviour is unchanged. Where WebCodecs is missing (or refuses the config) the PCM
slice is still there - **48 kHz 24-bit**, stepping down to 16-bit while the socket is busy
so the slice is not dropped - and a room can even have both at once. Every slice says which
depth it is, and anything that does not say (an old sender, or a frame whose header predates
the field) is read as 16-bit, so a mixed room keeps working instead of playing noise.

| | before | now |
| --- | --- | --- |
| codec | PCM 16, mono, 16 kHz | **Opus**, 48 kHz, mono or stereo (fallback: PCM **24-bit**, 48 kHz, 16-bit when the socket is tight) |
| bandwidth | ~256 kbps | **~48 kbps** voice, ~96 kbps music (the 24-bit fallback is a last resort) |
| sound | 8 kHz of bandwidth | 20 kHz of bandwidth, 24-bit where there is no encoder |

**Devices.** A microphone is opened as speech - echo cancellation, noise suppression,
automatic gain, one channel - and a **shared screen is the opposite**: all three processors
off and stereo kept, because they are exactly what damages music and system sound. Both ask
for 48 kHz so the whole path runs at one rate instead of quietly resampling. Media captured
*before* a room exists (the landing page's pre-join row) is not announced into nothing: the
announcement waits for the room, which is what keeps a pre-join microphone from earning a
"could not announce source" error.

**What used to break, and what was fixed.** Four faults, all of which sound the same -
*"the sound broke"*:

- **A voice that arrived while the room was ducked stayed silent for ever.** The program mix
  carries everyone's voice, so the room's own voices are ducked while a program feed is up;
  a voice that arrived *during* that window was created at gain 0 while its record said 1,
  and the ramp only fires on a change - so it never came back up. A new voice now starts at
  exactly the value `_applyGains()` would ask for, so the end of the duck brings it up with
  everything else.
- **The mixer stopped sampling when the last voice left.** The relay's voice and the program
  feed are *meters*, not voices, and the sample timer was stopped when the last entry went -
  which left those paths unwatched (no feedback detection on the relay) and the mixer silent
  about what it was hearing. The timer now stops only when there is nothing left to sample.
- **A slice that did not declare its depth was read as 24-bit.** Reading 16-bit samples as
  24-bit is not a small error, it is noise: every slice now says what it is, and anything
  that does not say is read as 16-bit.
- **Voice slices evicted the warm pictures.** The server keeps "the newest frame from each
  source" so a newcomer sees the room - and a camera's microphone shares its source id, so a
  voice slice took the picture's place. Only pictures are remembered now.

**What the studio can see.** `quandriteRelay.stats().audioQuality` reports, per
connection, the device's own sample rate and channels, the bitrate ceiling the sender was
given and its priority, and the Opus parameters both sides settled on;
`stats().received` reports the relay's codecs, how many frames were encoded and decoded,
and any errors. That is what tells a quiet call apart from a device problem.

Measured live between two browsers:

| what was read | result |
| --- | --- |
| negotiated Opus (room connection) | `maxaveragebitrate: 96000`, `usedtx: false`, `useinbandfec: true`, `minptime: 10`, `stereo: false` |
| the sender, once connected | `maxBitrate: 96000`, `priority: high` |
| the microphone the browser handed over | `sampleRate: 48000`, `channels: 1` |
| the relay | `codecs: ["opus"]`, 1501 frames encoded and sent, 0 encode errors, 0 dropped |
| decoding the far end | 625 frames decoded, 624 played, 0 decode errors |
| with WebCodecs deleted, a new source | `codecs: ["opus","pcm24"]` - the fallback still carries voice, at 48 kHz 24-bit |

### Chat: the room, one person, or a picture

Chat is one panel with three abilities, in front of the room (or in the studio's Chat
tab - it is the same panel, moved).

- **Private messages.** The **To** picker offers *Everyone in the room* plus each person.
  A private message reaches exactly two clients - the sender and the recipient - because
  the server decides the audience per message rather than broadcasting: it is never
  written into the room's history, and a third person cannot receive it even by asking.
  Threads are kept per pair and handed back on joining, so a reload does not lose a
  conversation. **Message** in the roster opens the thread with that person.
- **Unread counts.** A message in a thread that is not on screen is counted: a badge on
  the Chat button, and `(2 new)` in the picker's own label. Opening the thread - or
  coming back to the tab - clears it.
- **Pictures.** Attach with the image button, **paste** one into the message box, or
  **drop** a file on the chat. The browser scales it to 1280px and re-encodes it (JPEG
  for photographs, PNG kept for screenshots, GIFs left alone so they still animate),
  then uploads it to `POST /api/rooms/:id/chat/upload`. The message carries the **URL**,
  never the bytes: a megabyte of base64 per message would slow the room's socket down.
  A picture can be sent with no words at all, it renders inline, and clicking it opens
  the full size in a new tab.
- **What the server accepts.** Only `image/png|jpeg|webp|gif`, only under 2 MB decoded,
  only a data URL whose bytes actually begin with that format's magic number, and only
  a message URL of the shape `/uploads/<room>-<uuid>.<ext>` that this server wrote for
  *this room*. Anything else is refused, so a chat message can never point at somebody
  else's server - a tracking pixel in a room is not a feature. Files are served from
  `/uploads` with a long cache, because the name never changes.
- Measured live between two browsers: Ada picks Bob, sends *"the room must not see this"*
  - Bob's thread has it, Ada's own room thread does **not**, and the roster's third
  member never receives it; Bob replies and it lands in the same thread; the unread
  badge appears and clears; a 640×360 PNG dropped on the chat arrives at Bob as
  `/uploads/room-dm-…png` with `loaded: true`.

### Notifications

Desktop notifications are **off until somebody turns them on**: the **Notify** button on
the meeting bar asks the browser for the permission (which only a click can do), then
says *Alerts on*. The choice lives in `localStorage.quandrite.notify`.

They are for a studio you are not staring at, so nothing is announced that can already
be seen - if the tab is visible and focused, the room itself is the notification. What
does arrive:

| notification | when |
| --- | --- |
| *Bob in the room chat* / *Private message from Bob* | a message in a thread that is not on screen, or in a background tab |
| *Ada muted you* / *Ada stopped your video* | always, even in a focused tab - it explains why the microphone went quiet |
| *Bob asked for the air* | a host, when somebody requests the grid or the air |
| *You are live* / *The broadcast stopped* | the broadcast's own state changes |

Clicking one focuses the tab. A browser that refuses them (or has them blocked) says so
on the button - *Blocked* - with a tooltip pointing at the address bar, rather than
failing silently.

### Moderating the room

A host (or a co-host) can switch anyone's microphone or camera, and the person's own
client really does it - the label and the track agree.

- **From the tile.** Point at somebody in the grid and their tile offers two icon
  buttons: mute them, stop their video. They are `data-requires="control"`, so a viewer
  never renders one, and the icons say the state (a struck-through microphone means
  muted) with the person's name in the tooltip. They fade in on hover, and are always
  there on a touch screen.
- **From the roster.** The People popup has the same two controls per person, plus
  **Mute all** and **Stop all video**. It is also where roles are granted, breakout rooms
  are made, and the room's passwords live.
- **It is enforced, not announced.** The server tells the member's client
  (`member:media` with `byName`), which switches its own tracks off, stops its camera
  source - keeping the voice alive - and toasts *"Ada muted you"*.
- **A decision about a person holds.** Muting *one* person is remembered by name for the
  room, so if they reload they arrive muted; joining the call respects that rather than
  announcing an unmute, and the toast says why. Nobody is locked out: they can unmute
  themselves at any time, and the host unmuting them clears the note. **Mute all** is a
  sweep, not a policy - it is not remembered. Names are how a room identifies somebody;
  a person who renames themselves arrives unmuted.

### The studio is a popup with tabs

The Studio button opens a **popup over the room** that fills the container - the same
idea as Share and Chat - with its tabs as the menu: **Scenes · Go live · Meeting ·
Library**. It carries the grid layout (the Grid preview pane, where a host arranges
what goes out and sees who is asking to be on air).

- **People, Chat and Share are not studio tabs.** People and Chat are on the meeting
  bar (Chat opening in front of the room), and Share is the picker that opens in front
  of it. Their panels stay in the markup, because that is where those popups borrow
  them from - one panel, one set of handlers.
- **My own microphone and camera are icons, and they are on the meeting bar**: the same
  two icons the landing page's pre-join row uses, with the words in the tooltip and the
  state in the icon (a struck-through microphone means muted). They used to be the words
  *Mute* and *Stop video*, and the studio's Meeting tab carried the icons - so the bar said
  what the studio already said. Nothing disables them either: they are yours to use whether
  or not you have joined the call, and turning one on is what joins you.
- **One Leave button.** It is on the meeting bar, red, and it does both jobs: it leaves
  the call if you are in one, and leaves the room otherwise. The old top-bar Leave and
  the studio's Leave are gone.
- **Muting is about the microphone only.** A screen share has audio of its own - the
  sound of the tab or the system - and muting yourself must not silence what you are
  presenting. The microphone tracks are found first (a microphone source, or the audio
  track that came with a camera), the mesh is told which they are, and the relayed
  voice follows the same rule. Measured: with a screen share running, muting left
  `camera:off` and **`screen:on`**.

### The status pills, in plain words

| pill | means |
| --- | --- |
| **off air** | Nothing is being sent to any platform: the room is just a room. It becomes `connecting` / `live` / `reconnecting` / `stopping` while a broadcast runs. |
| **not recording** | This room is not being recorded. It becomes `recording`, then `saving`, then `saved`. |

Both carry a tooltip that says the same thing in a sentence, and the recording pill no
longer shows the server's bare word `idle` - that was a status, not an explanation.

Your own picture is mirrored, the way every call app does it: you see yourself as you
are used to seeing yourself, and moving right moves the picture right. **What goes out
is never mirrored** - the room's tiles, the grid preview, the program picture and the
relay are the real thing, because mirroring any of them would reverse text in the
picture for everybody else.

- The mirror is on the **self view only** (`.self-view video { transform: scaleX(-1) }`).
- It shows **your camera specifically**, never a shared screen: a screen share is not
  a self portrait, and mirroring one would reverse its text.
- **Click the preview to flip it** if you would rather see exactly what the room sees.
  The choice is remembered per browser, and the tooltip says which way round it is.

Measured with a host and a viewer in one room:

| what | transform |
| --- | --- |
| my own self view | `matrix(-1, 0, 0, 1, 0, 0)` — mirrored |
| the tile the *viewer* sees of me | `none` — the real picture |
| other people's tiles, grid preview, program canvas, program feed | `none` |

After clicking the preview: `class="self-view unmirrored"`, transform `none`, and
`localStorage.quandrite.selfMirror = "plain"`.

### My own picture goes where I put it

The self view is **draggable**: pick it up anywhere on the card and drop it wherever on
the screen suits - over the program, in a corner, out of the way of a shared screen.

- **Position is a fraction, not pixels.** What is stored is the fraction of the room the
  picture can travel across, so `1,1` is the bottom-right corner whatever the window is
  doing. A resize, a different view (Program / People / Split) or a smaller laptop screen
  never strands it half off the edge - it is re-placed from the fraction every time the
  room changes size (`ResizeObserver` on the stage, plus `resize`).
- **It cannot leave the room.** A drag is clamped to the stage, so the picture can never
  be dropped somewhere it cannot be picked up again.
- **A click is not a drag.** A pointer that travels less than 4px still flips the mirror;
  anything more is a move. The two gestures share the card without stealing from each
  other, and the tooltip says so.
- **The keyboard can do it too.** The card is focusable; the arrow keys nudge it 16px at
  a time and Enter or Space flips the mirror.
- Measured live: dragged from its corner to the top-left (`0.0000,0.0000`), dragged past
  the edge and clamped, a click flipping the mirror without moving it, five arrow presses
  giving `0.0683,0.0000`, and a 1440→1000px resize re-placing it at `left: 55px` - the
  same relative spot.

`localStorage.quandrite.selfViewPos = "0.0683,0.0000"` is that position; clearing it puts
the picture back in its default corner.

A viewer watches. Everything about *running* the room is a host's and co-host's, and
a viewer is not shown it at all:

| | Host / co-host | Viewer / visitor |
| --- | --- | --- |
| **Program** and **People** views | yes | yes |
| **Split** view | yes | not offered |
| **Studio** button, `…`, **Record** | yes | not offered |
| **Chat** | yes, on the bar | yes, on the bar |
| **Share** | yes | yes - anyone may publish |

- The Split button, the Studio button, the `…` menu and Record carry
  `data-requires="control"`, so they are simply not there for a viewer.
- **Asking anyway is refused, not honoured**: `setStageView()` turns a requested
  `split` into `people` for anyone without control, and `toggleStudio()` refuses to
  open the drawer. Measured with a real viewer: the studio stayed hidden after
  clicking, and the view stayed on `people` after asking for split.
- **Chat is not a studio tool**, so a viewer keeps it: the same Chat panel moves into
  a dialog in front of the room (exactly as Share does) and goes home when it closes.
- If a role changes mid-session - a seat handed over, a viewer made a co-host - the
  view is re-checked: a viewer is never left looking at a split or holding a studio.

Measured with a host and a viewer in the same room: the host saw `Program · People ·
Split` with a working Studio button (drawer closed, opens on click), the viewer saw
the same room with **no Split, no Studio, no `…`, no Record**, and both had Chat.

The studio holds what you *do*, not what you *look at* - the program has its own half
of the room, so it does not need a preview pane, and devices are added from Share, so
they do not need a pane either. What is left: **In this room** (the people), **Grid
preview** (where a host arranges what goes out, with the on-air requests in it), and
the tabbed sidebar - scenes, Go live, **rooms**, meeting, library (People, Chat and
Share are the bar's and the popups').

- **The program's controls moved to the room**, above the picture they control: the
  `Single camera / All cameras / Screen` buttons and the preset/bitrate/uptime line,
  host-only. The old "On air: …" box is gone - **who is on air is said on the tile
  that is on air**, with a red badge, and in the grid preview beside it.
- **Mute and Stop video are always usable** and carry icons, wherever they are - the
  landing page's pre-join row and the meeting bar are the same two controls, painted from
  one state by one function, so they can never disagree. They no longer wait for you to
  join a call first: a camera turned on before a room exists previews locally, and it is
  announced and published the moment you are in one. Measured: pressing the pre-join mic
  turned the room bar's icon from `micOff` to `mic` and the member list from `muted` to
  `mic on`, with no call to join first.
- **My own camera is not a participant tile.** It is the small picture in the corner,
  so the room shows everybody *else* - and the grid is a **grid**: one column count,
  chosen to fill the space (1 tile → 1 column, 4 → 2×2, 5 → 3+2), every tile exactly
  the same size, no tile twice as big as its neighbours.

Nothing in the room sends anyone to another page. The room is the page:

- **The main view is one container that switches between its own halves**: `Program`,
  `People` or `Split`, chosen from the bar and remembered per browser. A host opens on
  the **split** - the program beside the people, left and right - because they need to
  see what is going out and who is in the room at the same time. Measured on a host:
  program at 378 px wide, people at 329 px beside it, both in the same container.
- **The studio docks beside the room rather than covering it** (`position: static`,
  a real column), so opening it shrinks the room instead of replacing it. Measured:
  the studio's left edge sits to the right of the stage, and never over it.
- **Share opens in front of the room** as a dialog holding the same device picker the
  studio's Share tab uses - the panel is *moved* into the dialog and put back when it
  closes, so there is one set of checkboxes and one set of handlers. Measured: the
  dialog opens with the picker and its four device checkboxes, closes cleanly, and the
  panel is back in the studio afterwards.
- **The meeting bar sits with the picture it controls**: it is inside the stage,
  immediately after the program frame, so it is under the program - in the stage's own
  column when the studio is docked beside the room - and it is a *sibling* of the views
  rather than a child of one, so switching to People keeps the bar. The self view moved
  up with it (`bottom: 68px`), because the bottom corner of the stage is where the
  controls are now.
- **The meeting bar carries the meeting**: the microphone and camera icons, Share,
  Record, …, **Rooms**, **People**, **Chat**, Leave - with the state in each icon and
  the words in its tooltip.
- The program picture itself lives in the room (`#program-canvas` exists exactly once),
  and its frame follows the on-air aspect ratio, so a wide share is surrounded by
  itself rather than by black.

### Feedback: heard, ducked, restored

A speaker playing the room while a microphone listens to it is a loop that gets louder
each time round, and it is painful within a second. The mixer watches for it and gets out
of the way:

- **Feedback has two signatures, and a room needs both.** The classic one is loud *and*
  narrow - one note, where a voice spreads across many frequencies. The detector counts
  how few frequency bins carry most of the peak's energy (`narrowShare`) and needs it
  sustained across two passes. But a howl in a real room is often **not** one clean note:
  a resonant room, or a speaker on a hard surface, produces a broad, rough roar that the
  narrow test would wait for forever. So the second signature is the *climb*: a feedback
  loop is louder every round trip, so its level rises **unbroken for 300 ms** and keeps
  going, where a voice's swell turns over and falls. Neither test alone is enough; either
  one is a howl.
- **Every path it can arrive on is watched.** Voice reaches a client by three routes and
  only one of them is the mixer: peer-to-peer voices (mixed here), the **socket relay**
  (a second `AudioContext` with its own output), and the **program feed** (a media
  element). A howl on the relay or on the program feed used to be played with nothing to
  notice it - so the mixer now watches *meters* it does not play
  (`meter()` / `analyse()`), and the relay routes its voice through an analyser placed
  **before** its gain, so a howl is still visible while the room is already ducked.
- **When it is detected every path is pulled down, hard and fast**: the mixer's master
  gain to `0.02` (-34 dB), the relayed voice to the same, the program element muted - all
  ramped, but with an **attack of a hundredth of a second**, because a howl that is merely
  *quieter* keeps feeding itself. The release is slow by contrast (a quarter second), so
  the room does not surge the moment it stops. The banner names the path and *what gave
  the howl away* (*"Feedback detected on the relayed audio (climbing out of control)"*),
  and a notification goes out. The meters are read every **50 ms**, so a howl is caught
  on the way up rather than after it hurts.
- **My own microphone is held down for as long as the howl lasts** - not for a fixed
  number of seconds. It used to be a two-second timer, and that was the bug: the
  microphone came back while the room was still ringing, the loop re-formed underneath it,
  and the room howled again. Now the hold starts when the howl does and ends half a
  second after it has gone, with a ten-second backstop so a stuck state can never leave
  somebody muted. It is the **microphone** that is held - never a shared screen's audio -
  and only the tracks it switched off are switched back on.
- **When the howl stops, everything comes back** - gains to 1, the program element to
  whatever the listener chose, the microphone re-enabled, a toast to say so. The user's
  own mute always wins: if you muted yourself, nothing is switched on behind your back.

Measured live, by driving each shape into the mixer and reading what the room did about
it (and pinned down in `test/room-audio.test.ts`, which feeds the detector the levels
measured from a real loop):

| what was played | `feedback.active` | why | mixer master | my microphone |
| --- | --- | --- | --- | --- |
| **broad howl, climbing fast** (band-limited noise, 0.02 -> 0.9 gain in 400 ms) | **true** | `reason: "rising"` | **0.02** | held off |
| ...after it stops | false | - | back to 1 | back on |
| 1 kHz tone, ramping to full scale (the classic howl) | **true** | `reason: "narrow"` | **0.02** | held off |
| ...after it stops | false | - | back to 1 | back on |
| broad noise, **loud but steady** (a voice) | **false** | neither | 1 | untouched |
| broad noise, **swelling over 2.5 s** (a voice getting louder) | **false** | neither | 1 | untouched |
| 1.4 kHz tone into the relay's meter | **true** (banner: *on the relayed audio*) | `narrow` | 0.02 | held off |

The first row is the one worth noting: it is exactly the case the narrow-only detector
missed, and the reason "the feedback is still there" was a fair complaint. A broad howl
never reached `narrowShare <= 0.06` at any point on its way up.


The room's voices used to be played by the tiles' own `<video>` elements, and that
is fragile in three ways that all look the same to a user - *"the sound broke"*:

- an unmuted media element will not start until the page has been interacted with,
  so a stream that arrives first is simply silent;
- the element is **removed when a camera goes off**, and the voice went with it: a
  microphone on its own had no element to play through at all;
- and there is nothing to duck - turning the room down meant touching the element
  that also carries the picture.

So the voices are mixed in one place now (`public/js/room-audio.ts`): one
`AudioContext`, one graph per peer (`source -> analyser -> gain -> output`), and the
tiles keep the pictures and are always muted. That gives, in one change:

- **Turning the video off no longer turns the voice off.** The microphone is usually
  captured *inside* the camera's stream, so removing the camera stopped the track.
  A microphone of its own is published first (`keepVoiceAlive()`), and the same
  happens when a camera ends by itself or the host stops someone's video. Measured:
  with the camera off there is no tile at all and the voice is still heard (level
  0.44, 9 active samples in 4 s) where it used to be silent.
- **A muted participant is really silent** (a gain of 0, not just a label), and the
  program mix ducks the whole room through the same gains.
- **Recovery is one thing rather than three**: the context is resumed on the first
  gesture, resumed again and **re-attached** (`rebuild()`) when the page becomes
  visible, and a watchdog notices a suspended context every couple of seconds -
  backgrounding a phone is the most common way a call goes quiet.
- **Diagnosis is possible**: `quandriteRelay.stats().roomAudio` reports the context
  state and, per peer, the gain, the measured level and the incoming track's
  `muted`/`readyState` - which is the first thing to look at when somebody cannot be
  heard.

One honest limit, measured: a page put into the browser's *frozen* lifecycle state
(the state Chrome uses before discarding a page) comes back with the incoming track
reporting `muted: false, readyState: live` while delivering no audio at all. No
amount of re-attaching fixes that, because the browser itself has dropped the media;
a real backgrounded tab is much softer than that, and that case is handled by the
resume-and-rebuild above.

The room is a grid of faces filling the window, with the controls along the bottom -
the layout people already know from a call app:

- **The grid is the page.** Tiles lay themselves out (`auto-fit`, 16:9, rounded), so
  a room of three and a room of thirty both look right; whoever is talking is
  outlined, and a wave under their name shows it.
- **What is being presented becomes a tile of its own**, twice the size of the faces
  and labelled ("Ada · Camera 1", "shared screen") - the way a call app shows the
  thing being talked about, rather than hiding it behind a tab.
- **My own picture floats in the corner** whenever my camera is on.
- **The bottom bar is the meeting**: Mute / Start video / Share / Record / … / Leave,
  with the labels reading the live state (`Stop video` only when my video is on,
  `Unmute` only when I am muted). Each one delegates to the studio's single
  behaviour rather than duplicating it, so the two can never disagree.
- **The studio is one toggle away** - program preview, cameras and screens, scenes,
  the grid preview, chat, platforms, library are all still there, unchanged, behind
  the **Studio** button. Opening it never closes the room; closing it never leaves
  the room blank.
- On a phone the grid drops to two columns, a share spans the full width, and the
  bar becomes a full-width strip.

Measured live with two participants and a camera on air: **3 tiles** (two faces plus
the on-air tile), 3 columns, tiles at **465×261** (16:9), the bar reading
`Mute · Start video · Share · Record · … · Leave`, the studio closed by default - and
clicking the bar's mic really muted and unmuted the call.

The participants are the point, so the room is built to be stable rather than busy:

- **A camera tile is never rebuilt under the video that is playing.** A stream event
  fires for every track and every renegotiation; recreating the tile and its
  `<video>` each time restarts playback, which is the flicker people see on each
  other's cameras. The tile, the element and the feed are now reused, and the feed
  is only re-pointed when it genuinely changed. Measured over ten seconds of a live
  room: one element, one `srcObject`, no playback resets.
- **A wave under each tile says who is talking**, read from their own audio by one
  analyser per stream (mine included) on a single timer. The wave itself is a CSS
  animation and the app only toggles `.speaking`, so nothing runs per frame - and a
  voice is *held* for 700 ms after it drops, so the wave does not strobe between
  syllables. It respects `prefers-reduced-motion`.
- **The program frame is the shape of the picture**, not a fixed box: the aspect
  ratio is taken from the on-air video, so a wide share is surrounded by itself
  rather than by empty black. On a phone that measured **22% of the viewport height**
  where it used to be a black container about the height of the screen. `Fill screen`
  gives the program the whole window and hides the rest; the phone layout keeps the
  program full width with the people below it.
- **Mute and pause are the viewer's own**, and muting the program really mutes it
  (it outranks the "the program mix already carries the room" rule). A breakout room
  always keeps the program quiet, because its own conversation matters more.
- **A break is a countdown, not a blackout.** Nothing on air outlives its own
  countdown: when it reaches zero the room goes straight back to what it was
  watching. If anything else is covering the program, the frame says so in amber and
  a host can take it off air with one click - so interference is announced rather
  than suffered.
- **A newcomer is shown the room as it already is.** The server keeps the newest
  picture from each source per room and hands those over on join, marked `warm`
  (they are deliberately older than the live staleness rule allows, because a still
  of a second ago beats an empty tile).
- **The relay aims higher for a share than for a face**: a screen is sent at up to
  1280 px / 6 fps / JPEG q0.6 and a camera at 640 px / 5 fps / q0.55, with the same
  drop-instead-of-queue rule underneath. Peer-to-peer is still preferred whenever it
  connects - the relay is what fills in when it cannot.


### Why the program picture used to blink


The program flashing dark while the room looked fine was not a network problem - the
relay was running at 10-40 ms throughout. It was three separate things, all now
fixed and all measurable:

1. **A picture was drawn before it was decoded.** A relayed frame arrived as a blob
   URL, and setting it on an `<img>` leaves that element with *no picture at all*
   until it loads. The compositor's rule for a source that is not ready is to draw
   its dark "connecting..." placeholder - so the program flashed on every frame.
   Relayed pictures are now decoded first (`createImageBitmap`) and handed over as a
   frame that is always drawable, with the previous frame kept as a fallback. The
   room tile never blinked because a browser keeps painting the old `<img>` until
   the new one is ready; the compositor deliberately does not.
2. **The decoded frame never reached the compositor.** `syncCompositorSources()`
   copies `stream` and `video` from the local source onto the announced one, so the
   bitmap had to be copied too. Without it the compositor fell straight back to the
   `<img>` path from (1).
3. **Every relayed frame nudged the outgoing video.** `syncCompositorSources()` runs
   on every frame, and the program video used to be "a real track when there is
   exactly one source, the canvas otherwise" - so a relayed picture arriving *added
   a source*, flipped the program from the camera track to the canvas, and rebuilt
   the encoder that ffmpeg is reading. That is the outgoing stream blinking, and it
   is what the platforms would see too. Now:
   - a relayed picture is a **canvas drawing** and never becomes the outgoing track;
   - `programStream()` keeps **one `MediaStream` object** while its tracks are
     unchanged, so a new object cannot read as "the program changed";
   - a genuine change of on-air video is **coalesced** (800 ms) and re-checked
     before rebuilding, so a burst of changes causes one restart - or none at all if
     the picture settles back.

Measured on the viewer's program canvas while relayed pictures stream in at 4 fps:

**0 dark frames in 301** (it was 3 with a visible dark window before), and the
program's video-track and stream identities stayed at **1** across ten seconds of a
busy room. `quandriteRelay.stats().program` reports both, plus `publisher.rebuilds`,
so a regression here is visible rather than guessed at.

The rule worth keeping: **the outgoing video track and the program stream object must
not change while the room changes around them.** Every change there is a restart of
the stream ffmpeg is reading.

### Nanosecond timing

Milliseconds cannot describe a healthy hop. A relayed picture that takes 3 ms to
reach the server and 0.19 ms to come back out is either "0 ms, 0 ms" or "3 ms,
1 ms" at `Date.now()` resolution - and the difference between a frame that is 3 ms
old and one that is 9 ms old is invisible. So every relayed picture and voice slice
is stamped in **nanoseconds**, and the studio shows the units that fit: `412 ns`,
`1.50 µs`, `38.42 ms`.

A stamp is only a number if both ends agree what clock it is on, and two devices'
wall clocks can differ by seconds. So there is **one time base - the server's
monotonic clock**:

1. On connect (and every 30 s) the client runs an NTP-style exchange: it sends its
   own reading `t0`, the server answers with its clock on receipt (`t1`) and on send
   (`t2`), and the client reads `t3` when the reply lands. The offset is
   `((t1 - t0) + (t2 - t3)) / 2` and the round trip is the error bar.
2. Only the **best** samples are kept (five, by lowest round trip), because a queue
   anywhere along the way can only add delay - so the lowest round trips are the
   honest ones. The studio reports that error bar as `clock.accuracyNs`; on a
   loopback socket it lands around 600 µs.
3. A sender converts its reading into server time before stamping, so `tns` on any
   frame is comparable with any other device's clock. The server adds `srv` - its
   own arrival time - as the frame passes through.

That gives two honest numbers per frame, and the tile tooltip shows both:
`to server 29.50 ms · from server 9.16 ms`. When a call is lagging, that is the
answer to "whose network is it?": a 400 ms total that is 380 ms `to server` is the
sender's uplink, while the same total `from server` is my own downlink.

The stamps travel as decimal strings, not numbers: 19-digit nanoseconds are well
past what a double holds exactly, so `nsFromWire`/`nsToWire` keep them exact and all
the arithmetic is `BigInt`. A frame with no stamp (an older sender) reports nothing
about its age rather than guessing - it is never dropped for being "late".

Being honest about resolution: the server's clock (`process.hrtime.bigint()`) is
genuinely nanosecond-resolution, while browsers expose microseconds
(`performance.now()`), so a browser reading is exact arithmetic on a
microsecond-accurate clock. Both are monotonic, so neither can jump backwards
mid-call the way a wall clock can.

To watch it from the browser console while a call is running:

```js
quandriteRelay.stats();
// {
//   clock:    { offsetNs: '302487521362450', accuracyNs: '1050000', samples: 1 },
//   video:    { fps: 4, quality: 0.5, sent: 240, dropped: 3, intervalMs: 250 },
//   audio:    { ids: ['camera-abc-1'], sent: 610, dropped: 0 },
//   received: { played: 604, stale: 0, senders: 1,
//               lag: { totalNs: '10557525', inboundNs: '10362575', outboundNs: '194950' } },
//   hops:     { total: '10.56 ms', toServer: '10.36 ms', fromServer: '194.95 µs' },
//   paths:    [{ peer: '...', path: 'relay 10.56 ms' }, ...]
// }
```

`sent`/`dropped` show how much the relay is shedding to keep the delay flat,
`hops` shows which side of the network the delay is on, `clock.accuracyNs` is the
error bar on all of it, and `paths` shows which peers are on which path - the
numbers that decide whether peer-to-peer or the relay is doing better on a given
network.

## WebSocket protocol

`ws://<host>/ws`, JSON messages with an optional `id` for request/response acks.

Client to server: `join` (with an optional `password` for the host/co-host
seats), `leave`, `ping`, `chat:send`, `member:update` (your own mic/camera state),
`member:role` (host only: grant, revoke or hand over a role), `member:media`
(host and co-hosts: mute or stop video for one member, or `all: true` for
everyone else), `room:update` (host only: rotate the passwords),
`breakout:create`, `breakout:assign`, `breakout:rename`, `breakout:shuffle`, `breakout:open`,
`breakout:close`, `breakout:clear`, `breakout:announce` (host and co-hosts run the
breakout rooms and rename them; anyone may move themselves into an open one or back to the
main room), `source:add`, `source:update` (your own sources, including
`patch.request` = `grid` / `air` / `null` to ask to be shown), `source:remove`,
`program:set`, `scene:set`, `scene:clear`, `destination:add`,
`destination:update`, `destination:remove`, `stream:start`, `stream:stop`,
`record:start`, `record:stop`, `webrtc:signal`.

Server to client: `welcome`, `ack`, `error`, `pong`, `chat:new`,
`members:update`, `member:media` (your mic or camera was switched for you),
`breakouts:update` (the breakout catalogue, sent to the main
room and every breakout), `breakout:update` (this client moved rooms, with the
roster, the catalogue, the chat of the room it entered and the studio state),
`sources:update`, `program:update`, `scene:update`, `destinations:update`,
`stream:update`, `recording:update`, `recordings:update` (the room's recording
library, pushed when one is finalised or deleted), `webrtc:signal`, `relay:log`.
A studio push carries its body in `payload` and the client transport dispatches
that payload, so `socket.on('sources:update', (sources) => ...)` receives the
array of sources; the flat messages (`welcome`, `member:media`, `webrtc:signal`,
`pong`) have no `payload` and are dispatched whole. Binary frames sent by the
active publisher are the program feed. The `welcome`
message also reports whether the host password can be mailed (`mail.enabled`).

## Tests

```bash
npm test          # everything
npm run test:unit # pure modules, studio state machine, REST, WebSocket
npm run test:e2e  # real ffmpeg end-to-end livestream
```

The end-to-end test starts two ffmpeg RTMP servers as stand-ins for YouTube and
Facebook, goes live with recording enabled, streams a real WebM program feed
through the WebSocket, and then asserts that **both** platforms received media
and that the recording was finalised, probed for duration, listed by the API and
downloadable as a valid MP4.

## Known limitations

- The browser tab producing the program picture must stay visible: `canvas`
  capture is throttled when the tab is hidden.
- Only the client that started the broadcast feeds the encoder; a co-host takes
  over by ending and restarting the stream.
- If the host disconnects the seat moves to the earliest co-host, or failing
  that to the earliest member, so the room is never left uncontrollable. A
  deliberate hand-over uses the *People* tab.
- Breakout rooms are chat and call scoped: the program output, the sources and
  the overlays always belong to the parent room, so a participant inside a
  breakout sees the parent's preview and control state rather than their own.
- A late joiner starts in the main room; press *Shuffle* or pick a room to place
  them.
- A participant reaches the program only through the host or a co-host that is
  connected to them, so the host must have joined the call (or received their
  stream) before their tile can be composited.
- A participant's own camera never goes on air by itself: it is published, and
  the host or a co-host decides whether it reaches the viewers.
- *Stop video* for someone else disables their camera track and unpublishes the
  source, so the program drops it cleanly; they can start it again from their own
  row.
- Platform ingest endpoints are provider controlled. Each destination accepts a
  full URL override so a rotated or regional endpoint needs no code change.
- The `tee` muxer cannot write Matroska slaves, so fan-out recordings are MP4.
  The relay always closes ffmpeg's stdin gracefully, which lets the MP4 index be
  written before exit.
- Stream keys are never echoed back or written to logs; they are masked in every
  API and WebSocket payload.
