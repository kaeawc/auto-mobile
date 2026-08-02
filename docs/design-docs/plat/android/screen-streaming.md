# Real-Time Screen Streaming Architecture

<kbd>⚠️ Partial</kbd>

> **Current state:** The Android `video-server` module (`android/video-server/`) is fully implemented — `VideoServer.kt` captures via VirtualDisplay, encodes H.264 with MediaCodec, and streams over a LocalSocket. The `videoRecording` MCP tool (record-to-file) uses this server and is <kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>.
>
> The **live screen mirroring** pipeline (daemon `video-stream.sock` relay → desktop) is wired end-to-end: the video-server JAR, the daemon relay (#3994), the desktop decoder and stream client (#4008), and the desktop workspace's per-device stream panes (`DeviceStreamView`, #4957) which subscribe with the `low` quality preset for farm-scale viewing. Subscribe-time `quality`/`fps`/`bitrateKbps` hints select the capture preset; captures are shared per device with first-subscriber-wins semantics.
>
> Note the decoder is **bytedeco FFmpeg**, not Klarity as originally designed; see [Video Decoder](#video-decoder-bytedeco-ffmpeg) for why.
>
> See the [Status Glossary](../../status-glossary.md) for chip definitions.

Research and design for real-time screen streaming from Android devices to the IDE plugin, enabling interactive device mirroring at up to 60fps with <100ms latency.

See [Screen Streaming Overview](../../mcp/observe/screen-streaming.md) for the cross-platform architecture, video stream socket protocol, and quality presets.

## Goals

- Continuous live streaming for device mirroring in the IDE
- Up to 60fps frame rate
- <100ms end-to-end latency for interactive use
- Integrate with existing WebSocket-based architecture
- Support USB-connected physical devices and emulators

## Why a Separate Video Server?

The accessibility service **cannot** use VirtualDisplay for screen capture. A separate JAR running as shell user is required.

scrcpy achieves permission-less screen capture by running via `adb shell app_process` as **shell user (UID 2000)**, impersonating `com.android.shell`, and accessing hidden `DisplayManagerGlobal.createVirtualDisplay(displayIdToMirror)` via reflection. These privileges are not available to the accessibility service.

| Capability | Accessibility Service | Shell User (adb) |
|------------|----------------------|------------------|
| Hidden `DisplayManagerGlobal` APIs | No | Yes |
| `SurfaceControl.createDisplay()` | No | Yes |
| Screen capture without dialog | No | Yes |
| Impersonate `com.android.shell` | No | Yes |

The accessibility service can only do on-demand `takeScreenshot()` or request `MediaProjection` (which requires a user permission dialog **each session** and foreground service on Android 14+).

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Android Device                                                      │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Accessibility Service              Video Server JAR                │
│  (normal app process)               (shell user via adb)            │
│                                                                     │
│  ├─ View hierarchy extraction       ├─ VirtualDisplay capture      │
│  ├─ Gesture injection               ├─ MediaCodec H.264 encoding   │
│  ├─ Text input                      └─ LocalSocket streaming       │
│  └─ WebSocket server (:8765)                                       │
│                                                                     │
│  UID: app-specific                  UID: 2000 (shell)               │
│  Started by: Android system         Started by: adb shell           │
│  Permissions: Accessibility         Permissions: Shell (system)     │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

**Key Components:**

1. **Video Streaming Server** (new Android component)
   - Separate process running via `adb shell` (like scrcpy-server)
   - Small JAR pushed to `/data/local/tmp/automobile-video.jar`
   - Uses SurfaceControl/VirtualDisplay for capture (no permission dialog)
   - MediaCodec H.264 encoder
   - Writes to LocalSocket

2. **Video Stream Proxy** (new MCP server component)
   - Connects to video LocalSocket via ADB forward
   - Streams binary data to new Unix socket
   - Handles reconnection and device switching

3. **Video Stream Client** (desktop component, `core/video/`)
   - `org.bytedeco:ffmpeg` for H.264 decoding (FFmpeg via JNI)
   - Decodes frames to tightly packed BGRA
   - Copied into a Skia raster image and drawn by Compose (no SwingPanel needed)

## On-device JAR integrity + push-skip

The persistent encoder is a DEX jar executed via `app_process` as the shell user
([#4733](https://github.com/kaeawc/auto-mobile/issues/4733)). Two properties are
enforced around that push/launch, both driven by a single on-device hash:

- **Integrity before launch (defense-in-depth / TOCTOU).** Because the jar runs
  in the screen/audio-capture context, anything able to write
  `/data/local/tmp/automobile-video.jar` could substitute code. Before
  `app_process` is spawned, the host hashes the remote jar
  (`sha256sum` + `wc -c`, through the injectable ADB seam, bounded by the
  launch-command timeout) and compares it against the host-known expected sha256
  and byte size. On a **definitive mismatch** the launch is refused with an
  `ActionableError` and the source degrades to `screenrecord`; an *unreadable*
  probe (a device lacking `sha256sum`/`wc`, or a probe timeout) is not a mismatch
  — the push already overwrote the remote with trusted bytes, so it logs and
  proceeds (mirrors the handshake graceful-degrade).

- **Skip the redundant push (startup latency).** The same probe runs once *before*
  the push: when the remote copy is already byte-identical (size **and** hash),
  the ~2.5 MB `adb push` is skipped and that match doubles as the pre-launch gate
  (the happy path hashes the remote once). Any mismatch **or** uncertainty
  (unreadable/absent remote) pushes — correctness is never traded for the
  optimization.

The expected sha256/size come from `VideoServerJarProvider.computeLocalJarIntegrity()`,
which hashes the actual local bytes the host would push (the same canonical
`ChecksumCalculator` used to verify downloads). This is correct for every
resolution source — cached download, `AUTOMOBILE_VIDEO_SERVER_JAR` override, and
local Gradle build — because it never trusts the release registry for jars that
were never checked against it. The value is memoized across relaunches.

## Protocol Specification

### Video Stream Header (12 bytes)
```
┌─────────────────┬─────────────────┬─────────────────┐
│ codec_id (4)    │ width (4)       │ height (4)      │
│ big-endian      │ big-endian      │ big-endian      │
└─────────────────┴─────────────────┴─────────────────┘

codec_id values:
  0x68323634 = "h264" (H.264/AVC)
  0x68323635 = "h265" (H.265/HEVC)
```

### Packet Header (12 bytes per packet)
```
┌─────────────────────────────────────┬─────────────────┐
│ pts_and_flags (8)                   │ size (4)        │
│ big-endian                          │ big-endian      │
└─────────────────────────────────────┴─────────────────┘

pts_and_flags bit layout:
  bit 63: PACKET_FLAG_CONFIG (codec config data, not a frame)
  bit 62: PACKET_FLAG_KEY_FRAME (I-frame)
  bits 0-61: presentation timestamp in microseconds

Followed by `size` bytes of encoded frame data.
```

## MediaCodec Configuration

Recommended encoder settings for low-latency streaming:

```kotlin
val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
    // Bitrate: 8 Mbps default, adjustable
    setInteger(KEY_BIT_RATE, 8_000_000)

    // Frame rate hint (actual rate is variable)
    setInteger(KEY_FRAME_RATE, 60)

    // I-frame interval: 10 seconds (frequent enough for seeking)
    setInteger(KEY_I_FRAME_INTERVAL, 10)

    // Surface input (zero-copy from GPU)
    setInteger(KEY_COLOR_FORMAT, CodecCapabilities.COLOR_FormatSurface)

    // Repeat frame after 100ms of no changes (reduces idle bandwidth)
    setLong(KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000)

    // Optional: request low latency mode (Android 11+)
    if (Build.VERSION.SDK_INT >= 30) {
        setInteger(KEY_LOW_LATENCY, 1)
    }

    // H.264 Baseline profile for maximum compatibility
    setInteger(KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
    setInteger(KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel31)

    // CBR for consistent bitrate
    setInteger(KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
}
```

## Bandwidth and Quality Tradeoffs

| Quality | Resolution | Bitrate | Bandwidth | Notes |
|---------|------------|---------|-----------|-------|
| Low | 540p | 2 Mbps | ~2.5 MB/s | Good for slow USB |
| Medium | 720p | 4 Mbps | ~5 MB/s | Balanced |
| High | 1080p | 8 Mbps | ~10 MB/s | Full HD |
| Ultra | Native | 16 Mbps | ~20 MB/s | 4K devices |

USB 2.0: ~30 MB/s theoretical, ~20 MB/s practical - all quality levels supported.

## Video Decoder: bytedeco FFmpeg

We use [`org.bytedeco:ffmpeg`](https://github.com/bytedeco/javacpp-presets/tree/master/ffmpeg) for H.264 decoding on the desktop (`H264Decoder`, issue #3995).

Depend on `org.bytedeco:ffmpeg` with the **host platform's classifier**, resolved at build time:

- **not** `ffmpeg-platform`, which pulls every platform's natives (~150–200 MB)
- **not** `javacv-platform`, which drags in OpenCV
- **not** the `-gpl` artifact — only the x264/x265 *encoders* require it, and we decode, so the LGPL build is correct

That keeps the installer growth to ~20–30 MB per platform. The decoder reads a raw Annex-B elementary stream from memory (an `AVCodecParserContext` reassembles access units, so callers may feed arbitrary chunk boundaries) and yields tightly packed BGRA that copies straight into a Skia raster image — no AWT/Swing surface involved.

### Why not Klarity

[Klarity](https://github.com/numq/Klarity) was the original choice on the strength of its zero-copy Skia rendering. It cannot be used here: **its API accepts file paths only**, with no way to feed a live stream, which is disqualifying regardless of anything else. Secondarily, it is not published to Maven Central — JitPack builds it, but that artifact is API classes with no native libraries, so the per-platform natives from GitHub releases would still need hand-managing.

## Implementation Plan

### Milestone 1: Proof of Concept
- [ ] Create automobile-video-server JAR with basic VirtualDisplay + MediaCodec
- [ ] Test manual execution via `adb shell`
- [ ] Verify H.264 stream output with ffplay

### Milestone 2: MCP Integration ✅ (#3994)
- [x] Add video stream socket server to daemon (`video-stream.sock`)
- [x] Implement ADB forward management (reuses the existing H.264 capture sources)
- [x] Add start/stop video streaming commands (JSON subscribe handshake, then binary framing)

### Milestone 3: Desktop Decoder ✅ (#4008)
- [x] Add decoder dependency (`org.bytedeco:ffmpeg`, host-platform classifier)
- [x] Implement VideoStreamClient
- [x] Create frame-to-ImageBitmap pipeline (`DecodedFrame.toImageBitmap()`)
- [ ] Benchmark decode performance — not yet measured against a real device

### Milestone 4: Compose Integration (#3995)
- [x] `DeviceScreenView` accepts an optional `liveFrame` that renders instead of the polled screenshot
- [ ] Supply that frame: `LayoutInspectorDashboard` must construct a client and collect its frames
- [ ] Choose live vs screenshot at runtime and fall back on `VideoStreamState.Unavailable`
- [ ] Frame-rate policy — the existing screenshot flow is `replay = 1` with no conflation and will not survive 60fps
- [ ] Add FPS counter overlay
- [ ] Implement latency measurement
- [ ] Add quality/resolution controls

### Milestone 5: Polish
- [ ] Handle device disconnect/reconnect
- [ ] Add fallback to screenshot mode
- [ ] Automatic quality adjustment on frame drops
- [ ] Optimize memory (double buffering, frame pooling)

## References

### Android Screen Capture
- [scrcpy source code](https://github.com/Genymobile/scrcpy) - Reference implementation
- [Android MediaCodec docs](https://developer.android.com/reference/android/media/MediaCodec)
- [Android VirtualDisplay](https://developer.android.com/reference/android/hardware/display/VirtualDisplay)
- [Low-latency decoding in MediaCodec](https://source.android.com/docs/core/media/low-latency-media)
- [Android 14 MediaProjection requirements](https://developer.android.com/about/versions/14/changes/fgs-types-required)

### Video Decoding (Desktop)
- [bytedeco javacpp-presets: ffmpeg](https://github.com/bytedeco/javacpp-presets/tree/master/ffmpeg) - chosen solution
- [Klarity](https://github.com/numq/Klarity) - evaluated and rejected; file-path-only API cannot consume a live stream
- [JetBrains Skiko](https://github.com/JetBrains/skiko) - Skia bindings for Kotlin
