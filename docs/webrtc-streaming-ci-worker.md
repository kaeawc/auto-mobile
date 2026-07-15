# Streaming a device's screen from a CI worker (WebRTC / WHIP)

This guide shows how to make an AutoMobile daemon running on a CI worker **push**
the screen of the Android device it is driving to a coordination server over
WebRTC, so the stream can be watched live in a browser.

For the full design, see
[WebRTC Screen Streaming](./design-docs/mcp/observe/webrtc-streaming.md).

```
CI worker (AutoMobile daemon) ──WHIP──▶ coordination server ──WHEP──▶ browser
```

## Prerequisites

- An AutoMobile daemon running on the CI worker (the streaming control socket is
  started with the daemon).
- A connected/booted **Android** emulator or device (`adb devices` lists it).
- A reachable **coordination server** that accepts WHIP ingest. Use the bundled
  [reference server](../examples/webrtc-coordination-server/README.md) to try it
  out, or a production SFU such as MediaMTX / LiveKit / Janus / Cloudflare.

## 1. Point the worker at your coordination server

Set these before (or when) starting the daemon:

```bash
export AUTOMOBILE_WEBRTC_WHIP_ENDPOINT="https://coord.example.com/whip"
# Optional:
export AUTOMOBILE_WEBRTC_WHIP_TOKEN="<bearer token, if the server requires one>"
export AUTOMOBILE_WEBRTC_ICE_SERVERS="stun:stun.l.google.com:19302"
# Optional tuning:
export AUTOMOBILE_WEBRTC_BITRATE_KBPS="4000"
export AUTOMOBILE_WEBRTC_MAX_SIZE="720x1280"
# Optional Android audio (requires AUTOMOBILE_VIDEO_SERVER_JAR / built video-server):
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
           "resourceUrl":"https://coord.example.com/whip/ci-run-42", ...}}
```

If multiple Android devices are attached, pass `"deviceId":"emulator-5554"`.
You can also override any config per call, e.g.
`{"action":"start","whipEndpoint":"https://other/whip","bitrateKbps":2000}`.
For audio, pass `"audio":true`; it is Android-only and requires the persistent
`video-server` jar because `screenrecord` is video-only.

### From Node / Bun

```ts
import { sendWebRtcStreamRequest } from "auto-mobile/dist/.../webrtcStreamClient"; // or import from source
const res = await sendWebRtcStreamRequest({ action: "start", streamId: "ci-run-42" });
console.log(res.stream?.resourceUrl);
```

(The client is `src/daemon/webrtcStreamClient.ts`.)

## 3. Watch it

Open the coordination server's viewer (the reference server serves one at `/`)
and pick `ci-run-42` from the stream list. The viewer discovers streams through
the reconnect API (`GET /api/streams`) and connects over WHEP.

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
# 1. boot emulator + start daemon (project-specific)
# 2. begin streaming so humans can watch the run live
echo '{"action":"start","streamId":"'"$CI_JOB_ID"'"}' | nc -U ~/.auto-mobile/webrtc-stream.sock
# 3. run your AutoMobile test plan ...
# 4. stop streaming on teardown (best-effort)
echo '{"action":"stop","streamId":"'"$CI_JOB_ID"'"}'  | nc -U ~/.auto-mobile/webrtc-stream.sock || true
```

The publisher reconnects automatically if the network blips; the browser viewer
reconnects via the coordination server's reconnect API. Streaming is Android-only
today.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `No WHIP endpoint configured` | Set `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT` or pass `whipEndpoint`. |
| `No connected android devices found` | Emulator/device not booted, or pass the right `deviceId`. |
| `WHIP ingest failed: … 401` | Coordination server requires a token — set `AUTOMOBILE_WEBRTC_WHIP_TOKEN`. |
| Stream shows `connected` but the browser video is black | ICE could not traverse NAT — add a TURN server. |
| Brief hitch every ~3 minutes | Expected `screenrecord` segment rotation (180 s cap). Build/provide `automobile-video.jar` to use the persistent encoder. |
| Audio-enabled stream fails to start | The persistent `video-server` jar is missing, or the device build does not allow shell `REMOTE_SUBMIX` capture. Disable audio or use a compatible Android image. |
