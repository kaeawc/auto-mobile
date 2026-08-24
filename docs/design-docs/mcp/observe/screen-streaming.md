# Real-Time Screen Streaming Architecture

<kbd>⚠️ Partial</kbd>

> **Note:** This document covers the **live IDE screen mirroring** feature (continuous streaming to the Android Studio plugin). This is distinct from the `videoRecording` MCP tool (which records a clip to a file) — that tool is <kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>.
>
> The Android `video-server` JAR (H.264, VirtualDisplay) is fully built and used by `videoRecording`. The end-to-end live mirroring pipeline (MCP relay → IDE DeviceScreenView) is in progress.
> iOS live streaming is <kbd>🚧 Design Only</kbd> — see [iOS Screen Streaming](../../plat/ios/screen-streaming.md).
>
> See the [Status Glossary](../../status-glossary.md) for chip definitions.

Real-time screen streaming from mobile devices to the IDE plugin, enabling interactive device mirroring at up to 60fps with <100ms latency.
Interactive screen control should send tap, swipe, text, and button input through
the [daemon input API](../daemon/unix-socket-api.md#input-api) rather than
constructing MCP tool payloads directly.

## Goals

- Continuous live streaming for device mirroring in the IDE
- Up to 60fps frame rate
- <100ms end-to-end latency for interactive use
- Support USB-connected physical devices and emulators/simulators
- Include audio streaming for complete mirroring
- Integrate with existing observation architecture
- Concurrent per-device streams: one shared capture per device, fanned out to multiple
  subscribers, so the desktop workspace can mirror many device panes at once

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Mobile Device                                                        │
│                                                                      │
│  Platform-specific capture mechanism                                 │
│  (see platform docs for details)                                     │
│                                                                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ MCP Server (Node.js)                                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Existing sockets:                    New socket:                    │
│  ├─ auto-mobile.sock (MCP proxy)      └─ video-stream.sock          │
│  ├─ observation-stream.sock              (binary frame data)        │
│  └─ performance-push.sock                                           │
│                                                                      │
│  VideoStreamManager                                                  │
│  ├─ Platform detection                                               │
│  ├─ Capture process lifecycle                                        │
│  ├─ Frame forwarding to clients                                      │
│  └─ Fallback to screenshot mode                                      │
│                                                                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ IDE Plugin (Kotlin/JVM)                                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  VideoStreamClient                                                   │
│  ├─ Unix socket connection to video-stream.sock                      │
│  ├─ Platform-specific frame decoding                                 │
│  └─ Frame → ImageBitmap conversion                                   │
│                                                                      │
│  DeviceScreenView (Compose Desktop)                                  │
│  ├─ Live frame display                                               │
│  ├─ Overlay support (hierarchy highlights, selection)                │
│  ├─ FPS indicator                                                    │
│  └─ Fallback to static screenshots                                   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Platform-Specific Capture

The capture mechanism differs significantly between platforms:

| Platform | Capture Location | Frame Format  | Decoder Needed        |
| -------- | ---------------- | ------------- | --------------------- |
| Android  | On device        | H.264 encoded | Yes (bytedeco FFmpeg) |
| iOS      | On Mac           | Raw BGRA      | No                    |

See platform-specific documentation for implementation details:

- **[Android Screen Streaming](../../plat/android/screen-streaming.md)** - VirtualDisplay + MediaCodec via shell-user JAR
- **[iOS Screen Streaming](../../plat/ios/screen-streaming.md)** - AVFoundation + ScreenCaptureKit on macOS

## Video Stream Socket Protocol

New Unix socket: `~/.auto-mobile/video-stream.sock`

### Connection Handshake

One JSON line each way; everything after the acknowledgement is binary framing.

```text
Client → Server: { "action": "subscribe", "id": "<uuid>", "sessionUuid": "<daemon session>",
                   "deviceId": "<optional>", "quality": "low|medium|high", "fps": 30,
                   "bitrateKbps": 2000, "size": { "width": 720, "height": 1280 } }
Server → Client: { "type": "video_stream_response", "success": true, "action": "subscribe",
                   "deviceId": "...", "framing": "h264" }
```

All hint fields are optional and validated server-side (an unknown `quality`, an `fps` outside
the capture backends' shared 5–60 range, or a non-positive/oversized `bitrateKbps` refuses the
subscribe). Captures are shared per device: the first subscriber's hints fix the encode and a
late joiner's differing hints are ignored. `quality` selects the on-device preset
(low=540p/2Mbps, medium=720p/4Mbps, high=1080p/8Mbps); on iOS only the preset's bitrate applies
(resolution self-scales to Level 4.2). `fps` is honored by the Android persistent encoder
(`--fps`) and the iOS Simulator (`--simulator-fps`) — farm clients should send it on both — but
**not** by the Android `screenrecord` fallback (native display rate) or physical iOS (its own
AVFoundation rate). `sessionUuid` authenticates against the daemon session registry (#4751); when
auth is on (the default) a subscribe without a live session is refused. The desktop workspace
client authenticates by binding a `DesktopDaemonSession` to its focused device (#4977) and passing
that session UUID to every pane, so it works against a default (auth-on) daemon;
`AUTOMOBILE_DAEMON_STREAM_AUTH=0` remains only an operator fallback for setups whose clients cannot
supply a session.

### Frame Data

The **relay wire is always H.264** (`framing: "h264"`) regardless of platform — a subscriber
parses the same framing for Android and iOS. iOS captures raw BGRA internally and the daemon
re-encodes it to H.264 before it reaches the relay, so relay clients never see raw frames:

**Relay wire (both platforms, H.264):**

```
┌─────────────────┬─────────────────┬─────────────────┐
│ codec_id (4)    │ width (4)       │ height (4)      │
└─────────────────┴─────────────────┴─────────────────┘
Then per-packet: pts_flags (8) + size (4) + H.264 data
```

**Internal only — iOS capture-helper → daemon (raw BGRA, NOT the relay wire):**

```
┌──────────┬─────────────┬──────────┬───────────┬─────────────┬───────────┐
│ magic(4) │ checksum(4) │ width(4) │ height(4) │ bytesPerRow │ timestamp │
└──────────┴─────────────┴──────────┴───────────┴─────────────┴───────────┘
Then: height * bytesPerRow bytes of BGRA pixel data
```

`magic` ("AMF1") + CRC-32 `checksum` over the field bytes make frame boundaries
self-describing, so corruption recovery is deterministic (issue #4270). This format is consumed
by the daemon's iOS H.264 encoder and is never sent to relay subscribers.

### Stream Control

There is no mid-stream control channel: quality is fixed at subscribe time (first subscriber
wins for a shared capture) and a client stops by closing its connection. The capture stops
when the last subscriber for a device disconnects.

## Quality Presets

| Quality | Android Bitrate | Resolution | Preset FPS |
| ------- | --------------- | ---------- | ---------- |
| Low     | 2 Mbps          | 540p       | 30         |
| Medium  | 4 Mbps          | 720p       | 30         |
| High    | 8 Mbps          | 1080p      | 30         |

The preset FPS is the on-device encoder default (`QualityPreset` — 30fps for every preset, since UI
automation is mostly static frames and 30fps roughly halves encode load versus 60 for no observable
benefit). The host may still override it per subscribe with `fps` in the 5–60 range; the desktop
mirror requests 30fps for the focused/controlled pane and 10fps for display-only farm mirrors,
independent of preset.

iOS streams raw frames, so quality is controlled by resolution scaling only.

## Fallback Behavior

When video streaming is unavailable:

1. Detect stream failure or unsupported device
2. Automatically switch to existing screenshot-based observation
3. Display indicator in UI showing "Screenshot mode"
4. Retry video streaming on user request or device reconnection

## Decisions

| Question                | Decision                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audio streaming         | Include audio for complete mirroring                                                                                                                                                                                                                                                                                                                                                                                        |
| Touch input             | Plan for it, implement later                                                                                                                                                                                                                                                                                                                                                                                                |
| Quality auto-adjustment | Client-side on the desktop mirror: a per-pane controller measures the decoded frame rate and steps the preset down on a sustained drop / back up once healthy, applied by re-subscribing. Because a shared per-device capture's encode is fixed by the first subscriber (see Stream Control), this takes effect for a sole subscriber / the next subscribe; reconfiguring a live shared capture is a server-side follow-up. |
| Multiple devices        | Concurrent per-device streams — one shared capture per device, fanned out to its subscribers, so the desktop workspace mirrors many device panes at once                                                                                                                                                                                                                                                                    |
| Android decoder         | `org.bytedeco:ffmpeg` (in-process JNI), host-platform classifier only. Klarity was the original choice but cannot consume a live stream — its API takes file paths only. No FFmpeg _subprocess_ fallback.                                                                                                                                                                                                                   |
| iOS Swift integration   | Swift-to-Node bridge                                                                                                                                                                                                                                                                                                                                                                                                        |
| macOS permissions       | User handles permission prompts                                                                                                                                                                                                                                                                                                                                                                                             |
| macOS entitlements      | No special entitlements needed for iOS capture                                                                                                                                                                                                                                                                                                                                                                              |

## Related: browser/CI streaming over WebRTC

This document covers **desktop** live mirroring over a Unix socket
(`video-stream.sock`) with an in-process FFmpeg decoder. For pushing a device stream to a **browser** or a **CI dashboard** over
standard WebRTC (WHIP ingest → WHEP egress), see
[WebRTC Screen Streaming (WHIP egress)](./webrtc-streaming.md). Both paths reuse
the same on-device H.264 capture; only the transport and consumer differ.

## References

- [WebRTC Screen Streaming (WHIP egress)](./webrtc-streaming.md)
- [Android Screen Streaming](../../plat/android/screen-streaming.md)
- [iOS Screen Streaming](../../plat/ios/screen-streaming.md)
- [Video Recording Design](./video-recording.md)
