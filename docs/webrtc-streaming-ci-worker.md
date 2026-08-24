# Streaming a device's screen from a CI worker (WebRTC / WHIP)

This guide shows how to make an AutoMobile daemon running on a CI worker **push**
the screen of the Android or iOS device it is driving to a WHIP ingest server
over WebRTC, so the stream can be watched live in a browser. The supported
server is [MediaMTX](https://github.com/bluenviron/mediamtx) — a single-binary
SFU that accepts the WHIP stream and fans it out to browsers over WHEP.

For the full design, see
[WebRTC Screen Streaming](./design-docs/mcp/observe/webrtc-streaming.md), and
for the protocol rationale, see the
[WebRTC standards map](./design-docs/mcp/observe/webrtc-standards-map.md).

```
CI worker (AutoMobile daemon) ──WHIP──▶ MediaMTX (SFU) ──WHEP──▶ browser
```

## Prerequisites

- An AutoMobile daemon running on the CI worker (the streaming control socket is
  started with the daemon).
- A connected/booted **Android** emulator or device (`adb devices` lists it), or
  a booted **iOS** simulator with the CtrlProxy screen streaming helper and
  local `ffmpeg` available.
- A reachable **WHIP ingest server**. Run MediaMTX with the
  [example config](https://github.com/kaeawc/auto-mobile/blob/main/examples/mediamtx/mediamtx.yml) — `mediamtx ./examples/mediamtx/mediamtx.yml`
  (or the official container) — which serves WHIP at `/<stream>/whip` and WHEP at
  `/<stream>/whep` on port `8889`. Any WHIP-compatible SFU (LiveKit, Janus,
  Cloudflare) works too. MediaMTX is the supported production fanout; browsers
  watch a stream with its built-in WHEP reader at `http://<host>:8889/<stream>`.
  - **Ports:** `8889` is only the WHIP/WHEP signaling listener. The media itself
    flows over MediaMTX's ICE **UDP** listener `webrtcLocalUDPAddress: :8189` — a
    containerized or firewalled deployment that exposes only `8889` gets WHIP/WHEP
    setup failures or black video. Map/open `8189/udp` too, or configure a
    TURN/TCP-only path. Behind Docker/NAT, mapping the port is not enough if
    MediaMTX advertises its private/container interface — set
    `webrtcAdditionalHosts: [<public-ip-or-dns>]` so it hands out reachable ICE
    candidates, otherwise signaling completes but ICE times out to black video.
  - **Auth:** the stock config is **localhost-only** — its active `authInternalUsers`
    entry admits `127.0.0.1`/`::1`, so a CI worker publishing from _another host_
    gets `401` until you enable the config's commented tokened `authInternalUsers`
    block. Then set `AUTOMOBILE_WEBRTC_WHIP_TOKEN` to that user's `<user>:<pass>`
    (MediaMTX reads internal credentials from `Authorization: Bearer <user>:<pass>`).

## 1. Point the worker at your WHIP server

MediaMTX derives the stream name from the URL **path**, so set the endpoint to a
per-stream WHIP URL (the publisher also appends a harmless `?streamId=` query
that MediaMTX ignores). The stock config serves plain **HTTP** on `:8889`, so use
`http://`. For a reachable deployment, enable TLS and switch to `https://` — see
[HTTPS](./design-docs/mcp/observe/webrtc-streaming.md#production-fanout-mediamtx)
in the design doc for the certificate + `webrtcEncryption` steps. Set these
before (or when) starting the daemon. Because MediaMTX keys the stream from the
path, a **per-job** stream must carry its id in the endpoint path — the `start`
request's `streamId` alone only sets the ignored query (see [Typical CI
shape](#typical-ci-shape) for deriving both from `$CI_JOB_ID`):

```bash
export AUTOMOBILE_WEBRTC_WHIP_ENDPOINT="http://mediamtx.example.com:8889/ci-run-42/whip"
# Optional:
export AUTOMOBILE_WEBRTC_WHIP_TOKEN="<user>:<pass>"  # for cross-host MediaMTX; matches the tokened authInternalUsers block
export AUTOMOBILE_WEBRTC_ICE_SERVERS="stun:stun.l.google.com:19302"
# Optional tuning:
export AUTOMOBILE_WEBRTC_BITRATE_KBPS="4000"
export AUTOMOBILE_WEBRTC_MAX_SIZE="720x1280"
export AUTOMOBILE_WEBRTC_IOS_SIMULATOR_FPS="15"   # iOS Simulator capture rate, 5-60
# Optional audio: Android requires a video-server jar; iOS requires Simulator-window capture.
export AUTOMOBILE_WEBRTC_AUDIO="1"
```

> **NAT/firewall:** CI workers are usually behind NAT. Add a **TURN** server to
> `AUTOMOBILE_WEBRTC_ICE_SERVERS` (JSON form) if a plain STUN server cannot
> establish connectivity to your WHIP server:
>
> ```bash
> export AUTOMOBILE_WEBRTC_ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
> ```

## 2. Start a stream

Streaming is controlled via the daemon's Unix socket
`~/.auto-mobile/webrtc-stream.sock` using newline-delimited JSON.

Using `nc` (OpenBSD netcat, `-U` for Unix sockets):

```bash
echo '{"action":"start","streamId":"ci-run-42"}' \
  | nc -U ~/.auto-mobile/webrtc-stream.sock
```

Response:

```json
{"success":true,"type":"webrtc_stream_response","action":"start",
 "stream":{"streamId":"ci-run-42","lifecycleState":"capture_ready",
           "lease":{"id":"lease_...","expiresAt":"..."},
           "resourceUrl":null, ...}}
```

If multiple devices are attached, pass `"deviceId":"emulator-5554"` or the iOS
simulator UDID. You can also override any config per call, e.g.
`{"action":"start","whipEndpoint":"https://other/whip","bitrateKbps":2000}`.
Keep the returned lease ID and include it in `await`, `status`, and `stop`
requests. Leases expire after one minute without renewal, so abandoned CI
workers do not retain a capture helper or encoder.
For audio, pass `"audio":true`. Android requires the persistent `video-server`
jar because `screenrecord` is video-only. iOS supports audio for Simulator-window
capture through ScreenCaptureKit; physical iOS playback capture is unavailable.

### From Node / Bun

```ts
import { sendWebRtcStreamRequest } from "auto-mobile/dist/.../webrtcStreamClient"; // or import from source
const res = await sendWebRtcStreamRequest({ action: "start", streamId: "ci-run-42" });
const streamId = res.stream!.streamId;
const leaseId = res.stream!.lease!.id;
await sendWebRtcStreamRequest({ action: "await", streamId, leaseId, readiness: "publishing" });
```

(The client is `src/daemon/webrtcStreamClient.ts`.)

## 3. Watch it

Point a browser WHEP viewer at the matching WHEP URL — for the stream above,
`http://mediamtx.example.com:8889/ci-run-42/whep`. MediaMTX serves a built-in
reader page at `http://mediamtx.example.com:8889/ci-run-42`; any WHEP-capable
`<video>` client works too.

## 4. Stop the stream

```bash
echo '{"action":"stop","streamId":"ci-run-42","leaseId":"lease_..."}' | nc -U ~/.auto-mobile/webrtc-stream.sock
```

Omit `streamId` if there is exactly one active stream.

## Inspecting streams

```bash
# All active streams on this worker:
echo '{"action":"list"}'   | nc -U ~/.auto-mobile/webrtc-stream.sock
# One stream:
echo '{"action":"status","streamId":"ci-run-42"}' | nc -U ~/.auto-mobile/webrtc-stream.sock
```

## Typical CI shape

```bash
# 1. boot emulator/simulator + start daemon (project-specific)
# 2. begin streaming so humans can watch the run live.
#    Put $CI_JOB_ID in the WHIP *path* so each job is its own MediaMTX stream —
#    passing only streamId would leave every job publishing to the same path.
WHIP="http://mediamtx.example.com:8889/$CI_JOB_ID/whip"
echo '{"action":"start","streamId":"'"$CI_JOB_ID"'","whipEndpoint":"'"$WHIP"'"}' | nc -U ~/.auto-mobile/webrtc-stream.sock
# 3. run your AutoMobile test plan ...
# 4. stop streaming on teardown (best-effort)
echo '{"action":"stop","streamId":"'"$CI_JOB_ID"'"}'  | nc -U ~/.auto-mobile/webrtc-stream.sock || true
```

The publisher reconnects automatically if the network blips. MediaMTX keeps the
WHEP path stable, but a browser WHEP client must retry or recreate its peer
connection after the publisher reconnects. Video streaming supports Android and
iOS; optional audio works on Android and iOS Simulator windows.

## Troubleshooting

| Symptom                                                 | Likely cause / fix                                                                                                                                                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `No WHIP endpoint configured`                           | Set `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT` or pass `whipEndpoint`.                                                                                                                                                               |
| `No connected android devices found`                    | Emulator/device not booted, or pass the right `deviceId`.                                                                                                                                                                   |
| `WHIP ingest failed: … 401`                             | The WHIP server requires auth, or you're publishing cross-host against the localhost-only stock config. Enable the tokened `authInternalUsers` block and set `AUTOMOBILE_WEBRTC_WHIP_TOKEN` to that user's `<user>:<pass>`. |
| Stream shows `connected` but the browser video is black | ICE could not traverse NAT — add a TURN server.                                                                                                                                                                             |
| Brief hitch every ~3 minutes                            | Expected `screenrecord` segment rotation (180 s cap). Build/provide `automobile-video.jar` to use the persistent encoder.                                                                                                   |
| Audio-enabled stream fails to start                     | The persistent `video-server` jar is missing, or the device build does not allow shell `REMOTE_SUBMIX` capture. Disable audio or use a compatible Android image.                                                            |
