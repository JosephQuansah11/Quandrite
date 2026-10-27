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
| Several cameras on one machine | `enumerateDevices()` + `addAllCameras()`: any number of simultaneous camera sources (`public/js/devices.js`) |
| Cameras connected over Bluetooth | Web Bluetooth pairing assist, then automatic re-enumeration and attach of the newly exposed camera (see note below) |
| See all cameras together | Grid program mode composites every selected camera into one picture (`shared/layout.js`) |
| Primary stream plus view switching | Program modes `single` / `grid` / `screenshare`; click "air" on any tile to switch what the platforms receive |
| Titles, announcements, screenshare, songs, break, end card | Six scene types with live forms, timed or persistent (`shared/overlays.js`) |

## Quick start

```bash
npm install          # installs express, ws and a bundled ffmpeg binary
npm start            # http://localhost:8080
```

Open the page, enter a name and a room code, then press **Join**. The first
person in a room becomes the host and can drive the broadcast; co-hosts can too;
everyone else can chat and join the call.

### Live in five steps

1. **Cameras** - `Add camera`, `Add all cameras`, or `Share screen` (leave
   *with sound* ticked to include system audio).
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
| `QUANDRITE_LOG_LEVEL` | `info` | Server log level |

## REST API

```
GET    /api/health                        service, ffmpeg path, room count
GET    /api/capabilities                  platforms, presets, scene catalogue
GET    /api/rooms                         room summaries
POST   /api/rooms                         create a room
GET    /api/rooms/:id                     full studio snapshot
GET    /api/rooms/:id/chat                chat history
GET    /api/rooms/:id/recordings          recording library for a room
DELETE /api/rooms/:id                     close a room
GET    /api/recordings                    every recording
DELETE /api/recordings/:id                delete a recording and its files
GET    /recordings/:file                  play / download a recording
```

## WebSocket protocol

`ws://<host>/ws`, JSON messages with an optional `id` for request/response acks.

Client to server: `join`, `leave`, `ping`, `chat:send`, `member:update`,
`source:add`, `source:update`, `source:remove`, `program:set`, `scene:set`,
`scene:clear`, `destination:add`, `destination:update`, `destination:remove`,
`stream:start`, `stream:stop`, `record:start`, `record:stop`, `webrtc:signal`.

Server to client: `welcome`, `ack`, `error`, `pong`, `chat:new`,
`members:update`, `sources:update`, `program:update`, `scene:update`,
`destinations:update`, `stream:update`, `recording:update`, `webrtc:signal`,
`relay:log`. Binary frames sent by the active publisher are the program feed.

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
- Platform ingest endpoints are provider controlled. Each destination accepts a
  full URL override so a rotated or regional endpoint needs no code change.
- The `tee` muxer cannot write Matroska slaves, so fan-out recordings are MP4.
  The relay always closes ffmpeg's stdin gracefully, which lets the MP4 index be
  written before exit.
- Stream keys are never echoed back or written to logs; they are masked in every
  API and WebSocket payload.
