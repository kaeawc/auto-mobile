# WebRTC Screen Streaming (WHIP egress)

<kbd>⚠️ Partial</kbd> <kbd>🧪 Tested</kbd> <kbd>🤖 Android + iOS Video</kbd>

> **Current state:** The AutoMobile publish path is implemented and tested — an
> Android or iOS device screen video is captured as H.264, packetized to RTP, and pushed to
> a coordination server over **WHIP** using [werift](https://github.com/shinyoshiaki/werift-webrtc)
> (pure-TypeScript WebRTC). Control is via the daemon `webrtc-stream.sock` Unix
> socket. The supported fanout is [MediaMTX](https://github.com/bluenviron/mediamtx);
> a ready-to-run config ships under
> [`examples/mediamtx/`](../../../../examples/mediamtx/), and browsers watch the
> stream with MediaMTX's built-in WHEP reader.
>
> For the WebRTC protocol choices behind this implementation, see the
> [WebRTC standards map](./webrtc-standards-map.md).
>
> Live Android capture depends on `adb screenrecord` or the persistent
> `video-server` jar on a real device/emulator; iOS capture depends on the
> CtrlProxy screen streaming helper plus local `ffmpeg` H.264 encoding. Everything
> up to and including the WebRTC media transport is covered by a real
> werift↔werift loopback and a full publisher→server→subscriber end-to-end test.
>
> See the [Status Glossary](../../status-glossary.md) for chip definitions.

This is the **browser/CI-facing** streaming path. It is distinct from:

- the `videoRecording` MCP tool (records a clip to a file), and
- the desktop live-mirroring path over `video-stream.sock` + an in-process FFmpeg decoder
  ([screen-streaming.md](./screen-streaming.md)).

## Motivation

A CI worker running the AutoMobile daemon should be able to **push** a live view
of the device it is driving to a central web server, which fans the stream out
to browsers (dashboards, debugging UIs, pair-debugging). WebRTC is the natural
fit: H.264 is a first-class WebRTC codec, latency is sub-second, and the browser
needs no plugin. **WHIP** (WebRTC-HTTP Ingestion Protocol) is the standard way to
_publish_ a WebRTC stream to a server with a single HTTP POST, and is supported
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
                                 │ MediaMTX (SFU)        │◀─────────▶│ Browser │
                                 │ WHIP ingest → forward  │  offer/   │ <video> │
                                 │ RTP → WHEP egress     │  answer   └─────────┘
                                 │ /<stream>/whip · /whep │
                                 └───────────────────────┘
```

> The supported production fanout is **MediaMTX**; the AutoMobile publisher is
> unchanged (a standard WHIP client). See
> [Production fanout: MediaMTX](#production-fanout-mediamtx) below.

### Components (in `src/features/webrtc/`)

| File                                 | Responsibility                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `h264.ts`                            | Annex-B NAL splitter, access-unit assembler, RFC 6184 RTP packetizer (single-NAL + FU-A)                                                                          |
| `RtpH264TrackWriter.ts`              | Turns the elementary stream into werift `RtpPacket`s; wall-clock 90 kHz timestamps, marker bit on the last packet of a frame                                      |
| `RtpPcmuTrackWriter.ts`              | Turns 8 kHz mono PCM16LE audio into PCMU/G.711 RTP packets                                                                                                        |
| `AndroidH264Source.ts`               | Runs `adb exec-out screenrecord --output-format=h264 -`; rotates segments before the 180 s `--time-limit` cap so the stream stays continuous                      |
| `PersistentEncoderH264Source.ts`     | Runs the long-lived `video-server` (VirtualDisplay + MediaCodec, plus optional playback audio) via `app_process`; parsed by `VideoServerStreamParser.ts`          |
| `androidH264CaptureSourceFactory.ts` | Prefers the persistent encoder when `automobile-video.jar` is resolvable (`videoServerJar.ts`), falling back to `screenrecord` on unavailability or start failure |
| `WhipClient.ts`                      | WHIP `POST` (offer→answer) and `DELETE`; resolves the `Location` resource URL used to reconnect/tear down                                                         |
| `ReconnectController.ts`             | Connect / reconnect with injectable backoff (default exponential 1 s→30 s)                                                                                        |
| `WebRtcPublisher.ts`                 | werift `RTCPeerConnection` (H.264 sendonly) + WHIP + auto-reconnect; exposes a reconnect descriptor                                                               |
| `webrtcStreamingConfig.ts`           | Resolves config from `AUTOMOBILE_WEBRTC_*` env vars + per-request overrides                                                                                       |

Control plane:

| File                                     | Responsibility                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/server/webrtcStreamManager.ts`      | Per-device stream lifecycle; prepares and retains capture while it wires source ⇄ publisher |
| `src/daemon/webrtcStreamSocketServer.ts` | `webrtc-stream.sock` request/response control (`start`/`stop`/`status`/`list`/`await`)      |
| `src/daemon/webrtcStreamClient.ts`       | Minimal client for scripts/tooling                                                          |

### Coordinator lifecycle

`webrtcStreamManager` is the single per-device owner for the WHIP capture
session. It moves through `idle`, `preparing`, `capture_ready`, `publishing`,
`degraded`, `stopping`, and `failed`. Capture is prepared before the WHIP offer
is sent, then remains warm while the publisher reconnects; a transient ICE or
WHIP reconnect therefore does not restart ADB forwarding, the Android encoder,
or the iOS helper.

`start` returns after local capture is ready, before WHIP/ICE publishing
finishes. Its descriptor includes a generated `streamId` and a short-lived
lease. A client can use `await` to wait for `publishing` without delaying
capture ownership, and renews its lease through `status` or `await`.

The descriptor returned by `start`, `status`, and `list` includes
`lifecycleState`, `sourceStarted`, structured `failure`, and timestamped
`telemetry` for capture preparation, first media/IDR, SDP offer/answer, ICE
connection, and first RTP. A degraded capture exposes
`fallback: { mode: "screenshots", reason }`, so a client can switch to its
normal screenshot observation path without parsing logs.

Use the control socket's `await` action to wait independently for
`capture_ready` or `publishing`; it requires a `streamId` and accepts bounded
`timeoutMs`. A timeout returns a machine-readable `capture_ready_timeout` or
`publishing_timeout` failure for that request without degrading the shared
capture.

## Production fanout: MediaMTX

The publisher only needs a **WHIP ingest endpoint**; it does not care what
serves it. The supported production fanout is
[MediaMTX](https://github.com/bluenviron/mediamtx), a single-binary SFU that
ingests the WHIP stream and fans it out to browsers over WHEP. It owns the
per-subscriber RTP forwarding, keyframe recovery, and reconnect/migration that a
multi-viewer stream needs — so AutoMobile stays out of the SFU business.

Run it with the checked-in [example config](https://github.com/kaeawc/auto-mobile/blob/main/examples/mediamtx/mediamtx.yml):

```bash
mediamtx ./examples/mediamtx/mediamtx.yml   # serves WHIP + WHEP on :8889
```

Then point the worker at a **per-stream** WHIP URL — MediaMTX takes the stream
name from the URL path (`/<stream>/whip`); the publisher additionally appends a
harmless `?streamId=` query that MediaMTX ignores. The stock config serves plain
HTTP on `:8889` (enable `webrtcEncryption` for `https://`):

```bash
export AUTOMOBILE_WEBRTC_WHIP_ENDPOINT="http://mediamtx-host:8889/ci-run-42/whip"
```

> **Reachable/containerized hosts** need more than `:8889` (which is only
> signaling): expose the ICE media port `webrtcLocalUDPAddress: :8189/udp` (add
> `webrtcAdditionalHosts` behind NAT, or use TURN), and enable auth — the stock
> config is localhost-only, so a cross-host worker `401`s until the tokened
> `authInternalUsers` block is enabled and `AUTOMOBILE_WEBRTC_WHIP_TOKEN` is set to
> `<user>:<pass>`. See the CI guide's
> [Prerequisites](../../../webrtc-streaming-ci-worker.md#prerequisites) for both.

Browsers subscribe at the matching WHEP URL `http://mediamtx-host:8889/ci-run-42/whep`
(MediaMTX also serves a built-in reader page at `http://mediamtx-host:8889/ci-run-42`).
Any WHIP/WHEP-compatible SFU (LiveKit, Janus, Cloudflare) works the same way.

**HTTPS.** The stock config is plain HTTP. For a reachable deployment, terminate
TLS on the WebRTC listener with a **publicly-trusted** certificate (e.g. Let's
Encrypt) — AutoMobile's WHIP client (Bun's `fetch`) and browser WHEP clients both
reject an untrusted cert, so a self-signed cert works only if its CA is trusted on
every publisher and viewer host. Enable it in the config —

```bash
# publicly-trusted cert preferred; self-signed shown for a CA-trusted intranet:
openssl genrsa -out server.key 2048
openssl req -new -x509 -sha256 -key server.key -out server.crt -days 3650
```

```yaml
webrtcEncryption: yes
webrtcServerKey: server.key
webrtcServerCert: server.crt
```

then use `https://` for both `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT` and the WHEP URL
(`https://mediamtx-host:8889/ci-run-42/whip` · `…/whep`). The
[example config](https://github.com/kaeawc/auto-mobile/blob/main/examples/mediamtx/mediamtx.yml)
carries these keys commented out.

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
  "id": "1", // optional correlation id
  "action": "start", // "start" | "stop" | "status" | "list" | "await"
  "deviceId": "emulator-5554", // optional; defaults to the sole Android device
  "streamId": "ci-run-42", // optional; generated if omitted
  "leaseId": "lease_...", // returned by start; renew/release this lease
  "whipEndpoint": "https://coord:8080/whip", // optional override of env
  "whipToken": "…", // optional bearer token
  "iceServers": [{ "urls": "stun:stun.l.google.com:19302" }],
  "bitrateKbps": 4000, // optional
  "size": { "width": 720, "height": 1280 }, // optional downscale
  "audio": true, // optional Android audio
}
```

An `await` request only needs the stream identity and phase:

```json
{
  "action": "await",
  "streamId": "ci-run-42",
  "leaseId": "lease_...",
  "readiness": "capture_ready",
  "timeoutMs": 30000
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
    "state": "idle",            // publisher state; use lifecycleState for readiness
    "lifecycleState": "capture_ready",
    "lease": { "id": "lease_...", "expiresAt": "2026-07-24T00:01:00.000Z" },
    "consumerCount": 1,
    "whipEndpoint": "https://coord:8080/whip",
    "resourceUrl": null,        // populated after await(publishing)
    "iceServers": [ … ],
    "framesSent": 0,
    "packetsSent": 0,
    "audioPacketsSent": 0,
    "audioSamplesSent": 0,
    "readiness": {
      "lastEncodedFrameTimestampUs": null,
      "lastIdrTimestampUs": null,
      "idrRequestCount": null,
      "idrCompletionCount": null,
      "encodedAccessUnitCount": null,
      "publisherRtpPacketCount": null,
      "captureSourceState": "not_initialized",
      "lastSourceError": null
    }
  }
}
```

`readiness` separates capture-source, encoder, IDR, and RTP-publication
progress. A `null` counter or timestamp has not been initialized by its
producer; a numeric zero is a measured value. `captureSourceState` is
`not_initialized`, `starting`, `running`, `failed`, or `stopped`, and
`lastSourceError` identifies the latest capture failure when present.

## Configuration

| Environment variable                  | Meaning                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT`     | WHIP ingest URL (required unless passed per request)                                                                                             |
| `AUTOMOBILE_WEBRTC_WHIP_TOKEN`        | Bearer token for the ingest endpoint                                                                                                             |
| `AUTOMOBILE_WEBRTC_ICE_SERVERS`       | Comma-separated STUN/TURN URLs, or a JSON array of `{urls,username,credential}`                                                                  |
| `AUTOMOBILE_WEBRTC_BITRATE_KBPS`      | Target encoder bitrate                                                                                                                           |
| `AUTOMOBILE_WEBRTC_MAX_SIZE`          | Capture downscale, `WIDTHxHEIGHT`                                                                                                                |
| `AUTOMOBILE_WEBRTC_IOS_SIMULATOR_FPS` | iOS Simulator capture rate, integer in `[5, 60]` (default `15`; `iosSimulatorFps` per request)                                                   |
| `AUTOMOBILE_WEBRTC_AUDIO`             | Enable optional audio (`audio: true` per request). Android requires the persistent `video-server` jar; iOS supports Simulator-window audio only. |

Per-request fields override the environment defaults.

## Reconnect model

Two independent reconnection layers:

1. **Publisher → server.** `WebRtcPublisher` watches the peer
   `connectionState`; on `failed`/`disconnected` it tears down and re-publishes
   over WHIP with backoff while retaining the prepared capture source. It asks
   that source for a fresh keyframe after reconnect; only a capture failure
   recreates the source. The WHIP `Location` resource URL is retained so the
   stale session can be `DELETE`d.
2. **Browser → server.** The browser's WHEP client re-subscribes to the same
   MediaMTX WHEP URL when its peer connection drops. MediaMTX replays cached
   SPS/PPS and a keyframe so a late or reconnecting viewer decodes immediately —
   this is server-side and needs no AutoMobile involvement.

## Quality / bitrate

Capture prefers the persistent on-device encoder (`video-server`): a single
long-lived VirtualDisplay + MediaCodec pipeline with no ~175 s rotation seam and
one continuous timestamp base. It honors `--bit-rate` (from `bitrateKbps`) and
`--size` (from `size`).

When the jar is not resolvable — or the persistent encoder fails to start —
capture falls back to `screenrecord`, which encodes on-device H.264 with the same
`--bit-rate`/`--size` controls. Its 180 s `--time-limit` cap is worked around by
segment rotation (`ANDROID_STREAM_SEGMENT_ROTATE_MS`); each new segment emits a
fresh keyframe.

## Persistent-encoder delivery (`automobile-video.jar`)

The `video-server` jar ships as a GitHub release asset, mirroring the CtrlProxy
APK/IPA delivery convention — so the persistent encoder is the production default
rather than falling back to `screenrecord` because the jar wasn't distributed.

**Resolution precedence** (resolved once at stream start, off the per-frame path,
in `webrtcStreamManager`; the capture-source factory stays synchronous):

1. `AUTOMOBILE_VIDEO_SERVER_JAR` — explicit local override (an already-built jar).
2. A valid **cached download** at `~/.auto-mobile/video-server/automobile-video.jar`
   (with a `video-server-jar.json` sidecar recording `{version, sha256, size,
downloadedAt}`).
3. A **fresh download** from the release, sha256-verified against the pinned
   release's `videoJarSha256` in the checksum registry.
4. The local Gradle build output
   (`android/video-server/build/libs/automobile-video.jar`, from
   `./gradlew :video-server:d8Dex`) — for development.
5. else **`null` → `screenrecord`**.

`AUTOMOBILE_VERSION` (pin one coherent version) and `AUTOMOBILE_ASSET_BASE_URL`
(offline mirror host) apply to the jar exactly as they do to the APK/IPA. The jar
is warmed by a **background prefetch at daemon startup**, but only when WebRTC
streaming is configured (`AUTOMOBILE_WEBRTC_WHIP_ENDPOINT` is set) — daemons that
never stream download nothing.

**Fail-modes.** The jar is _optional_ (the encoder already degrades to
`screenrecord`), so unavailability degrades gracefully — but integrity is never
compromised:

| Situation                                                    | Behavior                                                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checksum known + **matches**                                 | use the jar                                                                                                                                                                                 |
| Checksum known + **mismatch**                                | stream start returns `success: false` with a typed `capture_start_failed` screenshot fallback; the corrupted/tampered jar is never accepted                                                 |
| Checksum **absent** (a pin predating jar delivery / unknown) | **degrade** to `screenrecord`                                                                                                                                                               |
| `AUTOMOBILE_REQUIRE_VIDEO_SERVER=1`                          | any degrade case returns the same typed screenshot fallback instead of starting a stream — for CI that must not silently fall back                                                          |
| `AUTOMOBILE_SKIP_VIDEO_SERVER_DOWNLOAD=1`                    | **local-only** (override / Gradle build); the network is never touched. A dedicated flag — it does **not** overload `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD`, whose CtrlProxy APK is mandatory |

See [Environment variables](../../../using/environment-variables.md) for the full
flag reference.

## Optional audio

Audio is opt-in (`AUTOMOBILE_WEBRTC_AUDIO=1` or `"audio": true`). The publisher
adds a sendonly PCMU audio track. Android `video-server` captures 8 kHz mono PCM16
from `REMOTE_SUBMIX`, while iOS Simulator-window capture uses ScreenCaptureKit;
the TypeScript publisher converts the PCM to PCMU RTP. Because `screenrecord` is
video-only, Android audio-enabled streams require the persistent
`automobile-video.jar` path. If its jar is unavailable or `REMOTE_SUBMIX` cannot
initialize on the device build, stream start fails instead of silently publishing
video-only audio. Physical iOS playback capture is unavailable through public APIs.

Android playback capture is policy-limited: some apps/usages cannot be captured,
and `REMOTE_SUBMIX` is privileged. MediaMTX forwards both the H.264 and PCMU
tracks to WHEP subscribers.

## Known limitations / future work

- **Platform capture differs.** Android capture prefers the persistent
  `video-server` jar and falls back to `screenrecord`; iOS capture uses the
  CtrlProxy helper and local `ffmpeg` H.264 encoding. Keep both helper binaries
  available on workers that may stream either platform.
- ~~**Persistent-encoder distribution.**~~ _Resolved:_ the `video-server` jar now
  ships as a checksum-verified GitHub release asset and is downloaded/cached on
  demand, so production installs use the persistent encoder by default. See
  [Persistent-encoder delivery](#persistent-encoder-delivery-automobile-videojar)
  above.
- **Audio is opt-in and platform-constrained.** iOS audio requires Simulator-window
  capture; physical devices remain video-only. Android audio depends on
  `REMOTE_SUBMIX` availability for the shell-owned `video-server` process.
- **Trickle ICE is opt-in.** By default the publisher gathers candidates before
  POSTing the WHIP offer (non-trickle), which is simplest and widely compatible.
  Set `AUTOMOBILE_WEBRTC_TRICKLE_ICE=1` (or `trickleIce: true`) to publish the
  offer immediately and PATCH candidates incrementally
  (`application/trickle-ice-sdpfrag`) so setup doesn't stall on the gathering
  timeout — requires an ingest server that supports the WHIP trickle extension
  (see `trickleIce.ts` / `WhipClient.patchCandidate` for the publisher side).

## References

- [WebRTC standards map](./webrtc-standards-map.md) — W3C, IETF, and ITU references mapped to AutoMobile behavior
- [WHIP — RFC 9725](https://www.rfc-editor.org/rfc/rfc9725.html)
- [WHEP — Internet-Draft](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep)
- [werift-webrtc](https://github.com/shinyoshiaki/werift-webrtc)
- [CI worker setup guide](../../../webrtc-streaming-ci-worker.md)
- [MediaMTX example config](../../../../examples/mediamtx/README.md)
- [Desktop live mirroring (Unix socket + FFmpeg decode)](./screen-streaming.md)
