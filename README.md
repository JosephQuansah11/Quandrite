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

Viewers and visitors never see the camera/screen pane, the program switches, the
overlay forms, the platform setup, the go-live box or the password pane - those
are hidden rather than disabled, and the server refuses the matching messages
anyway.

### Live in five steps

1. **Cameras** - press `Cameras & screens` to open the picker: tick the cameras
   and microphones you want, then choose `Add to studio`, `Add to grid` or `Put
   on air` in the same pop-up. `Share screen` (leave *with sound* ticked for
   system audio) and `Pair Bluetooth` live in the same pane.
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
video as soon as the call delivers it, their role and their mic/camera state, and
new arrivals are announced to the room as they join.

When a participant's call video reaches the host or a co-host, it is registered
as a **virtual source** named after them, so it can be composited like any other
camera:

- `All cameras` (grid) now includes the participants who are in the call.
- The `air` button on their tile puts a single participant on the program.
- A participant who leaves the call drops out of the program automatically, and
  the program falls back to the remaining sources.

Because the feed is a real program source, a participant's audio is mixed into
the program audio too - use headphones so the program does not pick up the room.
Only the host and co-hosts can announce a participant, which is what makes them
part of what goes out.

### Panes you can hide

The top bar has a toggle for every pane - `Program`, `Participants`, `Cameras`
and `Sidebar` - so you can build the layout you want (a clean program monitor, a
full-width sidebar, or everything at once). The choice is remembered in the
browser, and it is independent of what your role is allowed to see.

### Participants, and being shown

The *People* tab mirrors Zoom's participants panel: a header with the count and
an **Invite** button (copies the join link), one row per person with their
avatar, role, room and mic/camera controls, and a footer with **Unmute me** and
**Claim host** (the room password wins the seat, even if someone else holds it).
Your own mic/camera buttons switch your own media; the host and co-hosts can
switch anyone's, and the target's client applies it at once.

Publishing and placement are immediate, never a two-step:

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

The *People* tab has a **Breakout rooms** panel for the host and co-hosts:

1. Pick how many rooms (up to 8) and, optionally, how many minutes they should
   run for, then press **Create**. Everyone except the host is spread across the
   rooms; the host stays in the main room so they can drop into any of them.
2. Move people with the room picker next to each name, or press **Shuffle** to
   re-deal the groups.
3. Press **Open all** (or `open` on a single room) to send everyone in. A timer
   closes the rooms automatically, and **Close all** brings everyone back while
   keeping the groups for next time. **Remove** deletes the rooms.
4. **Announce to all rooms** posts a message into the main room and every
   breakout, so nobody misses it.

Participants see a banner with a *Back to the main room* button and a pill in the
top bar showing where they are. Each breakout is a room of its own: it has its
own chat and its own call, so a breakout cannot hear the main room or another
breakout, and the main room cannot hear them. The program preview and the
broadcast itself stay with the parent room.

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

## WebSocket protocol

`ws://<host>/ws`, JSON messages with an optional `id` for request/response acks.

Client to server: `join` (with an optional `password` for the host/co-host
seats), `leave`, `ping`, `chat:send`, `member:update` (your own mic/camera state),
`member:role` (host only: grant, revoke or hand over a role), `member:media`
(host and co-hosts: mute or stop video for one member, or `all: true` for
everyone else), `room:update` (host only: rotate the passwords),
`breakout:create`, `breakout:assign`, `breakout:shuffle`, `breakout:open`,
`breakout:close`, `breakout:clear`, `breakout:announce` (host and co-hosts run the
breakout rooms; anyone may move themselves into an open one or back to the main
room), `source:add`, `source:update` (your own sources, including
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
Binary frames sent by the active publisher are the program feed. The `welcome`
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
