# WebRTC Screen Streaming (WHIP egress)

<kbd>⚠️ Partial</kbd> <kbd>🧪 Tested</kbd> <kbd>🤖 Android Only</kbd>

> **Current state:** The AutoMobile publish path is implemented and tested — an
> Android device's screen is captured as H.264, packetized to RTP, and pushed to
> a coordination server over **WHIP** using [werift](https://github.com/shinyoshiaki/werift-webrtc)
> (pure-TypeScript WebRTC). Control is via the daemon `webrtc-stream.sock` Unix
> socket. A reference coordination server + browser viewer ships under
> [`examples/webrtc-coordination-server/`](../../../../examples/webrtc-coordination-server/).
>
> Live device capture depends on `adb screenrecord` on a real Android device/emulator
> (not exercised in unit tests); everything up to and including the WebRTC media
> transport is covered by a real werift↔werift loopback and a full
> publisher→server→subscriber end-to-end test. iOS is not yet supported (no live
> H.264 source — see [iOS Screen Streaming](../../plat/ios/screen-streaming.md)).
>
> See the [Status Glossary](../../status-glossary.md) for chip definitions.

This is the **browser/CI-facing** streaming path. It is distinct from:
- the `videoRecording` MCP tool (records a clip to a file), and
- the IDE live-mirroring path over `video-stream.sock` + Klarity
  ([screen-streaming.md](./screen-streaming.md)).

## Motivation

A CI worker running the AutoMobile daemon should be able to **push** a live view
of the device it is driving to a central web server, which fans the stream out
to browsers (dashboards, debugging UIs, pair-debugging). WebRTC is the natural
fit: H.264 is a first-class WebRTC codec, latency is sub-second, and the browser
needs no plugin. **WHIP** (WebRTC-HTTP Ingestion Protocol) is the standard way to
*publish* a WebRTC stream to a server with a single HTTP POST, and is supported
by common media servers (MediaMTX, LiveKit, Janus, Cloudflare).

## Architecture

```
┌──────────────┐   adb exec-out       ┌───────────────────────────────┐
│ Android      │   screenrecord       │ AutoMobile daemon (CI worker) │
│  screen      │──--output-format=────▶│                               │
│              │   h264 (stdout)      │  AndroidH264Source            │
└──────────────┘                      │    │ Annex-B H.264            │
                                      │    ▼                          │
                                      │  RtpH264TrackWriter (RFC 6184)│
                                      │    │ RTP packets              │
                                      │    ▼                          │
                                      │  WebRtcPublisher (werift)     │
                                      │    │ SDP offer / ICE / DTLS   │
                                      └────┼──────────────────────────┘
                                           │  WHIP: POST offer, get answer,
                                           │  Location: resource URL
                                           ▼
                                 ┌───────────────────────┐   WHEP    ┌─────────┐
                                 │ Coordination server   │◀─────────▶│ Browser │
                                 │ (WHIP ingest → forward │  offer/   │ <video> │
                                 │  RTP → WHEP egress)   │  answer   └─────────┘
                                 │  GET /api/streams  ◀──┼── reconnect API
                                 └───────────────────────┘
```

### Components (in `src/features/webrtc/`)

| File | Responsibility |
|------|----------------|
| `h264.ts` | Annex-B NAL splitter, access-unit assembler, RFC 6184 RTP packetizer (single-NAL + FU-A) |
| `RtpH264TrackWriter.ts` | Turns the elementary stream into werift `RtpPacket`s; wall-clock 90 kHz timestamps, marker bit on the last packet of a frame |
| `AndroidH264Source.ts` | Runs `adb exec-out screenrecord --output-format=h264 -`; rotates segments before the 180 s `--time-limit` cap so the stream stays continuous |
| `PersistentEncoderH264Source.ts` | Runs the long-lived `video-server` (VirtualDisplay + MediaCodec) via `app_process`; a single continuous encoder with no rotation seam. Parsed by `VideoServerStreamParser.ts` |
| `androidH264CaptureSourceFactory.ts` | Prefers the persistent encoder when `automobile-video.jar` is resolvable (`videoServerJar.ts`), falling back to `screenrecord` on unavailability or start failure |
| `WhipClient.ts` | WHIP `POST` (offer→answer) and `DELETE`; resolves the `Location` resource URL used to reconnect/tear down |
| `ReconnectController.ts` | Connect / reconnect with injectable backoff (default exponential 1 s→30 s) |
| `WebRtcPublisher.ts` | werift `RTCPeerConnection` (H.264 sendonly) + WHIP + auto-reconnect; exposes a reconnect descriptor |
| `webrtcStreamingConfig.ts` | Resolves config from `AUTOMOBILE_WEBRTC_*` env vars + per-request overrides |

Control plane:

| File | Responsibility |
|------|----------------|
| `src/server/webrtcStreamManager.ts` | Per-device stream lifecycle; wires source ⇄ publisher; restarts the source on reconnect so a fresh keyframe follows |
| `src/daemon/webrtcStreamSocketServer.ts` | `webrtc-stream.sock` request/response control (`start`/`stop`/`status`/`list`) |
| `src/daemon/webrtcStreamClient.ts` | Minimal client for scripts/tooling |

## Why the daemon socket (not an MCP tool)

Streaming is a long-lived side channel owned by the daemon, not a discrete
agent action. It is controlled the same way as other daemon services
(`video-recording.sock`, `device-snapshot.sock`) — a request/response Unix
socket — so a CI worker can start/stop a stream without going through the MCP
tool surface. See [`src/daemon/CLAUDE.md`](../../../../src/daemon/CLAUDE.md).

## Control protocol (`~/.auto-mobile/webrtc-stream.sock`)

Newline-delimited JSON request/response.

**Request**

```jsonc
{
  "id": "1",                    // optional correlation id
  "action": "start",            // "start" | "stop" | "status" | "list"
  "deviceId": "emulator-5554",  // optional; defaults to the sole Android device
  "streamId": "ci-run-42",      // optional; generated if omitted
  "whipEndpoint": "https://coord:8080/whip",  // optional override of env
  "whipToken": "…",             // optional bearer token
  "iceServers": [{ "urls": "stun:stun.l.google.com:19302" }],
  "bitrateKbps": 4000,          // optional
  "size": { "width": 720, "height": 1280 }    // optional downscale
}
```

**Response**

```jsonc
{
  "id": "1",
  "success": true,
  "type": "webrtc_stream_response",
  "action": "start",
  "stream": {
    "streamId": "ci-run-42",
    "state": "connected",       // idle|connecting|connected|reconnecting|failed|stopped
    "whipEndpoint": "https://coord:8080/whip",
    "resourceUrl": "https://coord:8080/whip/ci-run-42",
    "iceServers": [ … ],
    "framesSent": 0,
    "packetsSent": 0
  }
}
```

## Configuration

| Environment variable | Meaning |
|----------------------|---------|
| `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT` | WHIP ingest URL (required unless passed per request) |
| `AUTOMOBILE_WEBRTC_WHIP_TOKEN` | Bearer token for the ingest endpoint |
| `AUTOMOBILE_WEBRTC_ICE_SERVERS` | Comma-separated STUN/TURN URLs, or a JSON array of `{urls,username,credential}` |
| `AUTOMOBILE_WEBRTC_BITRATE_KBPS` | Target encoder bitrate |
| `AUTOMOBILE_WEBRTC_MAX_SIZE` | Capture downscale, `WIDTHxHEIGHT` |

Per-request fields override the environment defaults.

## Reconnect model

Two independent reconnection layers:

1. **Publisher → server.** `WebRtcPublisher` watches the peer
   `connectionState`; on `failed`/`disconnected` it tears down and re-publishes
   over WHIP with backoff, restarting the capture source so a new SPS/PPS +
   keyframe follows immediately. The WHIP `Location` resource URL is retained so
   the stale session can be `DELETE`d.
2. **Browser → server.** The coordination server's reconnect API
   (`GET /api/streams`, `GET /api/streams/{id}`) returns a `StreamDescriptor`
   containing the `whepUrl` and `iceServers` — everything a frontend needs to
   (re)connect. The reference `viewer.html` re-subscribes automatically when its
   peer connection drops.

## Quality / bitrate

Capture prefers the persistent on-device encoder (`video-server`): a single
long-lived VirtualDisplay + MediaCodec pipeline with no ~175 s rotation seam and
one continuous timestamp base. It honors `--bit-rate` (from `bitrateKbps`) and
`--size` (from `size`). The jar is resolved via `AUTOMOBILE_VIDEO_SERVER_JAR` or
the Gradle build output (`android/video-server/build/libs/automobile-video.jar`,
built with `./gradlew :video-server:d8Dex`).

When the jar is not resolvable — or the persistent encoder fails to start —
capture falls back to `screenrecord`, which encodes on-device H.264 with the same
`--bit-rate`/`--size` controls. Its 180 s `--time-limit` cap is worked around by
segment rotation (`ANDROID_STREAM_SEGMENT_ROTATE_MS`); each new segment emits a
fresh keyframe.

## Known limitations / future work

- **Android only.** iOS `simctl` provides raw frames, not a live H.264 elementary
  stream; an on-Mac encoder (or the `video-server` VirtualDisplay path) would be
  required.
- **Persistent-encoder distribution.** The `video-server` jar removes the
  segment-rotation seam and is preferred when present, but is not yet shipped in
  the released package — until it is bundled/downloaded (like the CtrlProxy
  runner), production installs resolve no jar and fall back to `screenrecord`.
- **No audio.** Video only.
- **Reference server is single-process/in-memory.** Use a hardened WHIP/WHEP SFU
  (MediaMTX, LiveKit, Janus, Cloudflare) in production; the publisher is unchanged.
- **Trickle ICE not used.** The publisher gathers candidates before POSTing the
  WHIP offer (non-trickle), which is simplest and widely compatible.

## References

- [WHIP — draft-ietf-wish-whip](https://datatracker.ietf.org/doc/draft-ietf-wish-whip/)
- [WHEP — draft-ietf-wish-whep](https://datatracker.ietf.org/doc/draft-ietf-wish-whep/)
- [RFC 6184 — RTP Payload Format for H.264 Video](https://datatracker.ietf.org/doc/html/rfc6184)
- [werift-webrtc](https://github.com/shinyoshiaki/werift-webrtc)
- [CI worker setup guide](../../webrtc-streaming-ci-worker.md)
- [Reference coordination server](../../../../examples/webrtc-coordination-server/README.md)
- [IDE live mirroring (Unix socket + Klarity)](./screen-streaming.md)
