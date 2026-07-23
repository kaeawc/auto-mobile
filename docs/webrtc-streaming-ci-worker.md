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
  [example config](../examples/mediamtx/mediamtx.yml) — `mediamtx ./examples/mediamtx/mediamtx.yml`
  (or the official container) — which serves WHIP at `/<stream>/whip` and WHEP at
  `/<stream>/whep` on port `8889`. Any WHIP-compatible SFU (LiveKit, Janus,
  Cloudflare) works too. The bundled
  [reference server](../examples/webrtc-coordination-server/README.md) still
  exists for a zero-dependency local try-out, but MediaMTX is the supported
  production fanout.

## 1. Point the worker at your WHIP server

MediaMTX derives the stream name from the URL **path**, so set the endpoint to a
per-stream WHIP URL (the publisher also appends a harmless `?streamId=` query
that MediaMTX ignores). Set these before (or when) starting the daemon:

```bash
export AUTOMOBILE_WEBRTC_WHIP_ENDPOINT="https://mediamtx.example.com:8889/ci-run-42/whip"
# Optional:
export AUTOMOBILE_WEBRTC_WHIP_TOKEN="<bearer token, if the server requires one>"
export AUTOMOBILE_WEBRTC_ICE_SERVERS="stun:stun.l.google.com:19302"
# Optional tuning:
export AUTOMOBILE_WEBRTC_BITRATE_KBPS="4000"
export AUTOMOBILE_WEBRTC_MAX_SIZE="720x1280"
# Optional audio: Android requires a video-server jar; iOS requires Simulator-window capture.
export AUTOMOBILE_WEBRTC_AUDIO="1"
```

> **NAT/firewall:** CI workers are usually behind NAT. Add a **TURN** server to
> `AUTOMOBILE_WEBRTC_ICE_SERVERS` (JSON form) if a plain STUN server cannot
> establish connectivity to your coordination server:
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
 "stream":{"streamId":"ci-run-42","state":"connected",
           "resourceUrl":"https://mediamtx.example.com:8889/ci-run-42/whip/<session>", ...}}
```

If multiple devices are attached, pass `"deviceId":"emulator-5554"` or the iOS
simulator UDID. You can also override any config per call, e.g.
`{"action":"start","whipEndpoint":"https://other/whip","bitrateKbps":2000}`.
For audio, pass `"audio":true`. Android requires the persistent `video-server`
jar because `screenrecord` is video-only. iOS supports audio for Simulator-window
capture through ScreenCaptureKit; physical iOS playback capture is unavailable.

### From Node / Bun

```ts
import { sendWebRtcStreamRequest } from "auto-mobile/dist/.../webrtcStreamClient"; // or import from source
const res = await sendWebRtcStreamRequest({ action: "start", streamId: "ci-run-42" });
console.log(res.stream?.resourceUrl);
```

(The client is `src/daemon/webrtcStreamClient.ts`.)

## 3. Watch it

Point a browser WHEP viewer at the matching WHEP URL — for the stream above,
`https://mediamtx.example.com:8889/ci-run-42/whep`. MediaMTX serves a built-in
reader page at `https://mediamtx.example.com:8889/ci-run-42`; any WHEP-capable
`<video>` client works too.

## 4. Stop the stream

```bash
echo '{"action":"stop","streamId":"ci-run-42"}' | nc -U ~/.auto-mobile/webrtc-stream.sock
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
# 2. begin streaming so humans can watch the run live
echo '{"action":"start","streamId":"'"$CI_JOB_ID"'"}' | nc -U ~/.auto-mobile/webrtc-stream.sock
# 3. run your AutoMobile test plan ...
# 4. stop streaming on teardown (best-effort)
echo '{"action":"stop","streamId":"'"$CI_JOB_ID"'"}'  | nc -U ~/.auto-mobile/webrtc-stream.sock || true
```

The publisher reconnects automatically if the network blips; MediaMTX keeps the
WHEP path stable so the browser viewer reconnects to the same URL. Video
streaming supports Android and iOS; optional audio works on Android and iOS
Simulator windows.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `No WHIP endpoint configured` | Set `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT` or pass `whipEndpoint`. |
| `No connected android devices found` | Emulator/device not booted, or pass the right `deviceId`. |
| `WHIP ingest failed: … 401` | The WHIP server requires a token — set `AUTOMOBILE_WEBRTC_WHIP_TOKEN` (for MediaMTX, matching the `authInternalUsers` publish password). |
| Stream shows `connected` but the browser video is black | ICE could not traverse NAT — add a TURN server. |
| Brief hitch every ~3 minutes | Expected `screenrecord` segment rotation (180 s cap). Build/provide `automobile-video.jar` to use the persistent encoder. |
| Audio-enabled stream fails to start | The persistent `video-server` jar is missing, or the device build does not allow shell `REMOTE_SUBMIX` capture. Disable audio or use a compatible Android image. |
